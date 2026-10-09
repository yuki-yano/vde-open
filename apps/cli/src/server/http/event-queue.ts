import { LIMITS, type ServerEvent } from '@vde-open/shared';

export interface EventQueueOptions {
  // Writes one notification. Resolves once it has been handed to the receiver.
  writeEvent: (event: ServerEvent) => Promise<unknown>;
  // Writes an empty line to keep the connection alive.
  writeHeartbeat: () => Promise<unknown>;
  // A write failed.
  onError: () => void;
  // Maximum number of pending notifications. Defaults to `LIMITS.ssePendingEvents`.
  limit?: number;
  now?: () => number;
}

export interface EventQueue {
  // Number of pending notifications (including the resync marker and heartbeats).
  readonly pending: number;
  // Time elapsed without write progress. 0 if the queue is empty.
  stalledFor(): number;
  send(event: ServerEvent): void;
  // Queues a heartbeat only when the queue is empty.
  heartbeat(): void;
  // Writes nothing after this (including what is already queued).
  stop(): void;
  // Resolves once every queued write has finished.
  settled(): Promise<void>;
}

// Write queue for one notification connection (spec 6.5). Writes are performed in order.
// While the receiver does not read, notifications over the limit are dropped and collapsed into one resync marker (resync-required),
// so the queue does not grow.
export function createEventQueue(options: EventQueueOptions): EventQueue {
  const limit = options.limit ?? LIMITS.ssePendingEvents;
  const now = options.now ?? Date.now;
  let pending = 0;
  let writes: Promise<void> = Promise.resolve();
  // Time of the last write progress (including when the queue grew from empty).
  let progressAt = now();
  let stopped = false;
  // Whether a resync marker is queued but not yet written.
  let resyncQueued = false;

  const enqueue = (write: () => Promise<unknown>) => {
    if (pending === 0) progressAt = now();
    pending += 1;
    writes = writes
      .then(() => {
        if (stopped) return undefined;
        return write();
      })
      .then(() => {
        progressAt = now();
      })
      .catch(options.onError)
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    get pending() {
      return pending;
    },
    stalledFor() {
      return pending === 0 ? 0 : now() - progressAt;
    },
    send(event) {
      if (stopped) return;
      if (pending < limit) {
        enqueue(() => options.writeEvent(event));
        return;
      }
      // The marker arrives after the notifications dropped before it was written, so if the receiver resyncs after
      // receiving the marker, the dropped changes are included. The marker's sequence is that of the first dropped
      // notification. Notifications queued before the marker are smaller and those after are larger, so delivered sequences keep increasing.
      if (resyncQueued) return;
      resyncQueued = true;
      const marker: ServerEvent = {
        type: 'resync-required',
        daemonId: event.daemonId,
        sequence: event.sequence,
        catalogVersion: event.catalogVersion,
      };
      enqueue(() => {
        resyncQueued = false;
        return options.writeEvent(marker);
      });
    },
    heartbeat() {
      if (!stopped && pending === 0) enqueue(options.writeHeartbeat);
    },
    stop() {
      stopped = true;
    },
    settled() {
      return writes;
    },
  };
}
