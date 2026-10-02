import { randomUUID } from 'node:crypto';
import { basename, relative, resolve, sep } from 'node:path';

import {
  buildLineIndex,
  byteRangeOfLines,
  extractTitle,
  HTML_STATIC_PARSER_PROFILE,
  lineOfByte,
  MARKDOWN_PARSER_PROFILE,
  truncateAtCodePoint,
  type DocumentAnalysis,
} from '@vde-open/document';
import {
  closeParamsSchema,
  documentIdSchema,
  LIMITS,
  listParamsSchema,
  openParamsSchema,
  readParamsSchema,
  reorderParamsSchema,
  VdeError,
  type CloseResult,
  type DocumentFormat,
  type DocumentSummary,
  type ListResult,
  type OpenResult,
  type ReadResult,
  type RefreshResult,
  type SourceState,
  type Warning,
  type WatchListResult,
  type WatchRule,
} from '@vde-open/shared';

import type { DocumentRecord, RevisionRecord, StatePayload } from '../persistence/state-schema.ts';
import type { StateStore, Transaction } from '../persistence/state-store.ts';
import type { CursorCodec } from './cursor.ts';
import {
  displayPathOf,
  expandTargets,
  formatOfPath,
  scanWatchTarget,
  watchBaseOf,
  type Candidate,
} from './enumerate.ts';
import { computeRevision } from './revision.ts';
import {
  canonicalizePath,
  decodeSource,
  readSourceFile,
  type LoadedSource,
} from './source-reader.ts';

export interface ServiceResult<T> {
  data: T;
  catalogVersion: number;
  warnings: Warning[];
}

// 変更の通知。IDと版だけを運ぶ（仕様6.5）。
export interface DocumentEvent {
  type: 'catalog-changed' | 'document-changed' | 'document-status' | 'focus-requested';
  documentId?: string;
  revision?: string | null;
}

export interface DocumentServiceOptions {
  store: StateStore;
  cursors: CursorCodec;
  now?: () => Date;
  // commitが成功した後にだけ呼ばれる。
  emit?: (event: DocumentEvent) => void;
  // 文書の構造を解析する。重い処理なので、daemonではworkerへ出す。
  analyze?: (format: DocumentFormat, text: string) => Promise<DocumentAnalysis>;
  // fileを読む処理を差し替える（testで、読み込みの完了順を制御するために使う）。
  readSource?: (path: string) => Promise<LoadedSource>;
}

// fileを読み直した結果。signatureは、読み取った内容に対応するfileの状態。読めなかったらnull。
export interface RefreshOutcome {
  changed: boolean;
  signature: string | null;
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
  // 読み取った時点のfileの状態。stdinはnull。
  signature: string | null;
}

interface ResolvedCandidates {
  // canonical pathごとの候補。symlink経由や重複指定は1件にまとめてある。
  unique: Map<string, { candidate: Candidate; format: DocumentFormat }>;
  problems: Problem[];
}

interface Problem {
  path: string;
  code: string;
  reason: string;
}

interface UpsertOptions {
  title?: string | undefined;
  key?: string | undefined;
  // falseなら、閉じている文書を開き直さない（監視による更新で使う）。
  reopen: boolean;
}

interface UpsertOutcome {
  documentId: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped';
  openSetChanged: boolean;
  revisionChanged: boolean;
}

// 一時的に消えているfileを待つ上限（仕様8.5）。
const MISSING_RETRY_MS = 1000;
const MISSING_RETRY_INTERVAL_MS = 100;

function profileOf(format: DocumentFormat): string {
  return format === 'markdown' ? MARKDOWN_PARSER_PROFILE : HTML_STATIC_PARSER_PROFILE;
}

export function toSummary(record: DocumentRecord, order: number): DocumentSummary {
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

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !fromRoot.startsWith(sep);
}

// 文書がruleの監視範囲に入るか。globは、監視の起点より下にあるかで判定する。
function ruleCovers(rule: WatchRule, canonicalPath: string): boolean {
  const base = watchBaseOf(rule);
  if (!isInside(base.directory, canonicalPath)) return false;
  return base.recursive || resolve(canonicalPath, '..') === base.directory;
}

