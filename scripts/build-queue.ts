export interface BuildQueue {
  request(): void;
  stop(): Promise<void>;
}

// Coalesce saves, run one build at a time, and remember changes made during a build.
export function createBuildQueue(
  build: () => Promise<void>,
  onError: (error: unknown) => void,
  debounceMs = 200,
): BuildQueue {
  let requested = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  const drain = async () => {
    if (stopped || running || timer || !requested) return;
    requested = false;
    running = Promise.resolve()
      .then(() => {
        if (!stopped) return build();
      })
      .catch((error: unknown) => {
        if (!stopped) onError(error);
      });
    await running;
    running = null;
    if (!stopped && requested && !timer) void drain();
  };

  return {
    request() {
      if (stopped) return;
      requested = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, debounceMs);
    },
    async stop() {
      stopped = true;
      requested = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
