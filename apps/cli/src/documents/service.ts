import { randomUUID } from 'node:crypto';
import { basename, resolve, sep } from 'node:path';

import {
  buildLineIndex,
  byteRangeOfLines,
  extractTitle,
  HTML_STATIC_PARSER_PROFILE,
  lineOfByte,
  MARKDOWN_PARSER_PROFILE,
  truncateAtCodePoint,
} from '@vde-open/document';
import {
  closeParamsSchema,
  LIMITS,
  listParamsSchema,
  openParamsSchema,
  readParamsSchema,
  VdeError,
  type CloseResult,
  type DocumentFormat,
  type DocumentSummary,
  type ListResult,
  type OpenResult,
  type ReadResult,
  type Warning,
} from '@vde-open/shared';

import type { DocumentRecord, RevisionRecord, StatePayload } from '../persistence/state-schema.ts';
import type { StateStore } from '../persistence/state-store.ts';
import type { CursorCodec } from './cursor.ts';
import { expandTargets, formatOfPath } from './enumerate.ts';
import { computeRevision } from './revision.ts';
import { canonicalizePath, decodeSource, readSourceFile } from './source-reader.ts';

export interface ServiceResult<T> {
  data: T;
  catalogVersion: number;
  warnings: Warning[];
}

interface Incoming {
  sourceKind: 'file' | 'stdin';
  canonicalPath: string | null;
  displayPath: string | null;
  pathSegments: string[];
  format: DocumentFormat;
  bytes: Buffer;
  text: string;
  fallbackTitle: string;
}

interface Problem {
  path: string;
  code: string;
  reason: string;
}

function profileOf(format: DocumentFormat): string {
  return format === 'markdown' ? MARKDOWN_PARSER_PROFILE : HTML_STATIC_PARSER_PROFILE;
}

function toSummary(record: DocumentRecord, order: number): DocumentSummary {
  return {
    documentId: record.documentId,
    key: record.key,
    format: record.format,
    sourceKind: record.sourceKind,
    title: record.title,
    displayPath: record.displayPath,
    pathSegments: record.pathSegments,
    revision: record.currentRevision,
    sourceState: record.sourceState,
    // 検索indexはP4で実装する。それまでは検索対象に入らない。
    searchState: 'excluded',
    openedAt: record.openedAt,
    updatedAt: record.updatedAt,
    order,
    pendingRequestIds: [],
  };
}

// 直近2版と、5分以内に作られた版を残す（仕様4.4）。
function pruneRevisions(revisions: RevisionRecord[], now: number): RevisionRecord[] {
  return revisions.filter((entry, index) => {
    const isRecent = index >= revisions.length - LIMITS.retainedRevisions;
    return isRecent || now - Date.parse(entry.createdAt) < LIMITS.revisionGraceMs;
  });
}

function openSourceBytes(state: StatePayload): number {
  let total = 0;
  for (const documentId of state.openOrder) {
    const record = state.documents[documentId];
    const current = record?.revisions.find((entry) => entry.revision === record.currentRevision);
    total += current?.byteLength ?? 0;
  }
  return total;
}

export class DocumentService {
  readonly #store: StateStore;
  readonly #cursors: CursorCodec;
  readonly #now: () => Date;

  constructor(store: StateStore, cursors: CursorCodec, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#cursors = cursors;
    this.#now = now;
  }

