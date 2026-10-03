import { LIMITS, type ServerEvent } from '@vde-open/shared';

export interface EventQueueOptions {
  // 1件の通知を書く。受け手へ渡し終えたら解決する。
  writeEvent: (event: ServerEvent) => Promise<unknown>;
  // 接続を保つための空の行を書く。
  writeHeartbeat: () => Promise<unknown>;
  // 書く直前の確認。falseなら書かない（sessionの失効など。接続を終えるのは呼び出し側）。
  beforeWrite: () => boolean;
  // 書き込みに失敗した。
  onError: () => void;
  // 書き終わっていない通知の上限。指定がなければ`LIMITS.ssePendingEvents`。
  limit?: number;
  now?: () => number;
}

export interface EventQueue {
  // 書き終わっていない通知の数（取り直しの合図とheartbeatを含む）。
  readonly pending: number;
  // 書き込みが進まないまま過ぎた時間。待ち行列が空なら0。
  stalledFor(): number;
  send(event: ServerEvent): void;
  // 待ち行列が空のときだけ、heartbeatを並べる。
  heartbeat(): void;
  // これより後は書かない（並んでいる分も書かない）。
  stop(): void;
  // 並んでいる書き込みがすべて終わったら解決する。
  settled(): Promise<void>;
}

// 1つの通知の接続の、書き込みの待ち行列（仕様6.5）。書き込みは順に行う。
// 受け手が読まない間は、上限を超えた通知を捨てて1つの取り直しの合図（resync-required）にまとめ、
// 待ち行列を増やさない。
export function createEventQueue(options: EventQueueOptions): EventQueue {
  const limit = options.limit ?? LIMITS.ssePendingEvents;
  const now = options.now ?? Date.now;
  let pending = 0;
  let writes: Promise<void> = Promise.resolve();
  // 最後に書き込みが進んだ時刻（待ち行列が空から増えた時刻を含む）。
  let progressAt = now();
  let stopped = false;
  // 取り直しの合図を並べてから、書くまでの間か。
  let resyncQueued = false;

  const enqueue = (write: () => Promise<unknown>) => {
    if (pending === 0) progressAt = now();
    pending += 1;
    writes = writes
      .then(() => {
        if (stopped || !options.beforeWrite()) return undefined;
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
      // 合図は、合図を書くまでに捨てた通知より後に届くので、受け手が合図を受けてから取り直せば、
      // 捨てた変更も含む。合図の連番は最初に捨てた通知の連番にする。合図より前に並んだ通知は
      // それより小さく、後に並ぶ通知は大きいので、届く連番は増え続ける。
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
