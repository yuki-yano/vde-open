// Parse Markdown off the UI thread. The source is received only as data; scripts in the document never run.
import { parseMarkdownDocument, ParseLimitError } from '@vde-open/document';

interface ParseRequest {
  id: number;
  source: string;
}

self.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, source } = event.data;
  try {
    self.postMessage({ id, ok: true, document: parseMarkdownDocument(source) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      reason: error instanceof ParseLimitError ? `limit-${error.limit}` : 'parse-error',
    });
  }
});
