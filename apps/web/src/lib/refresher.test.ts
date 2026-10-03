import { describe, expect, it } from 'vitest';

import { createRefresher } from './refresher.ts';

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

// Control the completion of each fetch. The response content is decided by the server state at the time the fetch started.
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

describe('refetching the list', () => {
  it('the result of a slow fetch does not overwrite the result of a fetch started later', async () => {
    const fetcher = controlledFetch();
    const refresh = createRefresher(fetcher.run);

    // Before the first fetch (reading state 1) finishes, the server moves to states 2 and 3 and two notifications arrive.
    void refresh();
    fetcher.update(2);
    void refresh();
    fetcher.update(3);
    const last = refresh();
    // No parallel fetches. Only one is running.
    expect(fetcher.pending).toHaveLength(1);

    fetcher.pending[0]?.resolve();
    await settle();
    // The waiting requests are coalesced into one fetch. It starts after the requests, so it reads state 3.
    expect(fetcher.pending).toHaveLength(2);
    fetcher.pending[1]?.resolve();
    await last;

    // The last applied state is the latest. It does not end on an old state.
    expect(fetcher.applied).toEqual([1, 3]);
  });

  it('does not fetch in parallel even when requests pile up right after a fetch finishes', async () => {
    const applied: number[] = [];
    // Unfinished fetches. Calling one completes that fetch.
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
      // Processing that follows a fetch's completion issues the next request (such as handling a notification).
      void fetched.then(() => onSettled());
      return fetched;
    };
    const refresh = createRefresher(run);

    const first = refresh();
    // A caller that waited for completion also issues a request right after completion.
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

    // If fetches were running in parallel, finish the newest one first (reverse completion order).
    for (let round = 0; round < 10; round += 1) {
      waiting.pop()?.();
      await settle();
    }

    expect(maxActive).toBe(1);
    expect(waiting).toEqual([]);
    // Results are applied in the order the fetches started. The last applied state is the latest.
    expect(applied).toEqual(applied.toSorted((a, b) => a - b));
    expect(applied.at(-1)).toBe(serverState);
  });

  it('can fetch on the next request even after a fetch fails', async () => {
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

  it('fetches on every request when nothing is running', async () => {
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
