import { Worker } from 'node:worker_threads';

import type { DocumentAnalysis } from '@vde-open/document';
import type {
  RenderInput,
  RenderOutput,
  ScanKind,
  ScannedReference,
} from '@vde-open/document/render';
import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';

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

// idは送るときに付ける。
type ParseWork = ParseRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export interface ParseService {
  analyze(format: DocumentFormat, text: string): Promise<DocumentAnalysis>;
  // 文書やCSSが参照するlocal fileの候補を集める。
  scan(kind: ScanKind, text: string): Promise<ScannedReference[]>;
  // 表示するための変換（HTMLの静的変換、CSSの参照の検査、linkの抽出）。
  render(input: RenderInput): Promise<RenderOutput>;
  close(): Promise<void>;
}

export interface ParseServiceOptions {
  timeoutMs?: number;
  workerPath?: string;
}

// 解析は1つのworkerで順に行う。時間内に終わらなければworkerごと止めて作り直すので、
// 解析が終わらない文書があっても、daemonは止まらない（仕様8.1）。
export function createParseService(options: ParseServiceOptions = {}): ParseService {
  const timeoutMs = options.timeoutMs ?? LIMITS.parseTimeoutMs;
  const workerPath = options.workerPath ?? parseWorkerPath();
  let worker: Worker | null = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();

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
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply.result);
      else {
        waiter.reject(
          new VdeError('E_PARSE_FAILED', '文書を解析できませんでした。', { reason: reply.reason }),
        );
      }
    });
    created.on('error', () => {
      if (worker === created) worker = null;
      failAll(new VdeError('E_PARSE_FAILED', '文書を解析できませんでした。', { reason: 'worker' }));
    });
    worker = created;
    return created;
  };

  const request = <T>(work: ParseWork): Promise<T> => {
    if (closed) {
      return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
    }
    return new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        // 時間切れの解析は、workerを止めて回収する。待っている他の解析もやり直しになる。
        discardWorker();
        failAll(
          new VdeError('E_PARSE_FAILED', '文書の解析が時間内に終わりませんでした。', {
            reason: 'timeout',
            timeoutMs,
          }),
        );
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      ensureWorker().postMessage({ id, ...work });
    });
  };

  return {
    analyze: (format, text) => request({ op: 'analyze', format, text }),
    scan: (kind, text) => request({ op: 'scan', kind, text }),
    render: (input) => request({ op: 'render', input }),
    async close() {
      closed = true;
      failAll(new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
