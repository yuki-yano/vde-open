import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { collectGarbage } from './heap.ts';

// An idle Node.js thread does not run a full garbage collection on its own. The garbage left by parsing,
// indexing, searching, and handling requests stays in the heap (and in RSS) until the thread gets busy again.
// These helpers collect once after activity stops.

// After requests to a worker pause this long, ask it to collect once.
export const COLLECT_AFTER_IDLE_MS = 2000;

export interface IdleTrigger {
  // Records activity. run is called once after touch stops being called for the delay.
  touch(): void;
  cancel(): void;
}

export function createIdleTrigger(run: () => void, delayMs = COLLECT_AFTER_IDLE_MS): IdleTrigger {
  let timer: NodeJS.Timeout | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    touch() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
      timer.unref();
    },
    cancel,
  };
}

// How long requests wait for a collection in a worker. After this, they are sent anyway (and queue behind it in the worker).
export const COLLECT_WAIT_LIMIT_MS = 10_000;

export interface WorkerCollect {
  // Sends a request now, or after the collection in progress finishes.
  dispatch(send: () => void, reject: (error: Error) => void): void;
  // Records activity. The worker collects once after activity pauses.
  touch(): void;
  // Handles a worker reply. True if it is the reply to the collection.
  settle(id: number): boolean;
  // The worker was lost or replaced: stop waiting for its collection.
  reset(): void;
  // Rejects the requests still waiting.
  close(error: Error): void;
}

export interface WorkerCollectOptions {
  worker: () => { postMessage(message: unknown): void } | null;
  // Whether requests are in flight on the worker.
  busy: () => boolean;
  nextId: () => number;
  delayMs?: number;
  waitLimitMs?: number;
}

// Garbage collection in a worker once its requests pause. Requests made while it runs are held and sent when it
// finishes, so their time limits start only then. The hold lasts at most COLLECT_WAIT_LIMIT_MS from the start of
// the collection; after that the requests are sent and their usual time limits (and worker recovery) apply.
export function createWorkerCollect(options: WorkerCollectOptions): WorkerCollect {
  let collecting: { id: number; timer: NodeJS.Timeout } | null = null;
  let closed = false;
  const held: Array<{ send: () => void; reject: (error: Error) => void }> = [];
  const release = () => {
    if (collecting) clearTimeout(collecting.timer);
    collecting = null;
    for (const request of held.splice(0)) request.send();
  };
  const idle = createIdleTrigger(() => {
    const worker = options.worker();
    if (closed || worker === null || collecting) return;
    // Requests are in flight (such as diagnostics, which do not count as activity). Try again after a pause.
    if (options.busy()) {
      idle.touch();
      return;
    }
    const id = options.nextId();
    const timer = setTimeout(release, options.waitLimitMs ?? COLLECT_WAIT_LIMIT_MS);
    timer.unref();
    collecting = { id, timer };
    worker.postMessage({ id, op: 'collect' });
  }, options.delayMs);
  return {
    dispatch(send, reject) {
      if (collecting) held.push({ send, reject });
      else send();
    },
    touch: () => idle.touch(),
    settle(id) {
      if (collecting?.id !== id) return false;
      release();
      return true;
    },
    reset: () => {
      if (collecting) release();
    },
    close(error) {
      closed = true;
      idle.cancel();
      if (collecting) clearTimeout(collecting.timer);
      collecting = null;
      for (const request of held.splice(0)) request.reject(error);
    },
  };
}

export interface HeapWatchOptions {
  intervalMs?: number;
  // Collect only after the heap has grown this much since the last collection.
  growthBytes?: number;
  // The thread counts as idle when its event loop was busy for less than this share of the interval.
  idleUtilization?: number;
  heapUsed?: () => number;
  // Share of time the event loop was busy since the previous call.
  utilization?: () => number;
  collect?: () => void;
}

function utilizationSincePreviousCall(): () => number {
  let previous = performance.eventLoopUtilization();
  return () => {
    const current = performance.eventLoopUtilization();
    const { utilization } = performance.eventLoopUtilization(current, previous);
    previous = current;
    return utilization;
  };
}

// For the daemon's main thread, which has many sources of work (IPC, HTTP, file watching, worker replies).
// Instead of tracking each of them, it checks its own heap on an interval and collects once when the heap has grown
// and the thread was idle during the last interval.
export function startHeapWatch(options: HeapWatchOptions = {}): { stop(): void } {
  const growthBytes = options.growthBytes ?? 8 * 1024 * 1024;
  const idleUtilization = options.idleUtilization ?? 0.05;
  const heapUsed = options.heapUsed ?? (() => getHeapStatistics().used_heap_size);
  const utilization = options.utilization ?? utilizationSincePreviousCall();
  const collect = options.collect ?? collectGarbage;
  let baseline = heapUsed();
  const timer = setInterval(() => {
    const busy = utilization() >= idleUtilization;
    const used = heapUsed();
    // The heap also shrinks through V8's own collections. Measure growth from the smallest size seen.
    baseline = Math.min(baseline, used);
    if (busy || used - baseline < growthBytes) return;
    collect();
    baseline = heapUsed();
  }, options.intervalMs ?? COLLECT_AFTER_IDLE_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
