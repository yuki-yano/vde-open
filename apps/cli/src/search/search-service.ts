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

import type { WorkerDiagnostics } from '../diagnostics/heap.ts';
import { createWorkerCollect } from '../diagnostics/idle-collect.ts';
import { untilAborted } from '../diagnostics/until-aborted.ts';
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
  // Updates the index to the current document state. Called on every change notification.
  sync(): void;
  search(rawParams: unknown): Promise<ServiceResult<SearchResult>>;
  // Per-document search state shown in the list.
  stateOf(documentId: string): DocumentSearchState;
  // Counts of retained entries (used to check for resource leaks; daemon.diagnostics).
  retainedCounts(): Record<string, number>;
  // Returns the worker heap and the counts of entries the index retains. null if there is no worker.
  // With collectGarbage, first syncs the index to the current document state, then cleans up and runs GC in the worker before measuring
  // (for leak checks; other diagnostics do not trigger work such as syncing).
  // If the signal is aborted (the daemon is stopping), stops waiting and fails with E_DAEMON_STOPPING.
  diagnostics(collectGarbage: boolean, signal?: AbortSignal): Promise<WorkerDiagnostics | null>;
  close(): Promise<void>;
}

export interface SearchServiceOptions {
  store: StateStore;
  cursors: CursorCodec;
  now?: () => Date;
  workerPath?: string;
  // Max wait per request. When exceeded, the worker is stopped and recreated.
  timeoutMs?: number;
  // Analysis that splits documents into sections. The daemon offloads it to the parse worker (so heavy analysis does not block the search worker).
  // Without it, analysis runs on this thread.
  analyze?: (format: DocumentFormat, text: string) => Promise<DocumentAnalysis>;
}

// Index state of one document. revision is the revision indexed (or attempted).
// metaKey is the indexed title, path, and order. If it changes, the document is re-indexed even with the same content.
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
// Amount indexed per request. Kept small so search requests can interleave.
// The weight is the length of the indexed fields (body and heading) in UTF-16 code units.
const APPEND_BATCH_WEIGHT = 65_536;
// Number of parts per request. Keeps each request small even for documents with many short sections.
const APPEND_BATCH_PARTS = 256;

// Only open documents whose current content is readable are searchable (spec 9.1, 8.5).
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

// The order of hits. A cursor continues only if this order is unchanged (never silently returns gaps or duplicates).
function digestOf(hits: SearchHit[]): string {
  const hash = createHash('sha256');
  for (const hit of hits) hash.update(`${hit.documentId}\0${hit.revision}\0${hit.sectionId}\n`);
  return hash.digest('hex');
}

function staleCursor(reason: 'catalog' | 'results', catalogVersion: number): VdeError {
  return new VdeError(
    'E_CURSOR_STALE',
    'The search targets or results have changed. Search again from the start.',
    { reason, catalogVersion, restart: true },
  );
}

