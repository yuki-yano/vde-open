import { describe, expect, it } from 'vitest';

import { createSseParser, type SseMessage } from './sse.ts';

function parse(chunks: Uint8Array[]): SseMessage[] {
  const messages: SseMessage[] = [];
  const parser = createSseParser((message) => messages.push(message));
  for (const chunk of chunks) parser.push(chunk);
  return messages;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SSE parsing', () => {
  it('combines event, id, and multi-line data into one message', () => {
    expect(parse([bytes('event: hello\nid: 3\ndata: {"a":1,\ndata: "b":2}\n\n')])).toEqual([
      { event: 'hello', data: '{"a":1,\n"b":2}', id: '3' },
    ]);
  });

  it('ignores comment heartbeats and handles CRLF and CR line endings', () => {
    expect(
      parse([bytes(': heartbeat\r\n\r\nevent: a\r\ndata: 1\r\n\r\ndata: 2\r\rdata: 3\n\n')]),
    ).toEqual([
      { event: 'a', data: '1', id: null },
      { event: 'message', data: '2', id: null },
      { event: 'message', data: '3', id: null },
    ]);
  });

  it('correctly joins UTF-8 split across chunks and a line ending split between CR and LF', () => {
    const whole = bytes('event: document-changed\r\ndata: {"title":"認証仕様"}\r\n\r\n');
    for (let split = 1; split < whole.length; split += 1) {
      expect(parse([whole.slice(0, split), whole.slice(split)])).toEqual([
        { event: 'document-changed', data: '{"title":"認証仕様"}', id: null },
      ]);
    }
  });
});
