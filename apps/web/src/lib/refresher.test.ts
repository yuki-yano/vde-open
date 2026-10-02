import { describe, expect, it } from 'vitest';

import { createRefresher } from './refresher.ts';

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

// 取得の完了を1件ずつ制御する。応答の内容は、取得を始めた時点のserverの状態で決まる。
function controlledFetch() {
  let serverState = 1;
  const applied: number[] = [];
  const pending: Deferred[] = [];
  const run = () => {
    const snapshot = serverState;
    return new Promise<void>((resolve, reject) => {
      pending.push({
        resolve: () => {
          applied.push(snapshot);
          resolve();
        },
        reject,
      });
    });
  };
  return {
    run,
    applied,
    pending,
    update: (next: number) => {
      serverState = next;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('一覧の再取得', () => {
  it('遅い取得の結果が、後から始めた取得の結果を上書きしない', async () => {
    const fetcher = controlledFetch();
    const refresh = createRefresher(fetcher.run);

    // 1回目の取得（状態1を読む）が終わる前に、serverが状態2・3へ進み、通知が2回届く。
    void refresh();
    fetcher.update(2);
    void refresh();
    fetcher.update(3);
    const last = refresh();
    // 並行して取得しない。実行中は1件だけ。
    expect(fetcher.pending).toHaveLength(1);

    fetcher.pending[0]?.resolve();
    await settle();
    // 待っていた依頼は、まとめて1回の取得になる。取得は依頼の後に始まるので、状態3を読む。
    expect(fetcher.pending).toHaveLength(2);
    fetcher.pending[1]?.resolve();
    await last;

    // 最後に反映されるのは、最新の状態。古い状態で終わらない。
    expect(fetcher.applied).toEqual([1, 3]);
  });

  it('取得が終わった直後に依頼が重なっても、並行して取得しない', async () => {
    const applied: number[] = [];
    // 終わっていない取得。呼ぶと、その取得が完了する。
    const waiting: Array<() => void> = [];
    let serverState = 1;
    let maxActive = 0;
    let onSettled: () => void = () => undefined;
    const run = () => {
      const snapshot = serverState;
      const fetched = new Promise<void>((resolve) => {
        waiting.push(() => {
          applied.push(snapshot);
          resolve();
        });
      });
      maxActive = Math.max(maxActive, waiting.length);
      // 取得の完了に続く処理から、次の依頼が出る（通知の処理など）。
      void fetched.then(() => onSettled());
      return fetched;
    };
    const refresh = createRefresher(run);

    const first = refresh();
    // 完了を待っていた呼び出し元も、完了の直後に依頼を出す。
    void first.then(() => {
      serverState = 4;
      return refresh();
    });
    serverState = 2;
    void refresh();
    onSettled = () => {
      onSettled = () => undefined;
      serverState = 3;
      void refresh();
    };

    // 取得が並行していれば、新しく始まったものから先に終わらせる（完了順を逆にする）。
    for (let round = 0; round < 10; round += 1) {
      waiting.pop()?.();
      await settle();
    }

    expect(maxActive).toBe(1);
    expect(waiting).toEqual([]);
    // 反映は取得を始めた順。最後に反映されるのは、最新の状態。
    expect(applied).toEqual(applied.toSorted((a, b) => a - b));
    expect(applied.at(-1)).toBe(serverState);
  });

  it('取得が失敗しても、次の依頼で取得できる', async () => {
    const fetcher = controlledFetch();
    const refresh = createRefresher(fetcher.run);
    const first = refresh();
    fetcher.pending[0]?.reject(new Error('offline'));
    await first;
    fetcher.update(2);
    const second = refresh();
    fetcher.pending[1]?.resolve();
    await second;
    expect(fetcher.applied).toEqual([2]);
  });

  it('実行中でなければ、依頼のたびに取得する', async () => {
    const fetcher = controlledFetch();
    const refresh = createRefresher(fetcher.run);
    const first = refresh();
    fetcher.pending[0]?.resolve();
    await first;
    const second = refresh();
    fetcher.pending[1]?.resolve();
    await second;
    expect(fetcher.applied).toEqual([1, 1]);
  });
});
