import type { parseMarkdownDocument } from '@vde-open/document';
import { useEffect, useState } from 'react';

type MarkdownDocument = ReturnType<typeof parseMarkdownDocument>;

// Maximum time to wait for parsing (spec 7.4). Beyond it, stop the worker and switch to the Source view.
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
    // Create a worker per document. On timeout or switch, terminate the whole worker and reclaim it.
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

  // A parse result is tied only to the source it was parsed from. A result for another source is not used.
  return parsed !== null && parsed.source === source ? parsed.state : { status: 'parsing' };
}
