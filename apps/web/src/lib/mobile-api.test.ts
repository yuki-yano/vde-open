import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMobileApi, SILENCE_LIMIT_MS } from './mobile-api.ts';

// One notification stream the test writes to, and whether the client gave up on it.
function streamResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let aborted = false;
  const encoder = new TextEncoder();
  return {
    respond(signal: AbortSignal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        controller?.error(new DOMException('aborted', 'AbortError'));
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
    write(text: string) {
      controller?.enqueue(encoder.encode(text));
    },
    get aborted() {
      return aborted;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the phone notification stream', () => {
  it('counts heartbeat comments as received, and drops the connection after 35 s of silence', async () => {
    expect(SILENCE_LIMIT_MS).toBe(35_000);
    const first = streamResponse();
    let connections = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        connections += 1;
        return Promise.resolve(
          connections === 1
            ? first.respond(init.signal as AbortSignal)
            : streamResponse().respond(init.signal as AbortSignal),
        );
      }),
    );
    const events: string[] = [];
    const stream = createMobileApi().events({
      onConnect: () => events.push('connect'),
      onEvent: (event) => events.push(event.type),
      onDisconnect: () => events.push('disconnect'),
    });
    await vi.advanceTimersByTimeAsync(0);
    first.write('event: hello\ndata: {"type":"hello","daemonId":"d1"}\n\n');
    await vi.advanceTimersByTimeAsync(30_000);
    // A heartbeat comment carries no event but proves the stream is alive.
    first.write(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.aborted).toBe(false);
    expect(events).toEqual(['connect', 'hello']);
    // Nothing for 35 seconds: the connection is dropped (input to a demo stops) and a new one is made.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(first.aborted).toBe(true);
    expect(events).toContain('disconnect');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connections).toBe(2);
    stream.close();
  });
});
