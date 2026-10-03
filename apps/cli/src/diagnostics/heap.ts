import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

let gc: (() => void) | null = null;

// Runs a full garbage collection on this thread (the daemon itself, or a worker).
// Enables it here even when the daemon was started without `--expose-gc`.
export function collectGarbage(): void {
  if (gc === null) {
    setFlagsFromString('--expose-gc');
    gc = runInNewContext('gc') as () => void;
  }
  gc();
}

// Returns the heap usage of this thread (the daemon itself, or each worker).
// With collect, runs GC once first (so resource leak checks can compare the heap after collection).
export function measureHeap(collect: boolean): number {
  if (collect) collectGarbage();
  return getHeapStatistics().used_heap_size;
}

// The result of a worker diagnostic.
export interface WorkerDiagnostics {
  heapUsedBytes: number;
  retained: Record<string, number>;
}
