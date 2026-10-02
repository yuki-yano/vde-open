// 文書の構造を解析するworker。原文をdataとして受け取るだけで、文書中のJSやimportは実行しない。
import { parentPort } from 'node:worker_threads';

import { analyzeDocument, ParseLimitError } from '@vde-open/document';

interface ParseRequest {
  id: number;
  format: 'markdown' | 'html';
  text: string;
}

parentPort?.on('message', (request: ParseRequest) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      analysis: analyzeDocument(request.text, request.format),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      reason: error instanceof ParseLimitError ? `limit-${error.limit}` : 'parse-error',
    });
  }
});