function analyzeInProcess(format: DocumentFormat, text: string): Promise<DocumentAnalysis> {
  try {
    return Promise.resolve(analyzeDocument(text, format));
  } catch (error) {
    return Promise.reject(
      new VdeError('E_PARSE_FAILED', 'The document could not be analyzed.', {
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
  // Documents the worker may hold (being added or committed). Kept separately from the indexing records (indexed).
  const resident = new Set<string>();
  const pending = new Map<number, Pending>();
  let worker: Worker | null = null;
  let nextId = 1;
  let closed = false;
  let indexedAt = now().toISOString();
  // Index updates run one at a time. A request during a run triggers exactly one more run afterwards.
  let syncing: Promise<void> | null = null;
  // Indexing and searching leave a lot of garbage in the worker, and an idle worker does not collect it
  // on its own (about half of its heap after indexing many documents). Once requests pause, ask it to
  // collect once (requests made meanwhile wait and keep their full time limit).
  const collector = createWorkerCollect({
    worker: () => worker,
    busy: () => pending.size > 0,
    nextId: () => {
      const id = nextId;
      nextId += 1;
      return id;
    },
  });
  let syncRequested = false;

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  // Stops the worker. The index lives in the worker, so every document is re-indexed afterwards.
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
      if (collector.settle(reply.id)) return;
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply.result);
      else
        waiter.reject(
          new VdeError('E_INDEX_NOT_READY', 'The search index could not be updated.', {
            reason: reply.reason,
          }),
        );
    });
    created.on('error', () => {
      if (worker === created) discardWorker();
      failAll(new VdeError('E_INDEX_NOT_READY', 'The search index is not available.'));
      collector.reset();
    });
    worker = created;
    return created;
  };

  const request = <T>(work: Work): Promise<T> => {
    if (closed) return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
    const result = new Promise<T>((resolve, reject) => {
      collector.dispatch(() => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          // A request that never finishes is reclaimed by stopping the whole worker.
          pending.delete(id);
          discardWorker();
          failAll(new VdeError('E_INDEX_NOT_READY', 'The search index is not available.'));
          reject(
            new VdeError(
              'E_INDEX_NOT_READY',
              'The search index operation did not finish in time.',
              { reason: 'timeout' },
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
        ensureWorker().postMessage({ id, ...work });
      }, reject);
    });
    if (work.op !== 'diagnostics') void result.then(collector.touch, collector.touch);
    return result;
  };

  // The parse worker is recreated when another document's analysis times out, and every waiting analysis fails too.
  // Retry once so this document is not recorded as unanalyzable because of that.
  const analyzeOnce = async (format: DocumentFormat, text: string): Promise<DocumentAnalysis> => {
    try {
      return await analyze(format, text);
    } catch (error) {
      const reason = error instanceof VdeError ? error.details['reason'] : undefined;
      if (reason !== 'timeout' && reason !== 'worker') throw error;
      return analyze(format, text);
    }
  };

  // Analyzes the document and adds its content to the index in several steps.
  // Search requests can interleave between steps (keeps each worker busy period short).
  const reindex = async (entry: RevisionRecord, meta: IndexedMeta): Promise<void> => {
    const { documentId, revision } = meta;
    const metaKey = metaKeyOf(meta);
    // Whether the document was closed or advanced while being added. Also stops if the worker was recreated.
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
    // Stops midway. Discards the partial content and removes this indexing record (the next sync re-indexes).
    const giveUp = async (begun: boolean) => {
      if (begun) await request({ op: 'abort', documentId }).catch(() => undefined);
      if (indexed.get(documentId) === attempt) indexed.delete(documentId);
    };
    try {
      const text =
        entry.format === 'image' ? '' : (await store.readBlob(entry.sourceSha256)).toString('utf8');
      const { sections } = await analyzeOnce(entry.format, text);
      if (!current()) {
        await giveUp(false);
        return;
      }
      // The worker may now hold this document. Remember it so a close removes it, including committed content.
      resident.add(documentId);
      await request({ op: 'begin', meta });
      // Each request is bounded by the indexed field length and the number of parts.
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
      // If the worker was stopped, indexed is empty. Record only this document as failed.
      indexed.set(documentId, { revision, metaKey, state: 'failed', code });
    }
  };

  // Compares state with the index and applies the differences one at a time.
  const syncOnce = async (): Promise<void> => {
    const state = store.payload;
    // Removes documents that are no longer searchable from the worker. Committed content may remain in the worker
    // even after the indexing record is removed, so documents the worker may hold are checked too.
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
      // Syncs run one at a time, so an "indexing" record here belongs to an indexing that did not finish. Re-index.
      if (known && known.revision === revision && known.state !== 'indexing') {
        if (known.metaKey === metaKey) continue;
        if (known.state === 'failed') {
          // A revision that could not be analyzed is not re-indexed when title etc. change (stays failed until the revision changes).
          known.metaKey = metaKey;
          continue;
        }
        // Only title, path, or order changed. Update the attributes without re-indexing the content.
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

  // Index state of a document. 'ready' if it has caught up with the current revision and attributes (title, path, order).
  // The same check is used for waiting, result aggregation, and the list display.
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

  // Whether the index of the target documents has caught up with the current revision and attributes (unanalyzable documents are not waited for).
  const settled = (state: StatePayload, targets: string[]): boolean =>
    targets.every((documentId) => syncStateOf(state, documentId) !== 'indexing');

  const targetsOf = (state: StatePayload, documents: string[]): string[] => {
    if (documents.length === 0) return [...state.openOrder];
    for (const documentId of documents) {
      const record = state.documents[documentId];
      if (!record)
        throw new VdeError('E_DOCUMENT_NOT_FOUND', 'The document was not found.', { documentId });
      // A closed document cannot be a search target.
      if (!record.isOpen)
        throw new VdeError('E_DOCUMENT_NOT_OPEN', 'The document is not open.', { documentId });
    }
    return [...new Set(documents)];
  };

  return {
    retainedCounts() {
      return { indexed: indexed.size, resident: resident.size, pending: pending.size };
    },
    diagnostics(collectGarbage, signal) {
      // Both the index sync and the worker reply (waiting for cleanup) can be abandoned on shutdown.
      const work = (collectGarbage ? sync() : Promise.resolve()).then(() =>
        worker === null || signal?.aborted === true
          ? null
          : request<WorkerDiagnostics>({ op: 'diagnostics', collectGarbage }),
      );
      return untilAborted(work, signal);
    },
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
        throw new VdeError('E_INVALID_ARGUMENT', 'The query is too long.', {
          limit: 'searchQueryCodePoints',
          max: LIMITS.searchQueryCodePoints,
        });
      }
      if (uniqueTokens(params.query).length > LIMITS.searchTerms) {
        throw new VdeError('E_INVALID_ARGUMENT', 'Too many search terms.', {
          limit: 'searchTerms',
          max: LIMITS.searchTerms,
        });
      }
      // A cursor is valid only for the query, options, catalog version, and hit order it was issued with.
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
            'The cursor belongs to another search. Search again from the start.',
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

      // The search runs against the list as of when it started. Waiting for the index to catch up is bounded
      // by a fixed time from the start of the search (including retries).
      // Indexing is done in small steps, so after the wait the search waits for at most one in-progress step.
      const deadline = Date.now() + LIMITS.searchIndexWaitMs;
      let state = store.payload;
      let hits: SearchHit[] = [];
      let dropped = false;
      // Continuations are not retried. If anything changed, a fresh search is required.
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
            'The search index is not available.',
            {},
            { cause: error },
          );
        }
        // Check against the current state before returning. Hits from closed documents or documents whose revision, title, or path changed are dropped.
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
        // The state changed during the search. Retry once.
        if (!dropped) break;
      }

      if (resume !== null) {
        // The list changed while waiting, or the hit order differs from when the previous page was returned.
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
          // Old content of a document that became unreadable is not returned as a current result.
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
      // None of the target documents could be searched. An empty result would be indistinguishable from "not found", so fail instead.
      if (targets.length > 0 && searchedDocuments === 0) {
        throw new VdeError('E_INDEX_NOT_READY', 'No documents can be searched.', {
          failedDocuments,
          indexingDocuments,
        });
      }

      // Hits are not split. Returns up to either the count limit or the JSON size limit of the array.
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
              '--max-bytes is too small to return the first result.',
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
      collector.close(new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
      failAll(new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
