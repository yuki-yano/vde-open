// A worker that parses document structure. It only receives the source as data; it never runs JS or imports in the document.
import { parentPort } from 'node:worker_threads';

import { analyzeDocument, ParseLimitError } from '@vde-open/document';
import {
  renderDocument,
  scanReferences,
  type RenderInput,
  type ScanKind,
} from '@vde-open/document/render';

import { measureHeap } from '../diagnostics/heap.ts';

export type ParseRequest =
  | { id: number; op: 'analyze'; format: 'markdown' | 'html'; text: string }
  | { id: number; op: 'scan'; kind: ScanKind; text: string }
  | { id: number; op: 'render'; input: RenderInput }
  | { id: number; op: 'diagnostics'; collectGarbage: boolean };

function run(request: ParseRequest): unknown {
  // The parse worker keeps no state between requests. Returns only the heap.
  if (request.op === 'diagnostics') {
    return { heapUsedBytes: measureHeap(request.collectGarbage), retained: {} };
  }
  if (request.op === 'analyze') return analyzeDocument(request.text, request.format);
  if (request.op === 'scan') return scanReferences(request.kind, request.text);
  return renderDocument(request.input);
}

parentPort?.on('message', (request: ParseRequest) => {
  try {
    parentPort?.postMessage({ id: request.id, ok: true, result: run(request) });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      reason: error instanceof ParseLimitError ? `limit-${error.limit}` : 'parse-error',
    });
  }
});