function assertOpenLimits(state: StatePayload): void {
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
}

export class DocumentService {
  readonly #store: StateStore;
  readonly #cursors: CursorCodec;
  readonly #now: () => Date;
  readonly #emit: (event: DocumentEvent) => void;
  readonly #analyze: ((format: DocumentFormat, text: string) => Promise<DocumentAnalysis>) | null;
  readonly #readSource: (path: string) => Promise<LoadedSource>;
  // revisionごとの解析結果。古い版の遅い結果を、新しい版の結果として使わないためにrevisionで引く。
  readonly #analysisCache = new Map<string, DocumentAnalysis>();
  // canonical pathごとの、公開済みの内容に対応するfileの状態。読めなかったときはnull。
  readonly #signatures = new Map<string, string | null>();
  // canonical pathごとの待ち行列。同じfileの「読む→公開する」を1件ずつ行う。
  readonly #pathQueues = new Map<string, Promise<void>>();

  constructor(options: DocumentServiceOptions) {
    this.#store = options.store;
    this.#cursors = options.cursors;
    this.#now = options.now ?? (() => new Date());
    this.#emit = options.emit ?? (() => undefined);
    this.#analyze = options.analyze ?? null;
    this.#readSource = options.readSource ?? readSourceFile;
  }

  // fileを読んでから公開するまでを、同じfileについては1件ずつ行う。
  // 並行させると、先に読んだ古い内容が後から公開され、新しい内容を上書きする。
  // 読み込みを始めた順番では新旧を決められない（先に始めた読み込みが、後から新しい内容を読むことがある）。
  // 複数のfileを扱うときは、決まった順に取得して、互いに待ち合う状態を作らない。
  async #withPathLocks<T>(paths: Iterable<string>, work: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const path of [...new Set(paths)].toSorted()) {
        releases.push(await this.#acquirePath(path));
      }
      return await work();
    } finally {
      for (const release of releases) release();
    }
  }

  #acquirePath(path: string): Promise<() => void> {
    const previous = this.#pathQueues.get(path) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => {
      open = resolveHeld;
    });
    const tail = previous.then(() => held);
    this.#pathQueues.set(path, tail);
    return previous.then(() => () => {
      open();
      if (this.#pathQueues.get(path) === tail) this.#pathQueues.delete(path);
    });
  }

  // stateの内容に対応するfileの状態。daemonの起動後にまだ読んでいなければnull。
  readSignature(documentId: string): string | null {
    const path = this.#store.payload.documents[documentId]?.canonicalPath;
    return path ? (this.#signatures.get(path) ?? null) : null;
  }

  get state(): StatePayload {
    return this.#store.payload;
  }

  // 全候補を先に検査し、1件でも問題があれば何も登録しない（仕様5.2）。
  async open(rawParams: unknown): Promise<ServiceResult<OpenResult>> {
    const params = openParamsSchema.parse(rawParams);
    const warnings: Warning[] = [];

    if (params.stdin) {
      if (params.paths.length > 0) {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinとpathは同時に指定できません。');
      }
      if (params.format === 'auto') {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinから開くときは--formatが必要です。');
      }
      if (params.watch) {
        throw new VdeError('E_INVALID_ARGUMENT', '--watchはdirectoryかglobに対して指定します。');
      }
      const bytes = Buffer.from(params.stdin.content, 'utf8');
      return this.#commitOpen(
        params,
        [
          {
            sourceKind: 'stdin',
            canonicalPath: null,
            displayPath: null,
            pathSegments: [],
            format: params.format,
            bytes,
            text: decodeSource(bytes, 'stdin'),
            fallbackTitle: params.key ?? 'stdin',
            signature: null,
          },
        ],
        [],
        warnings,
      );
    }

    if (params.paths.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '開く文書を指定してください。');
    }
    const expansion = await expandTargets(params.cwd, params.paths, params.recursive);
    const watchTargets = params.watch ? expansion.watchTargets : [];
    if (params.watch && watchTargets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '--watchはdirectoryかglobに対して指定します。');
    }
    for (const target of expansion.emptyTargets) {
      warnings.push({
        code: 'W_NO_DOCUMENTS',
        message: `${target} に対象の文書がありません。`,
        details: { path: target },
      });
    }
    const resolved = await this.#resolveCandidates(
      expansion.candidates,
      params.format === 'auto' ? null : params.format,
    );
    return this.#withPathLocks(resolved.unique.keys(), async () => {
      const incoming = await this.#readCandidates(resolved);
      // --watchなら、いま対象がなくても、ruleだけを登録できる。
      if (incoming.length === 0 && watchTargets.length === 0) {
        throw new VdeError('E_PATH_NOT_FOUND', '対象の文書がありません。', {
          paths: params.paths,
        });
      }
      return this.#commitOpen(params, incoming, watchTargets, warnings);
    });
  }

  async #commitOpen(
    params: ReturnType<typeof openParamsSchema.parse>,
    incoming: Incoming[],
    watchTargets: Awaited<ReturnType<typeof expandTargets>>['watchTargets'],
    warnings: Warning[],
  ): Promise<ServiceResult<OpenResult>> {
    if ((params.title !== undefined || params.key !== undefined) && incoming.length !== 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        '--titleと--keyは、文書を1件だけ開くときに指定できます。',
        { documents: incoming.length },
      );
    }

    const events: DocumentEvent[] = [];
    const result = await this.#store.transaction((tx) => {
      const state = tx.state;
      const timestamp = this.#now().toISOString();
      const touched: string[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let openSetChanged = false;

      for (const item of incoming) {
        const outcome = this.#upsert(tx, item, {
          title: params.title,
          key: params.key,
          reopen: true,
        });
        touched.push(outcome.documentId);
        if (outcome.outcome === 'created') created += 1;
        else if (outcome.outcome === 'updated') updated += 1;
        else unchanged += 1;
        openSetChanged ||= outcome.openSetChanged;
        // titleや状態だけの変更も通知する。UIは通知を契機に一覧を取り直す。
        if (outcome.outcome === 'updated') {
          events.push({
            type: outcome.revisionChanged ? 'document-changed' : 'document-status',
            documentId: outcome.documentId,
            revision: state.documents[outcome.documentId]?.currentRevision ?? null,
          });
        }
        // 明示的に開いた文書は、監視ruleでの「閉じたので復帰させない」扱いを解除する。
        if (item.canonicalPath !== null) {
          for (const rule of state.watchRules) {
            rule.suppressedPaths = rule.suppressedPaths.filter(
              (path) => path !== item.canonicalPath,
            );
          }
        }
      }

      const rules: WatchRule[] = [];
      for (const target of watchTargets) {
        let rule = state.watchRules.find(
          (candidate) =>
            candidate.kind === target.kind &&
            candidate.root === target.root &&
            candidate.pattern === target.pattern &&
            candidate.recursive === target.recursive,
        );
        if (!rule) {
          rule = {
            watchId: `watch_${randomUUID()}`,
            ...target,
            suppressedPaths: [],
            createdAt: timestamp,
          };
          state.watchRules.push(rule);
        }
        rules.push(rule);
      }

      assertOpenLimits(state);
      if (created + updated > 0) state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      if (openSetChanged) events.unshift({ type: 'catalog-changed' });

      return {
        data: {
          documents: touched.map((documentId) =>
            toSummary(
              state.documents[documentId] as DocumentRecord,
              state.openOrder.indexOf(documentId),
            ),
          ),
          watchRules: structuredClone(rules),
          created,
          updated,
          unchanged,
        },
        catalogVersion: state.catalogVersion,
        warnings,
      };
    });
    for (const item of incoming) {
      if (item.canonicalPath !== null) this.#signatures.set(item.canonicalPath, item.signature);
    }
    for (const event of events) this.#emit(event);
    return result;
  }

  // 形式の検査は全候補に対して行い、本文の読み込みは重複を除いてから行う。
  async #resolveCandidates(
    candidates: Candidate[],
    explicitFormat: DocumentFormat | null,
  ): Promise<ResolvedCandidates> {
    const problems: Problem[] = [];
    const unique = new Map<string, { candidate: Candidate; format: DocumentFormat }>();
    for (const candidate of candidates) {
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
      // symlink経由や重複指定は、同じcanonical fileの1件として数える。
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
    return { unique, problems };
  }

  // 候補の本文を読む。呼び出し側が、対象のfileの待ち行列を取得してから呼ぶ。
  async #readCandidates(resolved: ResolvedCandidates): Promise<Incoming[]> {
    const problems = [...resolved.problems];
    // 合計の大きさは読み込みながら確かめる。上限を超える量をmemoryへ載せない。
    const incoming: Incoming[] = [];
    let loadedBytes = 0;
    for (const [canonicalPath, { candidate, format }] of resolved.unique) {
      let loaded;
      try {
        loaded = await this.#readSource(candidate.absolutePath);
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        problems.push({
          path: candidate.displayPath,
          code: error.code,
          reason: String(error.details['reason'] ?? error.details['limit'] ?? 'unreadable'),
        });
        continue;
      }
      // 待ち行列を取得した後に、指定が別のfileを指すようになった。順序を保証できないので登録しない。
      if (loaded.canonicalPath !== canonicalPath) {
        problems.push({ path: candidate.displayPath, code: 'E_IO', reason: 'changed-during-read' });
        continue;
      }
      loadedBytes += loaded.bytes.byteLength;
      if (loadedBytes > LIMITS.openSourceBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
          limit: 'openSourceBytes',
          max: LIMITS.openSourceBytes,
        });
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
        signature: loaded.signature,
      });
    }
    if (problems.length > 0) {
      const first = problems[0] as Problem;
      throw new VdeError(
        first.code as VdeError['code'],
        `${String(problems.length)}件の文書を開けないため、どの文書も登録していません。`,
        { problems },
      );
    }
    return incoming;
  }

  // 読み込んだ内容をstateへ反映する。同じ内容なら版を増やさない。
  #upsert(tx: Transaction, item: Incoming, options: UpsertOptions): UpsertOutcome {
    const state = tx.state;
    const now = this.#now();
    const timestamp = now.toISOString();
    const existing = this.#findExisting(state, item, options.key);
    if (options.key !== undefined) {
      const holder = Object.values(state.documents).find((record) => record.key === options.key);
      if (holder && holder.documentId !== existing?.documentId) {
        throw new VdeError('E_KEY_CONFLICT', 'そのkeyは別の文書が使っています。', {
          key: options.key,
          documentId: holder.documentId,
        });
      }
    }
    if (existing && !existing.isOpen && !options.reopen) {
      return {
        documentId: existing.documentId,
        outcome: 'skipped',
        openSetChanged: false,
        revisionChanged: false,
      };
    }

    const sourceSha256 = tx.putBlob(item.bytes);
    const revision = computeRevision({
      format: item.format,
      sourceSha256,
      parserProfileVersion: profileOf(item.format),
      assets: [],
    });
    const title = options.title ?? extractTitle(item.text, item.format) ?? item.fallbackTitle;
    const revisionRecord: RevisionRecord = {
      revision,
      format: item.format,
      sourceSha256,
      byteLength: item.bytes.byteLength,
      parserProfileVersion: profileOf(item.format),
      createdAt: timestamp,
    };

    if (!existing) {
      const documentId = `doc_${randomUUID()}`;
      state.documents[documentId] = {
        documentId,
        sourceKind: item.sourceKind,
        canonicalPath: item.canonicalPath,
        key: options.key ?? null,
        format: item.format,
        title,
        titleExplicit: options.title !== undefined,
        displayPath: item.displayPath,
        pathSegments: item.pathSegments,
        isOpen: true,
        openedAt: timestamp,
        updatedAt: timestamp,
        sourceState: 'ready',
        currentRevision: revision,
        revisions: [revisionRecord],
      };
      state.openOrder.push(documentId);
      return { documentId, outcome: 'created', openSetChanged: true, revisionChanged: true };
    }

    let changed = false;
    let openSetChanged = false;
    let revisionChanged = false;
    if (!existing.isOpen) {
      existing.isOpen = true;
      existing.openedAt = timestamp;
      state.openOrder.push(existing.documentId);
      changed = true;
      openSetChanged = true;
    }
    if (existing.currentRevision !== revision) {
      const kept = existing.revisions.filter((entry) => entry.revision !== revision);
      kept.push(revisionRecord);
      existing.revisions = pruneRevisions(kept, now.getTime());
      existing.currentRevision = revision;
      existing.format = item.format;
      changed = true;
      revisionChanged = true;
    }
    if (existing.sourceState !== 'ready') {
      existing.sourceState = 'ready';
      changed = true;
    }
    if (options.title !== undefined) {
      changed ||= existing.title !== title || !existing.titleExplicit;
      existing.title = title;
      existing.titleExplicit = true;
    } else if (!existing.titleExplicit && existing.title !== title) {
      existing.title = title;
      changed = true;
    }
    if (options.key !== undefined && existing.key !== options.key) {
      existing.key = options.key;
      changed = true;
    }
    if (options.reopen && item.displayPath !== null && existing.displayPath !== item.displayPath) {
      existing.displayPath = item.displayPath;
      changed = true;
    }
    if (changed) existing.updatedAt = timestamp;
    return {
      documentId: existing.documentId,
      outcome: changed ? 'updated' : 'unchanged',
      openSetChanged,
      revisionChanged,
    };
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

  #requireOpen(documentId: string): DocumentRecord {
    const record = this.#store.payload.documents[documentId];
    if (!record) {
      throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { documentId });
    }
    // 版が残っていても、閉じた文書は通常のreadで返さない（仕様4.4）。
    if (!record.isOpen) {
      throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', { documentId });
    }
    return record;
  }

  async read(rawParams: unknown): Promise<ServiceResult<ReadResult>> {
    const params = readParamsSchema.parse(rawParams);
    const state = this.#store.payload;
    const record = this.#requireOpen(params.documentId);

    if (params.outline) {
      if (params.lines !== undefined || params.cursor !== undefined) {
        throw new VdeError('E_INVALID_ARGUMENT', '--outlineと--lines／--cursorは併用できません。');
      }
      return this.#readOutline(record, params.revision);
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

    const entry = this.#requireRevision(record, revision);
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
        revision: entry.revision,
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
              revision: entry.revision,
              offset: cut,
              end: endByteExclusive,
            })
          : null,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  #requireRevision(record: DocumentRecord, revision: string | null): RevisionRecord {
    const entry = record.revisions.find((candidate) => candidate.revision === revision);
    if (!revision || !entry) {
      // 保持していない版を、現在の版で代用しない。
      throw new VdeError('E_REVISION_UNAVAILABLE', '指定した版は保持されていません。', {
        documentId: record.documentId,
        revision: revision ?? null,
      });
    }
    return entry;
  }

  async #readOutline(
    record: DocumentRecord,
    requestedRevision: string | undefined,
  ): Promise<ServiceResult<ReadResult>> {
    const entry = this.#requireRevision(record, requestedRevision ?? record.currentRevision);
    // 解析の条件は、版を作ったときの形式で決める。文書の現在の形式では決めない。
    const analysis = await this.#analysisOf(entry);
    return {
      data: {
        documentId: record.documentId,
        revision: entry.revision,
        mode: 'outline',
        outline: analysis.outline,
        // 原文の位置を正確に得られないので、推測した行番号は返さない（仕様8.3）。
        sourceRange: null,
        extraction: entry.format === 'markdown' ? 'markdown' : 'static-html',
        truncated: false,
        nextCursor: null,
      },
      catalogVersion: this.#store.payload.catalogVersion,
      warnings: [],
    };
  }

  async #analysisOf(entry: RevisionRecord): Promise<DocumentAnalysis> {
    const cached = this.#analysisCache.get(entry.revision);
    if (cached) return cached;
    if (!this.#analyze) {
      throw new VdeError('E_INTERNAL', '文書の解析が利用できません。');
    }
    const source = await this.#store.readBlob(entry.sourceSha256);
    const analysis = await this.#analyze(entry.format, source.toString('utf8'));
    // 結果は解析した版にだけ結び付ける。別の版の結果として返ることはない。
    this.#analysisCache.set(entry.revision, analysis);
    while (this.#analysisCache.size > 64) {
      const oldest = this.#analysisCache.keys().next().value;
      if (oldest === undefined) break;
      this.#analysisCache.delete(oldest);
    }
    return analysis;
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
    let changed = false;
    const result = await this.#store.transaction((tx) => {
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
        if (!record.isOpen) {
          alreadyClosed.push(record.documentId);
          continue;
        }
        record.isOpen = false;
        closed.push(record.documentId);
        // 監視ruleの範囲にある文書は、再走査で勝手に復帰させない（仕様5.3）。
        if (record.canonicalPath !== null) {
          for (const rule of state.watchRules) {
            if (
              ruleCovers(rule, record.canonicalPath) &&
              !rule.suppressedPaths.includes(record.canonicalPath)
            ) {
              rule.suppressedPaths.push(record.canonicalPath);
            }
          }
        }
      }
      if (closed.length > 0) {
        state.openOrder = state.openOrder.filter((documentId) => !closed.includes(documentId));
        if (state.activeDocumentId !== null && closed.includes(state.activeDocumentId)) {
          state.activeDocumentId = state.openOrder[0] ?? null;
        }
        state.catalogVersion += 1;
        changed = true;
      }
      // --allは、すべての監視ruleも解除する。
      if (params.all) state.watchRules = [];
      return {
        data: { closed, alreadyClosed },
        catalogVersion: state.catalogVersion,
        warnings: [],
      };
    });
    if (changed) this.#emit({ type: 'catalog-changed' });
    return result;
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

  // 表示順を保存する。fileの場所は動かさない（仕様13.1）。
  async reorder(rawParams: unknown): Promise<ServiceResult<ListResult>> {
    const params = reorderParamsSchema.parse(rawParams);
    const changed = await this.#store.transaction((tx) => {
      const state = tx.state;
      if (state.catalogVersion !== params.expectedCatalogVersion) {
        throw new VdeError('E_CATALOG_CONFLICT', '一覧が変わりました。取得し直してください。', {
          catalogVersion: state.catalogVersion,
        });
      }
      const current = new Set(state.openOrder);
      const requested = new Set(params.order);
      const sameSet =
        params.order.length === state.openOrder.length &&
        requested.size === params.order.length &&
        [...current].every((documentId) => requested.has(documentId));
      if (!sameSet) {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          '並び順には、開いている全文書のIDを1回ずつ指定してください。',
        );
      }
      if (params.order.every((documentId, index) => state.openOrder[index] === documentId)) {
        return false;
      }
      state.openOrder = [...params.order];
      state.catalogVersion += 1;
      return true;
    });
    if (changed) this.#emit({ type: 'catalog-changed' });
    return this.list({ limit: LIMITS.listLimitMax });
  }

  // 明示的なUI選択の通知。文書は再登録しない（仕様5.5）。
  async focus(rawParams: unknown): Promise<ServiceResult<{ documentId: string }>> {
    const documentId = documentIdSchema.parse((rawParams as { documentId?: unknown }).documentId);
    this.#requireOpen(documentId);
    const catalogVersion = await this.#store.transaction((tx) => {
      tx.state.activeDocumentId = documentId;
      return tx.state.catalogVersion;
    });
    this.#emit({ type: 'focus-requested', documentId });
    return { data: { documentId }, catalogVersion, warnings: [] };
  }

  // fileを読み直す。指定がなければ、開いているfile文書のすべて。
  async refresh(rawParams: unknown): Promise<ServiceResult<RefreshResult>> {
    const raw = (rawParams as { documentId?: unknown }).documentId;
    const targets =
      raw === undefined
        ? this.#store.payload.openOrder
        : [this.#requireOpen(documentIdSchema.parse(raw)).documentId];
    const changed: string[] = [];
    for (const documentId of targets) {
      if ((await this.refreshFromDisk(documentId)).changed) changed.push(documentId);
    }
    const state = this.#store.payload;
    return {
      data: {
        documents: targets.flatMap((documentId) => {
          const record = state.documents[documentId];
          return record?.isOpen ? [toSummary(record, state.openOrder.indexOf(documentId))] : [];
        }),
        changed,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  // 開いているfile文書の現在の内容を読み、変わっていれば新しい版として公開する。
  // 読めなくなっていれば状態だけを更新し、古い内容を新しい内容として扱わない。
  async refreshFromDisk(documentId: string): Promise<RefreshOutcome> {
    const before = this.#store.payload.documents[documentId];
    if (!before?.isOpen || before.sourceKind !== 'file' || before.canonicalPath === null) {
      return { changed: false, signature: null };
    }
    const canonicalPath = before.canonicalPath;
    return this.#withPathLocks([canonicalPath], () =>
      this.#refreshLocked(documentId, canonicalPath),
    );
  }

  async #refreshLocked(documentId: string, canonicalPath: string): Promise<RefreshOutcome> {
    let loaded: LoadedSource | null = null;
    let failure: SourceState = 'error';
    const deadline = Date.now() + MISSING_RETRY_MS;
    for (;;) {
      try {
        loaded = await this.#readSource(canonicalPath);
        break;
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        if (error.code === 'E_PATH_NOT_FOUND') {
          // 保存の途中で一時的に消えているだけかもしれない。少し待って読み直す。
          failure = 'missing';
          if (Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, MISSING_RETRY_INTERVAL_MS));
            continue;
          }
        } else {
          failure = error.details['reason'] === 'permission-denied' ? 'unreadable' : 'error';
        }
        break;
      }
    }

    const events: DocumentEvent[] = [];
    const applied = await this.#store.transaction((tx) => {
      const state = tx.state;
      const record = state.documents[documentId];
      // 読んでいる間に閉じられていたら、何もしない。
      if (!record?.isOpen) return false;
      if (!loaded || loaded.canonicalPath !== record.canonicalPath) {
        if (record.sourceState !== failure) {
          record.sourceState = failure;
          record.updatedAt = this.#now().toISOString();
          state.catalogVersion += 1;
          events.push({ type: 'document-status', documentId, revision: record.currentRevision });
        }
        return true;
      }
      const outcome = this.#upsert(
        tx,
        {
          sourceKind: 'file',
          canonicalPath: loaded.canonicalPath,
          displayPath: record.displayPath,
          pathSegments: record.pathSegments,
          format: record.format,
          bytes: loaded.bytes,
          text: loaded.text,
          fallbackTitle: basename(loaded.canonicalPath),
          signature: loaded.signature,
        },
        { reopen: false },
      );
      if (outcome.outcome !== 'updated') return true;
      assertOpenLimits(state);
      state.catalogVersion += 1;
      events.push({
        type: outcome.revisionChanged ? 'document-changed' : 'document-status',
        documentId,
        revision: record.currentRevision,
      });
      return true;
    });
    if (!applied) return { changed: false, signature: null };
    // 読み取った内容を公開した（または、読めないことを記録した）。対応するfileの状態を覚える。
    const signature = loaded?.canonicalPath === canonicalPath ? loaded.signature : null;
    this.#signatures.set(canonicalPath, signature);
    for (const event of events) this.#emit(event);
    return { changed: events.length > 0, signature };
  }

  // 監視ruleの対象を走査し、新しく現れた文書を登録する。
  // 閉じた文書（suppressedPaths）と、すでに開いている文書は対象にしない。
  async reconcileWatchRule(watchId: string): Promise<string[]> {
    const before = this.#store.payload;
    const rule = before.watchRules.find((candidate) => candidate.watchId === watchId);
    if (!rule) return [];
    const openPaths = new Set(
      Object.values(before.documents)
        .filter((record) => record.isOpen && record.canonicalPath !== null)
        .map((record) => record.canonicalPath),
    );
    // すでに開いている文書と、閉じた文書は、本文を読まずに除く。
    const candidates = new Map<string, DocumentFormat>();
    for (const path of await scanWatchTarget(rule)) {
      const format = formatOfPath(path);
      if (!format) continue;
      const candidatePath = await canonicalizePath(path);
      if (openPaths.has(candidatePath) || rule.suppressedPaths.includes(candidatePath)) continue;
      candidates.set(candidatePath, format);
    }
    if (candidates.size === 0) return [];
    // 件数は本文を読む前に確かめる。上限を超える量をmemoryへ載せない。
    if (before.openOrder.length + candidates.size > LIMITS.openDocuments) {
      throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
        limit: 'openDocuments',
        max: LIMITS.openDocuments,
        actual: before.openOrder.length + candidates.size,
      });
    }

    return this.#withPathLocks(candidates.keys(), () =>
      this.#registerDiscovered(watchId, candidates),
    );
  }

  async #registerDiscovered(
    watchId: string,
    candidates: Map<string, DocumentFormat>,
  ): Promise<string[]> {
    const before = this.#store.payload;
    const rule = before.watchRules.find((candidate) => candidate.watchId === watchId);
    if (!rule) return [];
    const isOpenPath = (state: StatePayload, path: string) =>
      Object.values(state.documents).some(
        (record) => record.isOpen && record.sourceKind === 'file' && record.canonicalPath === path,
      );

    // 合計の大きさは、開いている文書の分も含めて、読み込みながら確かめる。
    let totalBytes = openSourceBytes(before);
    const discovered: Incoming[] = [];
    for (const [path, format] of candidates) {
      // 順番を待っている間に開かれた文書と、閉じられた文書は読まない。
      if (isOpenPath(before, path) || rule.suppressedPaths.includes(path)) continue;
      let loaded;
      try {
        loaded = await this.#readSource(path);
      } catch (error) {
        // 個別のerrorで監視全体を止めない。次の走査でもう一度試す。
        if (error instanceof VdeError) continue;
        throw error;
      }
      if (loaded.canonicalPath !== path) continue;
      totalBytes += loaded.bytes.byteLength;
      if (totalBytes > LIMITS.openSourceBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
          limit: 'openSourceBytes',
          max: LIMITS.openSourceBytes,
        });
      }
      discovered.push({
        sourceKind: 'file',
        canonicalPath: loaded.canonicalPath,
        // 監視で見つけた文書は、ruleの起点からの相対pathで表示する。
        displayPath: displayPathOf(rule.root, loaded.canonicalPath),
        pathSegments: loaded.canonicalPath.split(sep).filter((segment) => segment !== ''),
        format,
        bytes: loaded.bytes,
        text: loaded.text,
        fallbackTitle: basename(loaded.canonicalPath),
        signature: loaded.signature,
      });
    }
    if (discovered.length === 0) return [];

    const appliedItems: Incoming[] = [];
    const registered = await this.#store.transaction((tx) => {
      const state = tx.state;
      const current = state.watchRules.find((candidate) => candidate.watchId === watchId);
      // 走査の間にruleが外されていたら、登録しない。
      if (!current) return [];
      const added: string[] = [];
      for (const item of discovered) {
        const path = item.canonicalPath as string;
        if (current.suppressedPaths.includes(path)) continue;
        // ここで扱うのは、新しく登録する文書だけ。開いている文書には触れない。
        if (isOpenPath(state, path)) continue;
        const outcome = this.#upsert(tx, item, { reopen: true });
        appliedItems.push(item);
        if (outcome.openSetChanged) added.push(outcome.documentId);
      }
      if (added.length === 0) return [];
      assertOpenLimits(state);
      state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      return added;
    });
    for (const item of appliedItems) {
      if (item.canonicalPath !== null) this.#signatures.set(item.canonicalPath, item.signature);
    }
    if (registered.length > 0) this.#emit({ type: 'catalog-changed' });
    return registered;
  }

  listWatchRules(): ServiceResult<WatchListResult> {
    const state = this.#store.payload;
    return {
      data: { watchRules: structuredClone(state.watchRules) },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  // ruleだけを外す。そのruleで開いた文書は閉じない（仕様5.3）。
  async removeWatchRule(rawParams: unknown): Promise<ServiceResult<WatchListResult>> {
    const watchId = (rawParams as { watchId?: unknown }).watchId;
    await this.#store.transaction((tx) => {
      const index = tx.state.watchRules.findIndex((rule) => rule.watchId === watchId);
      if (index === -1) {
        throw new VdeError('E_WATCH_NOT_FOUND', '監視ruleが見つかりません。', {
          watchId: typeof watchId === 'string' ? watchId : null,
        });
      }
      tx.state.watchRules.splice(index, 1);
    });
    return this.listWatchRules();
  }
}
