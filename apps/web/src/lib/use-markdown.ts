import type { parseMarkdownDocument } from '@vde-open/document';
import { useEffect, useState } from 'react';

type MarkdownDocument = ReturnType<typeof parseMarkdownDocument>;

// 解析を待つ上限（仕様7.4）。超えたらworkerを止めて、原文の表示へ切り替える。
const PARSE_TIMEOUT_MS = 2000;

export type MarkdownState =
  | { status: 'parsing' }
  | { status: 'ready'; document: MarkdownDocument }
  | { status: 'failed'; reason: string };

type WorkerReply =
  | { id: number; ok: true; document: MarkdownDocument }
  | { id: number; ok: false; reason: string };

interface Parsed {
  source: string;
  state: MarkdownState;
}

export function useMarkdown(source: string | null): MarkdownState {
  const [parsed, setParsed] = useState<Parsed | null>(null);

  useEffect(() => {
    if (source === null) return undefined;
    // 文書ごとにworkerを作る。時間切れや切り替えのときは、workerごと止めて回収する。
    const worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    const finish = (state: MarkdownState) => {
      clearTimeout(timer);
      worker.terminate();
      setParsed({ source, state });
    };
    const timer = setTimeout(
      () => finish({ status: 'failed', reason: 'timeout' }),
      PARSE_TIMEOUT_MS,
    );
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      finish(
        event.data.ok
          ? { status: 'ready', document: event.data.document }
          : { status: 'failed', reason: event.data.reason },
      );
    });
    worker.addEventListener('error', () => finish({ status: 'failed', reason: 'parse-error' }));
    worker.postMessage({ id: 1, source });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [source]);

  // 解析結果は、解析した原文にだけ結び付ける。別の原文の結果は使わない。
  return parsed !== null && parsed.source === source ? parsed.state : { status: 'parsing' };
}
