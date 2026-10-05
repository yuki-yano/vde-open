// Run refetches one at a time. If several run in parallel, the result of a slow fetch that started first
// can overwrite the result of one that started later, reverting to an old list.
// If a request arrives while running, fetch once more after the current one finishes.
// The returned promise resolves once a fetch that started after the request has finished,
// with whether the last fetch succeeded.
export function createRefresher(run: () => Promise<void>): () => Promise<boolean> {
  let requested = false;
  let loop: Promise<boolean> | null = null;

  // While there are requests, keep fetching one at a time. Never leave a "not running" moment between fetches.
  const drain = async (): Promise<boolean> => {
    let succeeded = false;
    while (requested) {
      requested = false;
      try {
        await run();
        succeeded = true;
      } catch {
        // The next request refetches.
        succeeded = false;
      }
    }
    loop = null;
    return succeeded;
  };

  return () => {
    requested = true;
    loop ??= drain();
    return loop;
  };
}
