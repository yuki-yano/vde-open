import { VdeError } from '@vde-open/shared';

// promiseの終わりを待つ。signalが中断されたら、待つのをやめてE_DAEMON_STOPPINGで終える
// （promiseの処理そのものは止めない）。待つのをやめた後のpromiseの失敗も、ここで受ける
// （未処理のrejectionにしない）。
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const stopping = () => new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。');
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
