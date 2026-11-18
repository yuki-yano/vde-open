import type { HttpBindings } from '@hono/node-server';
import { LIMITS, type ServerEvent } from '@vde-open/shared';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { createEventQueue } from './event-queue.ts';

export interface EventStreamOptions {
  // The first event of every connection. The receiver resyncs from here.
  hello: ServerEvent;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  // The SSE frame for an event. null skips it (the receiver does not need it).
  frame: (event: ServerEvent) => { event: string; id?: string; data: string } | null;
  // Interval for checking the connection. Defaults to `LIMITS.sseHeartbeatMs`.
  heartbeatMs?: number | undefined;
  // Time until a connection whose writes make no progress is cut. Defaults to `LIMITS.sseStallMs`.
  stallMs?: number | undefined;
}

export interface EventStreams {
  // A notification stream for one request (spec 6.5).
  open(c: Context<{ Bindings: Partial<HttpBindings> }>, options: EventStreamOptions): Response;
  // Number of connections and the maximum pending notifications per connection (for diagnostics).
  stats(): { streams: number; maxPending: number };
  // End every stream. Their queued notifications are still written.
  finishAll(): void;
}

// SSE read via fetch. Only IDs and revisions are streamed, never the body. Shared by the management UI and the
// phone reader: ordered writes, heartbeats, the pending limit (resync-required), and cutting stalled connections.
export function createEventStreams(): EventStreams {
  // Per connection: the finish function and the number of pending notifications.
  const streams = new Map<() => void, { readonly pending: number }>();
  return {
    open(c, options) {
      const response = streamSSE(c, async (stream) => {
        let closed = false;
        let wake: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const finish = () => {
          closed = true;
          wake();
        };
        // Writes are performed in order, and before ending the stream, wait for the requested writes to finish.
        // Closing without waiting loses the notifications emitted just before stopping.
        const queue = createEventQueue({
          writeEvent: (event) => {
            const frame = options.frame(event);
            return frame === null ? Promise.resolve() : stream.writeSSE(frame);
          },
          writeHeartbeat: () => stream.write(': heartbeat\n\n'),
          onError: finish,
        });
        // Stop sending and cut the connection when writes stall. Skip the remaining writes,
        // end the stalled write, and close the socket too (do not leave data queued for a peer that does not read).
        const drop = () => {
          queue.stop();
          finish();
          stream.abort();
          c.env.outgoing?.destroy();
        };
        streams.set(finish, queue);
        stream.onAbort(finish);
        const send = (event: ServerEvent) => {
          if (!closed) queue.send(event);
        };
        send(options.hello);
        const unsubscribe = options.subscribe(send);
        const heartbeat = setInterval(() => {
          // Cut a connection whose receiver does not read and whose writes make no progress. The receiver reconnects and resyncs state.
          if (queue.stalledFor() >= (options.stallMs ?? LIMITS.sseStallMs)) {
            drop();
            return;
          }
          queue.heartbeat();
        }, options.heartbeatMs ?? LIMITS.sseHeartbeatMs);
        try {
          await done;
        } finally {
          clearInterval(heartbeat);
          unsubscribe();
          await queue.settled();
          // Count it as a connection until the writes finish (do not hide unfinished connections from diagnostics).
          streams.delete(finish);
        }
      });
      // The `no-cache` set by streamSSE allows storing, so use `no-store` instead. With a storable response, Firefox
      // holds a second connection to the same URL (another screen or a reconnect) for about 20 seconds until the first response ends.
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
    stats() {
      let maxPending = 0;
      for (const queue of streams.values()) maxPending = Math.max(maxPending, queue.pending);
      return { streams: streams.size, maxPending };
    },
    finishAll() {
      for (const finish of streams.keys()) finish();
    },
  };
}
