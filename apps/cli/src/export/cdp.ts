import type { Readable, Writable } from 'node:stream';

// A minimal Chrome DevTools Protocol client over the pipe a browser opens with --remote-debugging-pipe
// (it reads commands from fd 3 and writes replies and events to fd 4, each message as JSON followed by NUL).
export interface CdpConnection {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  // The params of the next event with this method in the session that `accept` accepts.
  // Register before the command that causes it.
  waitFor<T>(method: string, sessionId: string, accept: (params: T) => boolean): Promise<T>;
  // Rejects every pending command and event wait. Later sends reject at once.
  close(error: Error): void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

// The largest message read from the browser. The PDF arrives in chunks of 1 MiB (base64), far below it.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class CdpError extends Error {
  readonly method: string;

  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.method = method;
  }
}

export function connectCdp(toBrowser: Writable, fromBrowser: Readable): CdpConnection {
  let nextId = 1;
  let failure: Error | null = null;
  const pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const waiters: Array<{
    method: string;
    sessionId: string;
    accept: (params: unknown) => boolean;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  let chunks: Buffer[] = [];
  let buffered = 0;

  const close = (error: Error) => {
    if (failure !== null) return;
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  const dispatch = (message: CdpMessage) => {
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new CdpError(waiter.method, message.error.message ?? 'failed'));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    const index = waiters.findIndex(
      (waiter) =>
        waiter.method === message.method &&
        waiter.sessionId === message.sessionId &&
        waiter.accept(message.params),
    );
    if (index === -1) return;
    const [waiter] = waiters.splice(index, 1);
    waiter?.resolve(message.params);
  };

  fromBrowser.on('data', (chunk: Buffer) => {
    if (failure !== null) return;
    let start = 0;
    let end = chunk.indexOf(0, start);
    // A message the browser should never send (too large, not JSON) ends the connection instead of the daemon.
    try {
      while (end !== -1) {
        chunks.push(chunk.subarray(start, end));
        const text = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        buffered = 0;
        dispatch(JSON.parse(text) as CdpMessage);
        start = end + 1;
        end = chunk.indexOf(0, start);
      }
      if (start < chunk.length) {
        chunks.push(chunk.subarray(start));
        buffered += chunk.length - start;
        if (buffered > MAX_MESSAGE_BYTES) throw new Error('message too large');
      }
    } catch {
      chunks = [];
      close(new CdpError('protocol', 'the browser sent a message that cannot be read'));
    }
  });
  // The pipe ends when the browser exits. Its owner reports why; here only the waits end.
  fromBrowser.on('error', () => undefined);
  toBrowser.on('error', () => undefined);

  return {
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (failure !== null) return Promise.reject(failure);
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        toBrowser.write(
          `${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`,
        );
      });
    },
    waitFor<T>(method: string, sessionId: string, accept: (params: T) => boolean) {
      if (failure !== null) return Promise.reject(failure);
      return new Promise<T>((resolve, reject) => {
        waiters.push({
          method,
          sessionId,
          accept: accept as (params: unknown) => boolean,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },
    close,
  };
}
