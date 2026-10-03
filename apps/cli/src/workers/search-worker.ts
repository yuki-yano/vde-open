// A worker that holds the search index. It receives parsed sections as data and puts them into the index.
// Documents are not parsed here (so heavy parsing never delays search requests).
import { parentPort } from 'node:worker_threads';

import type { SearchMode } from '@vde-open/shared';

import { collectGarbage, measureHeap, type WorkerDiagnostics } from '../diagnostics/heap.ts';
import { SearchIndex, type IndexedMeta, type IndexPart } from '../search/search-index.ts';

export type SearchWorkerRequest =
  | { id: number; op: 'begin'; meta: IndexedMeta }
  | { id: number; op: 'append'; documentId: string; revision: string; parts: IndexPart[] }
  | { id: number; op: 'commit'; documentId: string; revision: string }
  | { id: number; op: 'abort'; documentId: string }
  | { id: number; op: 'meta'; meta: IndexedMeta }
  | { id: number; op: 'remove'; documentId: string }
  | { id: number; op: 'search'; query: string; mode: SearchMode; documents: string[] | null }
  | { id: number; op: 'diagnostics'; collectGarbage: boolean }
  | { id: number; op: 'collect' };

const index = new SearchIndex();

async function diagnostics(collect: boolean): Promise<WorkerDiagnostics> {
  const retained = await index.retainedCounts(collect);
  return { heapUsedBytes: measureHeap(collect), retained };
}

function run(request: SearchWorkerRequest): unknown {
  switch (request.op) {
    case 'diagnostics':
      return diagnostics(request.collectGarbage);
    // Indexing leaves a lot of garbage, and an idle worker does not collect it on its own.
    case 'collect':
      collectGarbage();
      return null;
    case 'begin':
      index.begin(request.meta);
      return null;
    case 'append':
      index.append(request.documentId, request.revision, request.parts);
      return null;
    case 'commit':
      index.commit(request.documentId, request.revision);
      return null;
    case 'abort':
      index.abort(request.documentId);
      return null;
    case 'meta':
      return index.updateMeta(request.meta);
    case 'remove':
      index.remove(request.documentId);
      return null;
    case 'search':
      return index.search({
        query: request.query,
        mode: request.mode,
        documents: request.documents === null ? null : new Set(request.documents),
      });
  }
}

parentPort?.on('message', (request: SearchWorkerRequest) => {
  let result: unknown;
  try {
    result = run(request);
  } catch {
    parentPort?.postMessage({ id: request.id, ok: false, reason: 'index-error' });
    return;
  }
  // Only diagnostics wait for cleanup before replying (every other operation replies immediately).
  if (result instanceof Promise) {
    result.then(
      (value: unknown) => parentPort?.postMessage({ id: request.id, ok: true, result: value }),
      () => parentPort?.postMessage({ id: request.id, ok: false, reason: 'index-error' }),
    );
    return;
  }
  parentPort?.postMessage({ id: request.id, ok: true, result });
});
