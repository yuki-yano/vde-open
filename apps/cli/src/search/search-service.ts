import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';

import { analyzeDocument, ParseLimitError, type DocumentAnalysis } from '@vde-open/document';
import {
  LIMITS,
  searchParamsSchema,
  VdeError,
  type DocumentFormat,
  type SearchHit,
  type SearchResult,
} from '@vde-open/shared';

import type { CursorCodec } from '../documents/cursor.ts';
import type { ServiceResult } from '../documents/service.ts';
import { searchWorkerPath } from '../entry-paths.ts';
import type { DocumentRecord, RevisionRecord, StatePayload } from '../persistence/state-schema.ts';
import type { StateStore } from '../persistence/state-store.ts';
import type { SearchWorkerRequest } from '../workers/search-worker.ts';
import { batchesOf, partsOf, type IndexedMeta } from './search-index.ts';
import { codePointLength, uniqueTokens } from './tokenize.ts';

export type DocumentSearchState = 'ready' | 'indexing' | 'excluded';

export interface SearchService {
  // 現在の文書の状態に合わせて、indexを更新する。変更の通知のたびに呼ぶ。
  sync(): void;
  search(rawParams: unknown): Promise<ServiceResult<SearchResult>>;
  // 一覧に出す、文書ごとの検索の状態。
  stateOf(documentId: string): DocumentSearchState;
  close(): Promise<void>;
}

export interface SearchServiceOptions {
  store: StateStore;
  cursors: CursorCodec;
  now?: () => Date;
  workerPath?: string;
  // 1件の処理を待つ上限。超えたらworkerを止めて作り直す。
  timeoutMs?: number;
  // 文書を節へ分ける解析。daemonでは、解析用のworkerへ出す（検索のworkerを、重い解析で塞がない）。
  // 指定がなければ、このthreadで解析する。
  analyze?: (format: DocumentFormat, text: string) => Promise<DocumentAnalysis>;
}

// 1文書のindexの状態。revisionは、indexへ入れた（入れようとした）版。
// metaKeyは、indexへ入れたtitle・path・順番。本文が同じでも、これが変われば入れ直す。
interface Indexed {
  revision: string;
  metaKey: string;
  state: 'ready' | 'indexing' | 'failed';
  code: string | null;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; reason: string };

type Work = SearchWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

const DEFAULT_TIMEOUT_MS = 10_000;
const WAIT_STEP_MS = 20;
// 1回の依頼で索引へ入れる量。小さく分けて、その間に検索の依頼を挟めるようにする。
// 重さは、索引に入れるfield（本文・見出し）の長さ（UTF-16のcode unit）。
const APPEND_BATCH_WEIGHT = 65_536;
// 1回の依頼で入れる部分の数。本文の短い節が多い文書でも、1回の量を抑える。
const APPEND_BATCH_PARTS = 256;

// 検索の対象になるのは、開いていて、いまの内容を読めている文書だけ（仕様9.1、8.5）。
function searchable(record: DocumentRecord | undefined): record is DocumentRecord {
  return record !== undefined && record.isOpen && record.sourceState === 'ready';
}

function byteLengthOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function metaOf(record: DocumentRecord, entry: RevisionRecord, order: number): IndexedMeta {
  return {
    documentId: record.documentId,
    revision: entry.revision,
    format: entry.format,
    title: record.title,
    displayPath: record.displayPath,
    fileName: record.canonicalPath === null ? null : basename(record.canonicalPath),
    canonicalPath: record.canonicalPath,
    order,
  };
}

function metaKeyOf(meta: IndexedMeta): string {
  return JSON.stringify([meta.title, meta.displayPath, meta.canonicalPath, meta.order]);
}

// hitの並び。cursorは、この並びが変わっていないときだけ続きを返す（抜けや重複を黙って返さない）。
function digestOf(hits: SearchHit[]): string {
  const hash = createHash('sha256');
  for (const hit of hits) hash.update(`${hit.documentId}\0${hit.revision}\0${hit.sectionId}\n`);
  return hash.digest('hex');
}

