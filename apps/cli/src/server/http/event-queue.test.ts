import type { ServerEvent } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { createEventQueue } from './event-queue.ts';

const eventOf = (sequence: number): ServerEvent => ({
  type: 'catalog-changed',
  daemonId: 'daemon_test',
  sequence,
  catalogVersion: 1,
});

// The test advances write completion one at a time.
function harness(limit: number) {
  const written: ServerEvent[] = [];
  const waiting: Array<() => void> = [];
  let heartbeats = 0;
  const queue = createEventQueue({
    limit,
    writeEvent: (event) =>
      new Promise<void>((resolve) => {
        written.push(event);
        waiting.push(resolve);
      }),
    writeHeartbeat: () => {
      heartbeats += 1;
      return Promise.resolve();
    },
    onError: () => undefined,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  // Finish the write in progress and wait until the next write starts.
  const complete = async () => {
    waiting.shift()?.();
    await flush();
  };
  return {
    queue,
    written,
    complete,
    flush,
    heartbeats: () => heartbeats,
  };
}

describe('notification queue', () => {
  it('drops notifications over the limit into a resync marker, and sequences keep increasing even as notifications continue mid-write', async () => {
    const t = harness(4);
    for (const sequence of [1, 2, 3, 4]) t.queue.send(eventOf(sequence));
    // 5 and 6 exceed the limit, so drop them and queue just one marker (sequence 5, the first dropped).
    t.queue.send(eventOf(5));
    t.queue.send(eventOf(6));
    expect(t.queue.pending).toBe(5);
    await t.flush();
    // After one write finishes, still at the limit, so 7 is dropped too (the marker stays queued).
    await t.complete();
    t.queue.send(eventOf(7));
    expect(t.queue.pending).toBe(4);
    // After one more write finishes, below the limit, so 8 is queued behind the marker.
    await t.complete();
    t.queue.send(eventOf(8));
    for (let index = 0; index < 6; index += 1) await t.complete();
    expect(t.written.map((event) => `${event.type}:${String(event.sequence)}`)).toEqual([
      'catalog-changed:1',
      'catalog-changed:2',
      'catalog-changed:3',
      'catalog-changed:4',
      'resync-required:5',
      'catalog-changed:8',
    ]);
    expect(t.queue.pending).toBe(0);
  });

  it('queues a new marker when overflowing after a marker was written', async () => {
    const t = harness(1);
    t.queue.send(eventOf(1));
    t.queue.send(eventOf(2));
    await t.flush();
    await t.complete();
    // Dropping 3 while the marker (2) is being written queues a new marker.
    t.queue.send(eventOf(3));
    for (let index = 0; index < 3; index += 1) await t.complete();
    expect(t.written.map((event) => `${event.type}:${String(event.sequence)}`)).toEqual([
      'catalog-changed:1',
      'resync-required:2',
      'resync-required:3',
    ]);
  });

  it('queues heartbeats only when the queue is empty, and counts time without write progress', async () => {
    const t = harness(4);
    t.queue.heartbeat();
    await t.flush();
    expect(t.heartbeats()).toBe(1);
    expect(t.queue.stalledFor()).toBe(0);
    t.queue.send(eventOf(1));
    t.queue.heartbeat();
    await t.flush();
    expect(t.heartbeats()).toBe(1);
    expect(t.queue.pending).toBe(1);
  });

  it('writes nothing after stop, including writes queued before it', async () => {
    const t = harness(4);
    t.queue.send(eventOf(1));
    t.queue.send(eventOf(2));
    await t.flush();
    t.queue.stop();
    t.queue.send(eventOf(3));
    await t.complete();
    await t.queue.settled();
    expect(t.written.map((event) => event.sequence)).toEqual([1]);
  });
});
