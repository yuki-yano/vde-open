// Run refetches one at a time. If several run in parallel, the result of a slow fetch that started first
// can overwrite the result of one that started later, reverting to an old list.
// If a request arrives while running, fetch once more after the current one finishes.
// The returned promise resolves once a fetch that started after the request has finished.
export function createRefresher(run: () => Promise<void>): () => Promise<void> {
  let requested = false;
  let loop: Promise<void> | null = null;

  // While there are requests, keep fetching one at a time. Never leave a "not running" moment between fetches.
  const drain = async (): Promise<void> => {
    while (requested) {
      requested = false;
      try {
        await run();
      } catch {
        // Fetch failures are not reported to the caller. The next request refetches.
      }
    }
    loop = null;
  };

  return () => {
    requested = true;
    loop ??= drain();
    return loop;
  };
}