function staleCursor(reason: 'catalog' | 'results', catalogVersion: number): VdeError {
  return new VdeError(
    'E_CURSOR_STALE',
    '検索の対象か結果が変わりました。最初から検索し直してください。',
    { reason, catalogVersion, restart: true },
  );
}

function analyzeInProcess(format: DocumentFormat, text: string): Promise<DocumentAnalysis> {
  try {
    return Promise.resolve(analyzeDocument(text, format));
  } catch (error) {
    return Promise.reject(
      new VdeError('E_PARSE_FAILED', '文書を解析できませんでした。', {
        reason: error instanceof ParseLimitError ? `limit-${error.limit}` : 'parse-error',
      }),
    );
  }
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  const { store, cursors } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerPath = options.workerPath ?? searchWorkerPath();
  const analyze = options.analyze ?? analyzeInProcess;
  const indexed = new Map<string, Indexed>();
  // workerが内容を持ちうる文書（入れている途中か、確定済み）。登録の記録（indexed）とは別に持つ。
  const resident = new Set<string>();
  const pending = new Map<number, Pending>();
  let worker: Worker | null = null;
  let nextId = 1;
  let closed = false;
  let indexedAt = now().toISOString();
  // indexの更新は1件ずつ行う。実行中に依頼が来たら、終わった後にもう一度だけ行う。
  let syncing: Promise<void> | null = null;
  let syncRequested = false;

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  // workerを止める。indexはworkerの中にあるので、止めたら全部の文書を入れ直す。
  const discardWorker = () => {
    const current = worker;
    worker = null;
    indexed.clear();
    resident.clear();
    if (current) void current.terminate();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(workerPath);
    created.unref();
    created.on('message', (reply: WorkerReply) => {
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply.result);
      else
        waiter.reject(
          new VdeError('E_INDEX_NOT_READY', '検索のindexを更新できませんでした。', {
            reason: reply.reason,
          }),
        );
    });
    created.on('error', () => {
      if (worker === created) discardWorker();
      failAll(new VdeError('E_INDEX_NOT_READY', '検索のindexを使えません。'));
    });
    worker = created;
    return created;
  };

  const request = <T>(work: Work): Promise<T> => {
    if (closed)
      return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
    return new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        // 終わらない処理は、workerごと止めて回収する。
        pending.delete(id);
        discardWorker();
        failAll(new VdeError('E_INDEX_NOT_READY', '検索のindexを使えません。'));
        reject(
          new VdeError('E_INDEX_NOT_READY', '検索のindexの処理が時間内に終わりませんでした。', {
            reason: 'timeout',
          }),
        );
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      ensureWorker().postMessage({ id, ...work });
    });
  };

  // 解析用のworkerは、ほかの文書の解析が時間切れになると作り直され、待っていた解析もすべて失敗として返る。
  // その巻き添えで、この文書を「解析できない」と記録しないよう、1回だけやり直す。
  const analyzeOnce = async (format: DocumentFormat, text: string): Promise<DocumentAnalysis> => {
    try {
      return await analyze(format, text);
    } catch (error) {
      const reason = error instanceof VdeError ? error.details['reason'] : undefined;
      if (reason !== 'timeout' && reason !== 'worker') throw error;
      return analyze(format, text);
    }
  };

  // 文書を解析して、本文を何回かに分けてindexへ入れる。
  // 分けて送る間に、検索の依頼を挟める（workerが1回に塞がる時間を短くする）。
  const reindex = async (entry: RevisionRecord, meta: IndexedMeta): Promise<void> => {
    const { documentId, revision } = meta;
    const metaKey = metaKeyOf(meta);
    // 入れている間に、閉じたり版が進んだりしていないか。workerを作り直した場合も、続けない。
    const current = () => {
      const latest = store.payload.documents[documentId];
      return (
        searchable(latest) &&
        latest.currentRevision === revision &&
        indexed.get(documentId)?.revision === revision
      );
    };
    const attempt: Indexed = { revision, metaKey, state: 'indexing', code: null };
    indexed.set(documentId, attempt);
    // 途中でやめる。入れかけた内容を捨て、この登録の記録を消す（次の同期で、改めて入れ直す）。
    const giveUp = async (begun: boolean) => {
      if (begun) await request({ op: 'abort', documentId }).catch(() => undefined);
      if (indexed.get(documentId) === attempt) indexed.delete(documentId);
    };
    try {
      const text = (await store.readBlob(entry.sourceSha256)).toString('utf8');
      const { sections } = await analyzeOnce(entry.format, text);
      if (!current()) {
        await giveUp(false);
        return;
      }
      // workerがこの文書を持ちうる。閉じたときに、確定済みの内容も含めて消すために覚えておく。
      resident.add(documentId);
      await request({ op: 'begin', meta });
      // 1回に送る量は、索引に入れるfieldの長さと、部分の数で区切る。
      for (const batch of batchesOf(partsOf(sections), APPEND_BATCH_WEIGHT, APPEND_BATCH_PARTS)) {
        if (!current()) {
          await giveUp(true);
          return;
        }
        await request({ op: 'append', documentId, revision, parts: batch });
      }
      if (!current()) {
        await giveUp(true);
        return;
      }
      await request({ op: 'commit', documentId, revision });
      if (indexed.get(documentId) === attempt) {
        indexed.set(documentId, { revision, metaKey, state: 'ready', code: null });
      }
    } catch (error) {
      const code = error instanceof VdeError ? error.code : 'E_INTERNAL';
      // workerを止めた場合は、indexedが空になっている。この文書だけ、失敗として記録する。
      indexed.set(documentId, { revision, metaKey, state: 'failed', code });
    }
  };

  // stateとindexを比べ、差分を1件ずつ反映する。
  const syncOnce = async (): Promise<void> => {
    const state = store.payload;
    // 検索の対象でなくなった文書を、workerから消す。登録の記録を消した後でも、
    // workerに確定済みの内容が残っていることがあるので、workerが持ちうる文書も調べる。
    for (const documentId of new Set([...indexed.keys(), ...resident])) {
      if (searchable(state.documents[documentId])) continue;
      indexed.delete(documentId);
      if (!resident.has(documentId)) continue;
      resident.delete(documentId);
      await request({ op: 'remove', documentId }).catch(() => undefined);
      indexedAt = now().toISOString();
    }
    for (const [order, documentId] of state.openOrder.entries()) {
      const record = state.documents[documentId];
      if (!searchable(record) || record.currentRevision === null) continue;
      const revision = record.currentRevision;
      const entry = record.revisions.find((candidate) => candidate.revision === revision);
      if (!entry) continue;
      const meta = metaOf(record, entry, order);
      const metaKey = metaKeyOf(meta);
      const known = indexed.get(documentId);
      // 同期は1件ずつ行うので、ここで「登録中」の記録が残っていれば、それは終わらなかった登録のもの。入れ直す。
      if (known && known.revision === revision && known.state !== 'indexing') {
        if (known.metaKey === metaKey) continue;
        if (known.state === 'failed') {
          // 解析できなかった版は、titleなどが変わっても入れ直さない（版が変わるまで失敗のまま）。
          known.metaKey = metaKey;
          continue;
        }
        // title・path・順番だけが変わった。本文は入れ直さずに、属性だけを変える。
        const updated = await request<boolean>({ op: 'meta', meta }).catch(() => false);
        if (updated) {
          const latest = indexed.get(documentId);
          if (latest?.revision === revision) latest.metaKey = metaKey;
          indexedAt = now().toISOString();
          continue;
        }
      }
      await reindex(entry, meta);
      indexedAt = now().toISOString();
    }
  };

  const sync = (): Promise<void> => {
    if (closed) return Promise.resolve();
    syncRequested = true;
    syncing ??= (async () => {
      try {
        while (syncRequested) {
          syncRequested = false;
          if (closed) break;
          await syncOnce();
        }
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  // 文書のindexの状態。いまの版と属性（title・path・順番）に追い付いていれば'ready'。
  // 待機の判定、検索結果の集計、一覧の表示で、同じ判定を使う。
  const syncStateOf = (
    state: StatePayload,
    documentId: string,
  ): 'ready' | 'indexing' | 'failed' | 'excluded' => {
    const record = state.documents[documentId];
    if (!searchable(record)) return 'excluded';
    const known = indexed.get(documentId);
    if (!known || known.revision !== record.currentRevision) return 'indexing';
    if (known.state !== 'ready') return known.state;
    const entry = record.revisions.find((candidate) => candidate.revision === known.revision);
    if (!entry) return 'indexing';
    const order = state.openOrder.indexOf(documentId);
    return known.metaKey === metaKeyOf(metaOf(record, entry, order)) ? 'ready' : 'indexing';
  };

  // 対象の文書のindexが、いまの版と属性に追い付いているか（解析できない文書は、待たない）。
  const settled = (state: StatePayload, targets: string[]): boolean =>
    targets.every((documentId) => syncStateOf(state, documentId) !== 'indexing');

  const targetsOf = (state: StatePayload, documents: string[]): string[] => {
    if (documents.length === 0) return [...state.openOrder];
    for (const documentId of documents) {
      const record = state.documents[documentId];
      if (!record)
        throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { documentId });
      // 閉じた文書は、検索の対象にできない。
      if (!record.isOpen)
        throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', { documentId });
    }
    return [...new Set(documents)];
  };

  return {
    sync() {
      void sync().catch(() => undefined);
    },

    stateOf(documentId) {
      const synced = syncStateOf(store.payload, documentId);
      return synced === 'failed' ? 'excluded' : synced;
    },

    async search(rawParams) {
      const params = searchParamsSchema.parse(rawParams);
      if (codePointLength(params.query) > LIMITS.searchQueryCodePoints) {
        throw new VdeError('E_INVALID_ARGUMENT', 'queryが長すぎます。', {
          limit: 'searchQueryCodePoints',
          max: LIMITS.searchQueryCodePoints,
        });
      }
      if (uniqueTokens(params.query).length > LIMITS.searchTerms) {
        throw new VdeError('E_INVALID_ARGUMENT', '検索語が多すぎます。', {
          limit: 'searchTerms',
          max: LIMITS.searchTerms,
        });
      }
      // cursorは、発行したときのquery・条件・一覧の版・hitの並びにだけ使える。
      const signature = createHash('sha256')
        .update(
          JSON.stringify([params.query, params.mode, params.limit, params.documents.toSorted()]),
        )
        .digest('hex');
      let resume: { catalogVersion: number; digest: string; offset: number } | null = null;
      if (params.cursor !== undefined) {
        const payload = cursors.decode(params.cursor, 'search');
        if (payload['signature'] !== signature) {
          throw new VdeError(
            'E_INVALID_CURSOR',
            'cursorが別の検索のものです。最初から検索し直してください。',
            { reason: 'query' },
          );
        }
        resume = {
          catalogVersion: payload['catalogVersion'] as number,
          digest: payload['digest'] as string,
          offset: payload['offset'] as number,
        };
        if (resume.catalogVersion !== store.payload.catalogVersion) {
          throw staleCursor('catalog', store.payload.catalogVersion);
        }
      }

      // 検索は、始めた時点の一覧に対して行う。indexがその状態へ追い付くのを待つのは、
      // 検索を始めてから決まった時間まで（やり直しの分も含める）。
      // indexへは小さく分けて入れているので、待った後の検索は、入れている途中の1回分しか待たない。
      const deadline = Date.now() + LIMITS.searchIndexWaitMs;
      let state = store.payload;
      let hits: SearchHit[] = [];
      let dropped = false;
      // 続きの取得では、やり直さない。変わっていたら、最初からの検索を求める。
      const attempts = resume === null ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        state = store.payload;
        const targets = targetsOf(state, params.documents);
        void sync().catch(() => undefined);
        while (!settled(store.payload, targets) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
        }
        let found: SearchHit[];
        try {
          found = await request<SearchHit[]>({
            op: 'search',
            query: params.query,
            mode: params.mode,
            documents: params.documents.length === 0 ? null : targets,
          });
        } catch (error) {
          if (error instanceof VdeError && error.code === 'E_DAEMON_STOPPING') throw error;
          throw new VdeError(
            'E_INDEX_NOT_READY',
            '検索のindexを使えません。',
            {},
            { cause: error },
          );
        }
        // 返す前に、いまの状態で確かめる。閉じた文書、版が変わった文書、titleやpathが変わった文書のhitは返さない。
        const current = store.payload;
        hits = found.filter((hit) => {
          const record = current.documents[hit.documentId];
          return (
            searchable(record) &&
            record.currentRevision === hit.revision &&
            record.title === hit.title &&
            record.displayPath === hit.displayPath
          );
        });
        dropped = hits.length !== found.length || current.catalogVersion !== state.catalogVersion;
        state = current;
        // 検索している間に状態が変わった。1回だけやり直す。
        if (!dropped) break;
      }

      if (resume !== null) {
        // 検索を待っている間に一覧が変わった、または、hitの並びが前のページを返したときと違う。
        if (dropped || state.catalogVersion !== resume.catalogVersion) {
          throw staleCursor('catalog', state.catalogVersion);
        }
        if (digestOf(hits) !== resume.digest) throw staleCursor('results', state.catalogVersion);
      }

      const targets = targetsOf(state, params.documents);
      const failedDocuments: SearchResult['failedDocuments'] = [];
      const indexingDocuments: string[] = [];
      let searchedDocuments = 0;
      for (const documentId of targets) {
        const record = state.documents[documentId];
        if (!record) continue;
        if (record.sourceState !== 'ready') {
          // 読めなくなった文書の、前の内容を、いまの検索結果として返さない。
          failedDocuments.push({ documentId, code: `source-${record.sourceState}` });
          continue;
        }
        const synced = syncStateOf(state, documentId);
        if (synced === 'indexing') indexingDocuments.push(documentId);
        else if (synced === 'failed') {
          failedDocuments.push({
            documentId,
            code: indexed.get(documentId)?.code ?? 'E_PARSE_FAILED',
          });
        } else searchedDocuments += 1;
      }
      // 対象の文書が1件も検索できなかった。0件の結果は、「見つからなかった」と区別できないので返さない。
      if (targets.length > 0 && searchedDocuments === 0) {
        throw new VdeError('E_INDEX_NOT_READY', '検索できる文書がありません。', {
          failedDocuments,
          indexingDocuments,
        });
      }

      // hitは分割しない。件数と、配列のJSON表現の大きさの、どちらかの上限まで返す。
      const offset = resume?.offset ?? 0;
      const page: SearchHit[] = [];
      let bytes = 2;
      for (const hit of hits.slice(offset)) {
        if (page.length >= params.limit) break;
        const size = byteLengthOfJson(hit) + (page.length > 0 ? 1 : 0);
        if (bytes + size > params.maxBytes) {
          if (page.length === 0) {
            throw new VdeError(
              'E_MAX_BYTES_TOO_SMALL',
              '--max-bytesが小さく、1件目の結果を返せません。',
              { requiredBytes: bytes + size },
            );
          }
          break;
        }
        page.push(hit);
        bytes += size;
      }
      const next = offset + page.length;
      const truncated = next < hits.length;
      return {
        data: {
          query: params.query,
          mode: params.mode,
          catalogVersion: state.catalogVersion,
          registeredDocuments: targets.length,
          searchedDocuments,
          indexedAt,
          incomplete: dropped || failedDocuments.length > 0 || indexingDocuments.length > 0,
          failedDocuments,
          indexingDocuments,
          hits: page,
          truncated,
          nextCursor: truncated
            ? cursors.encode({
                op: 'search',
                signature,
                catalogVersion: state.catalogVersion,
                digest: digestOf(hits),
                offset: next,
              })
            : null,
        },
        catalogVersion: state.catalogVersion,
        warnings: [],
      };
    },

    async close() {
      closed = true;
      failAll(new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
