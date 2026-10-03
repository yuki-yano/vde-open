import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// Returns the heap usage of this thread (the daemon itself, or each worker).
// With collectGarbage, runs GC once first (so resource leak checks can compare the heap after collection).
// Enables it here even when the daemon was started without `--expose-gc`.
export function measureHeap(collectGarbage: boolean): number {
  if (collectGarbage) {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as () => void)();
  }
  return getHeapStatistics().used_heap_size;
}

// The result of a worker diagnostic.
export interface WorkerDiagnostics {
  heapUsedBytes: number;
  retained: Record<string, number>;
}
