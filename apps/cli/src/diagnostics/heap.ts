import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// このthread（daemonの本体、または各worker）のheapの使用量を返す。
// collectGarbageなら、先にGCを1回行う（資源の漏れの検査で、回収後のheapを比べるため）。
// daemonを`--expose-gc`なしで起動していても、ここで有効にする。
export function measureHeap(collectGarbage: boolean): number {
  if (collectGarbage) {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as () => void)();
  }
  return getHeapStatistics().used_heap_size;
}

// workerの診断の結果。
export interface WorkerDiagnostics {
  heapUsedBytes: number;
  retained: Record<string, number>;
}
