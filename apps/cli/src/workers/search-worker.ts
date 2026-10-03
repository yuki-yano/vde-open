// 検索indexを持つworker。解析済みの節をdataとして受け取り、indexへ入れる。
// 文書の解析はここでは行わない（重い解析で、検索の依頼を待たせない）。
import { parentPort } from 'node:worker_threads';

import type { SearchMode } from '@vde-open/shared';

import { SearchIndex, type IndexedMeta, type IndexPart } from '../search/search-index.ts';

export type SearchWorkerRequest =
  | { id: number; op: 'begin'; meta: IndexedMeta }
  | { id: number; op: 'append'; documentId: string; revision: string; parts: IndexPart[] }
  | { id: number; op: 'commit'; documentId: string; revision: string }
  | { id: number; op: 'abort'; documentId: string }
  | { id: number; op: 'meta'; meta: IndexedMeta }
  | { id: number; op: 'remove'; documentId: string }
  | { id: number; op: 'search'; query: string; mode: SearchMode; documents: string[] | null };

const index = new SearchIndex();

function run(request: SearchWorkerRequest): unknown {
  switch (request.op) {
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
  try {
    parentPort?.postMessage({ id: request.id, ok: true, result: run(request) });
  } catch {
    parentPort?.postMessage({ id: request.id, ok: false, reason: 'index-error' });
  }
});
