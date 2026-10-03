import { VdeError } from '@vde-open/shared';

// Waits for the promise to settle. If the signal is aborted, stops waiting and ends with E_DAEMON_STOPPING
// (the promise's own work is not stopped). A failure of the promise after we stopped waiting is also
// handled here (never left as an unhandled rejection).
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const stopping = () => new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.');
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(stopping());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopping());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
