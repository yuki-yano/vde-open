import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLLECT_AFTER_IDLE_MS,
  COLLECT_WAIT_LIMIT_MS,
  createIdleTrigger,
  createWorkerCollect,
  startHeapWatch,
} from './idle-collect.ts';

const MiB = 1024 * 1024;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collecting after requests pause', () => {
  it('runs once after the last activity, and never after cancel', () => {
    const run = vi.fn<() => void>();
    const idle = createIdleTrigger(run);
    idle.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS - 1);
    idle.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);

    idle.touch();
    idle.cancel();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('collecting in a worker', () => {
  function setup() {
    const messages: unknown[] = [];
    const state = { busy: false, id: 100 };
    const collector = createWorkerCollect({
      worker: () => ({ postMessage: (message: unknown) => messages.push(message) }),
      busy: () => state.busy,
      nextId: () => {
        state.id += 1;
        return state.id;
      },
    });
    return { messages, state, collector };
  }

  it('holds requests while the worker collects and sends them after its reply', () => {
    const { messages, collector } = setup();
    collector.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    expect(messages).toEqual([{ id: 101, op: 'collect' }]);
    const send = vi.fn<() => void>();
    collector.dispatch(send, vi.fn<(error: Error) => void>());
    expect(send).not.toHaveBeenCalled();
    // A reply to something else does not end the collection.
    expect(collector.settle(7)).toBe(false);
    expect(collector.settle(101)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    // Without a collection, requests are sent right away.
    const next = vi.fn<() => void>();
    collector.dispatch(next, vi.fn<(error: Error) => void>());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('stops holding requests after the wait limit, and when the worker is lost', () => {
    const { collector } = setup();
    collector.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    const send = vi.fn<() => void>();
    collector.dispatch(send, vi.fn<(error: Error) => void>());
    vi.advanceTimersByTime(COLLECT_WAIT_LIMIT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    // A late reply is not taken as the collection's.
    expect(collector.settle(101)).toBe(false);

    collector.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    const afterLoss = vi.fn<() => void>();
    collector.dispatch(afterLoss, vi.fn<(error: Error) => void>());
    collector.reset();
    expect(afterLoss).toHaveBeenCalledTimes(1);
  });

  it('collects after requests that were in flight when the pause ended (such as diagnostics) finish', () => {
    const { messages, state, collector } = setup();
    collector.touch();
    state.busy = true;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    expect(messages).toEqual([]);
    state.busy = false;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    expect(messages).toEqual([{ id: 101, op: 'collect' }]);
  });

  it('rejects held requests on close and does not collect afterwards', () => {
    const { messages, collector } = setup();
    collector.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    const reject = vi.fn<(error: Error) => void>();
    collector.dispatch(vi.fn<() => void>(), reject);
    collector.close(new Error('stopping'));
    expect(reject).toHaveBeenCalledTimes(1);
    collector.touch();
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 3);
    expect(messages).toHaveLength(1);
  });
});

describe('collecting on the main thread after it goes idle', () => {
  function watch(initialHeap: number) {
    const state = { heap: initialHeap, utilization: 0 };
    const collect = vi.fn<() => void>(() => {
      // Collection leaves only the live data.
      state.heap = 20 * MiB;
    });
    const handle = startHeapWatch({
      heapUsed: () => state.heap,
      utilization: () => state.utilization,
      collect,
    });
    return { state, collect, handle };
  }

  it('collects once the heap has grown and the thread was idle during the interval', () => {
    const { state, collect, handle } = watch(20 * MiB);
    state.heap = 60 * MiB;
    state.utilization = 0.5;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    // Busy: wait.
    expect(collect).not.toHaveBeenCalled();
    state.utilization = 0.01;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    expect(collect).toHaveBeenCalledTimes(1);
    // Nothing new to collect while idle.
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 5);
    expect(collect).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('does not collect for small growth, and measures growth from the smallest heap seen', () => {
    const { state, collect, handle } = watch(40 * MiB);
    state.heap = 44 * MiB;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 3);
    expect(collect).not.toHaveBeenCalled();
    // V8 collected on its own, then the heap grew again by more than the threshold from there.
    state.heap = 30 * MiB;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    state.heap = 39 * MiB;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS);
    expect(collect).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('stops checking after stop', () => {
    const { state, collect, handle } = watch(20 * MiB);
    handle.stop();
    state.heap = 100 * MiB;
    vi.advanceTimersByTime(COLLECT_AFTER_IDLE_MS * 5);
    expect(collect).not.toHaveBeenCalled();
  });
});
