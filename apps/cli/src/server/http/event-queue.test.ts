import type { ServerEvent } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { createEventQueue } from './event-queue.ts';

const eventOf = (sequence: number): ServerEvent => ({
  type: 'catalog-changed',
  daemonId: 'daemon_test',
  sequence,
  catalogVersion: 1,
});

// 書き込みの完了を、試験の側で1件ずつ進める。
function harness(limit: number) {
  const written: ServerEvent[] = [];
  const waiting: Array<() => void> = [];
  let active = true;
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
    beforeWrite: () => active,
    onError: () => undefined,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  // 書き込み中の1件を終え、次の書き込みが始まるまで待つ。
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
    deactivate: () => {
      active = false;
    },
  };
}

describe('通知の待ち行列', () => {
  it('上限を超えた通知は捨てて取り直しの合図にまとめ、書き込みの途中に通知が続いても連番は増え続ける', async () => {
    const t = harness(4);
    for (const sequence of [1, 2, 3, 4]) t.queue.send(eventOf(sequence));
    // 5と6は上限を超えたので捨て、合図（連番は最初に捨てた5）を1つだけ並べる。
    t.queue.send(eventOf(5));
    t.queue.send(eventOf(6));
    expect(t.queue.pending).toBe(5);
    await t.flush();
    // 1件書き終えても、まだ上限なので7も捨てる（合図は並んだまま）。
    await t.complete();
    t.queue.send(eventOf(7));
    expect(t.queue.pending).toBe(4);
    // さらに1件書き終えると上限を下回り、8は合図の後ろに並ぶ。
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

  it('合図を書いた後にあふれたら、新しい合図を並べる', async () => {
    const t = harness(1);
    t.queue.send(eventOf(1));
    t.queue.send(eventOf(2));
    await t.flush();
    await t.complete();
    // 合図（2）の書き込み中に、3を捨てると、新しい合図を並べる。
    t.queue.send(eventOf(3));
    for (let index = 0; index < 3; index += 1) await t.complete();
    expect(t.written.map((event) => `${event.type}:${String(event.sequence)}`)).toEqual([
      'catalog-changed:1',
      'resync-required:2',
      'resync-required:3',
    ]);
  });

  it('heartbeatは待ち行列が空のときだけ並べ、書き込みが進まない時間を数える', async () => {
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

  it('止めた後と、書く直前の確認で拒まれた後は書かない', async () => {
    const t = harness(4);
    t.queue.send(eventOf(1));
    t.queue.send(eventOf(2));
    await t.flush();
    t.queue.stop();
    t.queue.send(eventOf(3));
    await t.complete();
    await t.queue.settled();
    expect(t.written.map((event) => event.sequence)).toEqual([1]);

    const u = harness(4);
    u.deactivate();
    u.queue.send(eventOf(1));
    await u.queue.settled();
    expect(u.written).toEqual([]);
  });
});
