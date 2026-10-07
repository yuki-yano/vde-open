import { Worker } from 'node:worker_threads';

import type { DocumentAnalysis } from '@vde-open/document';
import type { HtmlPrintInput, HtmlPrintOutput, PrintInput } from '@vde-open/document/print';
import type {
  RenderInput,
  RenderOutput,
  ScanKind,
  ScannedReference,
} from '@vde-open/document/render';
import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';

import type { WorkerDiagnostics } from '../diagnostics/heap.ts';
import { createWorkerCollect } from '../diagnostics/idle-collect.ts';
import { untilAborted } from '../diagnostics/until-aborted.ts';
import { parseWorkerPath } from '../entry-paths.ts';
import type { ParseRequest } from './parse-worker.ts';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; reason: string };

// The id is attached when sending.
type ParseWork = ParseRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export interface ParseService {
  // The worker's heap (used for resource leak checks; daemon.diagnostics). Null when there is no worker.
  // If the signal is aborted (the daemon is stopping), ends with E_DAEMON_STOPPING without waiting for queued parses.
  diagnostics(collectGarbage: boolean, signal?: AbortSignal): Promise<WorkerDiagnostics | null>;
  analyze(format: DocumentFormat, text: string): Promise<DocumentAnalysis>;
  // Collects candidate local files referenced by the document or CSS.
  scan(kind: ScanKind, text: string): Promise<ScannedReference[]>;
  // Transforms for display (static HTML transform, CSS reference checks, link extraction).
  render(input: RenderInput): Promise<RenderOutput>;
  // The print document (one HTML document) of a Markdown revision, for the PDF export.
  // The daemon runs it on a worker of its own, so a long print never shares a time limit with parsing.
  print(input: PrintInput): Promise<string>;
  printHtml(input: HtmlPrintInput): Promise<HtmlPrintOutput>;
  close(): Promise<void>;
}

export interface ParseServiceOptions {
  timeoutMs?: number;
  workerPath?: string;
}

// Parsing runs sequentially on a single worker. If it does not finish in time, the whole worker is
// stopped and recreated, so a document that never finishes parsing does not stop the daemon (spec 8.1).
export function createParseService(options: ParseServiceOptions = {}): ParseService {
  const timeoutMs = options.timeoutMs ?? LIMITS.parseTimeoutMs;
  const workerPath = options.workerPath ?? parseWorkerPath();
  let worker: Worker | null = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  // Parsing leaves garbage in the worker, and an idle worker does not collect it on its own.
  // Once requests pause, ask it to collect once (parses made meanwhile wait and keep their full time limit).
  const collector = createWorkerCollect({
    worker: () => worker,
    busy: () => pending.size > 0,
    nextId: () => {
      const id = nextId;
      nextId += 1;
      return id;
    },
  });

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  const discardWorker = () => {
    const current = worker;
    worker = null;
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
      else {
        waiter.reject(
          new VdeError('E_PARSE_FAILED', 'The document could not be parsed.', {
            reason: reply.reason,
          }),
        );
      }
    });
    created.on('error', () => {
      if (worker === created) worker = null;
      failAll(
        new VdeError('E_PARSE_FAILED', 'The document could not be parsed.', { reason: 'worker' }),
      );
      collector.reset();
    });
    worker = created;
    return created;
  };

  const request = <T>(work: ParseWork): Promise<T> => {
    if (closed) {
      return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
    }
    const result = new Promise<T>((resolve, reject) => {
      collector.dispatch(() => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          // A timed-out parse stops and reclaims the worker. Other waiting parses must be retried too.
          discardWorker();
          failAll(
            new VdeError('E_PARSE_FAILED', 'Parsing the document did not finish in time.', {
              reason: 'timeout',
              timeoutMs,
            }),
          );
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
        ensureWorker().postMessage({ id, ...work });
      }, reject);
    });
    if (work.op !== 'diagnostics') void result.then(collector.touch, collector.touch);
    return result;
  };

  return {
    diagnostics: (collectGarbage, signal) =>
      worker === null
        ? Promise.resolve(null)
        : untilAborted(request<WorkerDiagnostics>({ op: 'diagnostics', collectGarbage }), signal),
    analyze: (format, text) => request({ op: 'analyze', format, text }),
    scan: (kind, text) => request({ op: 'scan', kind, text }),
    render: (input) => request({ op: 'render', input }),
    print: (input) => request({ op: 'print', input }),
    printHtml: (input) => request({ op: 'printHtml', input }),
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