  // 全候補を先に検査し、1件でも問題があれば何も登録しない（仕様5.2）。
  async open(rawParams: unknown): Promise<ServiceResult<OpenResult>> {
    const params = openParamsSchema.parse(rawParams);
    const warnings: Warning[] = [];
    const incoming: Incoming[] = [];

    if (params.stdin) {
      if (params.paths.length > 0) {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinとpathは同時に指定できません。');
      }
      if (params.format === 'auto') {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinから開くときは--formatが必要です。');
      }
      const bytes = Buffer.from(params.stdin.content, 'utf8');
      incoming.push({
        sourceKind: 'stdin',
        canonicalPath: null,
        displayPath: null,
        pathSegments: [],
        format: params.format,
        bytes,
        text: decodeSource(bytes, 'stdin'),
        fallbackTitle: params.key ?? 'stdin',
      });
    } else {
      if (params.paths.length === 0) {
        throw new VdeError('E_INVALID_ARGUMENT', '開く文書を指定してください。');
      }
      const expansion = await expandTargets(params.cwd, params.paths, params.recursive);
      for (const target of expansion.emptyTargets) {
        warnings.push({
          code: 'W_NO_DOCUMENTS',
          message: `${target} に対象の文書がありません。`,
          details: { path: target },
        });
      }
      // 形式の検査は、指定された候補のすべてに対して行う。重複として除かれる指定も例外にしない。
      // 文書数の計算と本文の読み込みは、canonical pathで重複を除いてから行う。
      // symlink経由や重複指定は、同じcanonical fileの1件として数える。
      const explicitFormat = params.format === 'auto' ? null : params.format;
      const problems: Problem[] = [];
      const unique = new Map<
        string,
        { candidate: (typeof expansion.candidates)[number]; format: DocumentFormat }
      >();
      for (const candidate of expansion.candidates) {
        const format = candidate.explicit
          ? (explicitFormat ?? formatOfPath(candidate.absolutePath))
          : formatOfPath(candidate.absolutePath);
        if (!format) {
          problems.push({
            path: candidate.displayPath,
            code: 'E_UNSUPPORTED_FORMAT',
            reason: 'unknown-extension',
          });
          continue;
        }
        const canonicalPath = await canonicalizePath(candidate.absolutePath);
        const first = unique.get(canonicalPath);
        // 同じfileが直接の指定と列挙の両方に含まれるときは、直接の指定を優先する。
        if (!first || (candidate.explicit && !first.candidate.explicit)) {
          unique.set(canonicalPath, { candidate, format });
        }
      }
      if (unique.size > LIMITS.openDocuments) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
          limit: 'openDocuments',
          max: LIMITS.openDocuments,
          actual: unique.size,
        });
      }
      // 合計の大きさは読み込みながら確かめる。上限を超える量をmemoryへ載せない。
      let loadedBytes = 0;
      const seen = new Set<string>();
      for (const { candidate, format } of unique.values()) {
        try {
          const loaded = await readSourceFile(candidate.absolutePath);
          // symlink経由や重複指定は、同じcanonical fileの1件として扱う。
          if (seen.has(loaded.canonicalPath)) continue;
          seen.add(loaded.canonicalPath);
          loadedBytes += loaded.bytes.byteLength;
          if (loadedBytes > LIMITS.openSourceBytes) {
            throw new VdeError(
              'E_LIMIT_EXCEEDED',
              '開いている文書の合計の大きさが上限を超えます。',
              { limit: 'openSourceBytes', max: LIMITS.openSourceBytes },
              { cause: 'batch' },
            );
          }
          incoming.push({
            sourceKind: 'file',
            canonicalPath: loaded.canonicalPath,
            displayPath: candidate.displayPath,
            pathSegments: loaded.canonicalPath.split(sep).filter((segment) => segment !== ''),
            format,
            bytes: loaded.bytes,
            text: loaded.text,
            fallbackTitle: basename(loaded.canonicalPath),
          });
        } catch (error) {
          if (!(error instanceof VdeError)) throw error;
          // batch全体の上限超過は、個別の問題として集めずに打ち切る。
          if (error.cause === 'batch') throw error;
          problems.push({
            path: candidate.displayPath,
            code: error.code,
            reason: String(error.details['reason'] ?? error.details['limit'] ?? 'unreadable'),
          });
        }
      }
      if (problems.length > 0) {
        const first = problems[0] as Problem;
        throw new VdeError(
          first.code as VdeError['code'],
          `${String(problems.length)}件の文書を開けないため、どの文書も登録していません。`,
          { problems },
        );
      }
      if (incoming.length === 0) {
        throw new VdeError('E_PATH_NOT_FOUND', '対象の文書がありません。', {
          paths: params.paths,
        });
      }
    }

    if ((params.title !== undefined || params.key !== undefined) && incoming.length !== 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        '--titleと--keyは、文書を1件だけ開くときに指定できます。',
        { documents: incoming.length },
      );
    }

    return this.#store.transaction((tx) => {
      const state = tx.state;
      const now = this.#now();
      const timestamp = now.toISOString();
      const touched: string[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (const item of incoming) {
        const existing = this.#findExisting(state, item, params.key);
        if (params.key !== undefined) {
          const holder = Object.values(state.documents).find((r) => r.key === params.key);
          if (holder && holder.documentId !== existing?.documentId) {
            throw new VdeError('E_KEY_CONFLICT', 'そのkeyは別の文書が使っています。', {
              key: params.key,
              documentId: holder.documentId,
            });
          }
        }

        const sourceSha256 = tx.putBlob(item.bytes);
        const revision = computeRevision({
          format: item.format,
          sourceSha256,
          parserProfileVersion: profileOf(item.format),
          assets: [],
        });
        const title = params.title ?? extractTitle(item.text, item.format) ?? item.fallbackTitle;

        if (!existing) {
          const documentId = `doc_${randomUUID()}`;
          state.documents[documentId] = {
            documentId,
            sourceKind: item.sourceKind,
            canonicalPath: item.canonicalPath,
            key: params.key ?? null,
            format: item.format,
            title,
            titleExplicit: params.title !== undefined,
            displayPath: item.displayPath,
            pathSegments: item.pathSegments,
            isOpen: true,
            openedAt: timestamp,
            updatedAt: timestamp,
            sourceState: 'ready',
            currentRevision: revision,
            revisions: [
              {
                revision,
                sourceSha256,
                byteLength: item.bytes.byteLength,
                parserProfileVersion: profileOf(item.format),
                createdAt: timestamp,
              },
            ],
          };
          state.openOrder.push(documentId);
          touched.push(documentId);
          created += 1;
          continue;
        }

        let changed = false;
        if (!existing.isOpen) {
          existing.isOpen = true;
          existing.openedAt = timestamp;
          state.openOrder.push(existing.documentId);
          changed = true;
        }
        if (existing.currentRevision !== revision) {
          const kept = existing.revisions.filter((entry) => entry.revision !== revision);
          kept.push({
            revision,
            sourceSha256,
            byteLength: item.bytes.byteLength,
            parserProfileVersion: profileOf(item.format),
            createdAt: timestamp,
          });
          existing.revisions = pruneRevisions(kept, now.getTime());
          existing.currentRevision = revision;
          existing.format = item.format;
          existing.sourceState = 'ready';
          changed = true;
        }
        if (params.title !== undefined) {
          changed ||= existing.title !== title || !existing.titleExplicit;
          existing.title = title;
          existing.titleExplicit = true;
        } else if (!existing.titleExplicit && existing.title !== title) {
          existing.title = title;
          changed = true;
        }
        if (params.key !== undefined && existing.key !== params.key) {
          existing.key = params.key;
          changed = true;
        }
        if (item.displayPath !== null && existing.displayPath !== item.displayPath) {
          existing.displayPath = item.displayPath;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = timestamp;
          updated += 1;
        } else {
          unchanged += 1;
        }
        touched.push(existing.documentId);
      }

      if (state.openOrder.length > LIMITS.openDocuments) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
          limit: 'openDocuments',
          max: LIMITS.openDocuments,
          actual: state.openOrder.length,
        });
      }
      const sourceBytes = openSourceBytes(state);
      if (sourceBytes > LIMITS.openSourceBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
          limit: 'openSourceBytes',
          max: LIMITS.openSourceBytes,
          actual: sourceBytes,
        });
      }
      if (created + updated > 0) state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;

      return {
        data: {
          documents: touched.map((documentId) =>
            toSummary(
              state.documents[documentId] as DocumentRecord,
              state.openOrder.indexOf(documentId),
            ),
          ),
          created,
          updated,
          unchanged,
        },
        catalogVersion: state.catalogVersion,
        warnings,
      };
    });
  }

  #findExisting(
    state: StatePayload,
    item: Incoming,
    key: string | undefined,
  ): DocumentRecord | undefined {
    if (item.sourceKind === 'file') {
      return Object.values(state.documents).find(
        (record) => record.sourceKind === 'file' && record.canonicalPath === item.canonicalPath,
      );
    }
    // keyのないstdinは、呼び出しごとに新しい文書になる。
    if (key === undefined) return undefined;
    return Object.values(state.documents).find(
      (record) => record.sourceKind !== 'file' && record.key === key,
    );
  }

  list(rawParams: unknown): ServiceResult<ListResult> {
    const params = listParamsSchema.parse(rawParams);
    const state = this.#store.payload;
    let offset = 0;
    if (params.cursor !== undefined) {
      const payload = this.#cursors.decode(params.cursor, 'list');
      if (payload['catalogVersion'] !== state.catalogVersion) {
        throw new VdeError('E_CURSOR_STALE', '一覧が変わりました。最初から取得し直してください。', {
          catalogVersion: state.catalogVersion,
        });
      }
      offset = payload['offset'] as number;
    }
    const page = state.openOrder.slice(offset, offset + params.limit);
    const next = offset + page.length;
    return {
      data: {
        documents: page.map((documentId, index) =>
          toSummary(state.documents[documentId] as DocumentRecord, offset + index),
        ),
        totalDocuments: state.openOrder.length,
        nextCursor:
          next < state.openOrder.length
            ? this.#cursors.encode({
                op: 'list',
                offset: next,
                catalogVersion: state.catalogVersion,
              })
            : null,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  async read(rawParams: unknown): Promise<ServiceResult<ReadResult>> {
    const params = readParamsSchema.parse(rawParams);
    const state = this.#store.payload;
    const record = state.documents[params.documentId];
    if (!record) {
      throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', {
        documentId: params.documentId,
      });
    }
    // 版が残っていても、閉じた文書は通常のreadで返さない（仕様4.4）。
    if (!record.isOpen) {
      throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', {
        documentId: params.documentId,
      });
    }

    let revision = params.revision ?? record.currentRevision;
    let startByte: number | null = null;
    let endByteExclusive: number | null = null;
    if (params.cursor !== undefined) {
      if (params.revision !== undefined || params.lines !== undefined) {
        throw new VdeError('E_INVALID_ARGUMENT', 'cursorと--revision／--linesは併用できません。');
      }
      const payload = this.#cursors.decode(params.cursor, 'read');
      if (payload['documentId'] !== params.documentId) {
        throw new VdeError('E_INVALID_CURSOR', 'cursorが別の文書のものです。', {
          reason: 'document',
        });
      }
      revision = payload['revision'] as string;
      startByte = payload['offset'] as number;
      endByteExclusive = payload['end'] as number;
    }

    const entry = record.revisions.find((candidate) => candidate.revision === revision);
    if (!revision || !entry) {
      // 保持していない版を、現在の版で代用しない。
      throw new VdeError('E_REVISION_UNAVAILABLE', '指定した版は保持されていません。', {
        documentId: params.documentId,
        revision: revision ?? null,
      });
    }
    const source = await this.#store.readBlob(entry.sourceSha256);
    const index = buildLineIndex(source);

    if (startByte === null || endByteExclusive === null) {
      if (params.lines) {
        const range = byteRangeOfLines(index, params.lines.start, params.lines.end);
        if (!range) {
          throw new VdeError('E_INVALID_ARGUMENT', '行範囲が文書の範囲外です。', {
            lines: params.lines,
            lineCount: index.lineCount,
          });
        }
        startByte = range.startByte;
        endByteExclusive = range.endByteExclusive;
      } else {
        startByte = 0;
        endByteExclusive = source.byteLength;
      }
    }

    const cut = truncateAtCodePoint(source, startByte, endByteExclusive, params.maxBytes);
    const truncated = cut < endByteExclusive;
    return {
      data: {
        documentId: record.documentId,
        revision,
        mode: 'source',
        content: source.subarray(startByte, cut).toString('utf8'),
        sourceRange: {
          startByte,
          endByteExclusive: cut,
          lineStart: lineOfByte(index, startByte),
          lineEnd: lineOfByte(index, Math.max(startByte, cut - 1)),
        },
        extraction: 'source',
        truncated,
        nextCursor: truncated
          ? this.#cursors.encode({
              op: 'read',
              documentId: record.documentId,
              revision,
              offset: cut,
              end: endByteExclusive,
            })
          : null,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  // 一覧から外すだけで、原本は削除しない。全対象を先に検査する（仕様5.5）。
  async close(rawParams: unknown): Promise<ServiceResult<CloseResult>> {
    const params = closeParamsSchema.parse(rawParams);
    if (!params.all && params.targets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '閉じる文書を指定してください。');
    }
    // pathの指定は、登録時と同じcanonical pathへ直して照合する。
    // 表示用の相対pathは、cwdが違うと別のfileを指すので使わない。
    const canonicalTargets = new Map<string, string>();
    for (const target of params.targets) {
      if (target.startsWith('doc_')) continue;
      canonicalTargets.set(target, await canonicalizePath(resolve(params.cwd, target)));
    }
    return this.#store.transaction((tx) => {
      const state = tx.state;
      const records = params.all
        ? state.openOrder.map((documentId) => state.documents[documentId] as DocumentRecord)
        : params.targets.map((target) => this.#resolveTarget(state, target, canonicalTargets));

      const closed: string[] = [];
      const alreadyClosed: string[] = [];
      for (const record of records) {
        if (closed.includes(record.documentId) || alreadyClosed.includes(record.documentId)) {
          continue;
        }
        if (record.isOpen) {
          record.isOpen = false;
          closed.push(record.documentId);
        } else {
          alreadyClosed.push(record.documentId);
        }
      }
      if (closed.length > 0) {
        state.openOrder = state.openOrder.filter((documentId) => !closed.includes(documentId));
        if (state.activeDocumentId !== null && closed.includes(state.activeDocumentId)) {
          state.activeDocumentId = state.openOrder[0] ?? null;
        }
        state.catalogVersion += 1;
      }
      return {
        data: { closed, alreadyClosed },
        catalogVersion: state.catalogVersion,
        warnings: [],
      };
    });
  }

  #resolveTarget(
    state: StatePayload,
    target: string,
    canonicalTargets: Map<string, string>,
  ): DocumentRecord {
    const byId = state.documents[target];
    if (byId) return byId;
    const canonicalPath = canonicalTargets.get(target);
    if (canonicalPath !== undefined) {
      const byPath = Object.values(state.documents).find(
        (record) => record.sourceKind === 'file' && record.canonicalPath === canonicalPath,
      );
      if (byPath) return byPath;
    }
    throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { target });
  }
}
