import { setTimeout as delay } from 'node:timers/promises';

import {
  isErrorCode,
  isVdeError,
  VdeError,
  type Envelope,
  type FeedbackForAgent,
} from '@vde-open/shared';

import type { IpcConnection } from '../server/ipc-client.ts';

// 回答の待機を、daemonの停止・再起動の間も続けるときに、接続し直す対象のerror。
const RECONNECTABLE = new Set([
  'E_DAEMON_STOPPING',
  'E_DAEMON_UNAVAILABLE',
  'E_DAEMON_START_FAILED',
  'E_DAEMON_LOCKED',
]);
const RECONNECT_INTERVAL_MS = 250;
// daemonの応答を待つ通信の期限は、待機の期限より少し長くする。待機の期限は別に打ち切るので、
// 通信の期限は、daemonの期限での応答を通信の失敗として扱わないためだけに使う。
const IPC_GRACE_MS = 1000;

export interface WaitForAnswerOptions {
  requestId: string;
  timeoutMs: number;
  // daemonへ接続する。起動していなければ起動する。signalが中断されたら、起動の待ちと接続をやめ、
  // timerを残さない（待機を終えた後にprocessを生かし続けない）。
  connect: (signal: AbortSignal) => Promise<IpcConnection>;
  // 中断（SIGINT）の合図を購読する。購読をやめる関数を返す。
  subscribeInterrupt: (listener: () => void) => () => void;
}

// 回答が確定するか、中止されるまで待つ（仕様11.6、SYS-013）。期限は開始時に決め、接続・再接続・
// daemonの応答の待ちを、すべてその期限で打ち切る。daemonが止まって接続し直しても、期限は延ばさない。
// 時間切れと中断では、質問は回答待ちのまま。
export async function waitForAnswer(
  options: WaitForAnswerOptions,
): Promise<Envelope<FeedbackForAgent>> {
  const { requestId, connect } = options;
  const deadline = Date.now() + options.timeoutMs;
  const timeoutError = () =>
    new VdeError('E_TIMEOUT', '回答を待つ時間が過ぎました。質問は回答待ちのままです。', {
      requestId,
      status: 'pending',
    });
  const interruptedError = () =>
    new VdeError('E_INTERRUPTED', '待機を中断しました。質問は回答待ちのままです。', {
      requestId,
    });
  let interrupted = false;
  // 待機を終えるときに、まだ動いている接続の処理と再接続の待ちをやめさせる。
  const abandon = new AbortController();
  const stops = new Set<() => void>();
  const unsubscribe = options.subscribeInterrupt(() => {
    interrupted = true;
    for (const stop of stops) stop();
  });

  // 処理を、期限か中断までだけ待つ。間に合わなかった結果（後から成立した接続）はdiscardで片付ける。
  const bounded = <T>(work: Promise<T>, discard: (value: T) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stops.delete(stop);
        action();
      };
      const stop = () => finish(() => reject(interruptedError()));
      const timer = setTimeout(
        () => finish(() => reject(timeoutError())),
        Math.max(0, deadline - Date.now()),
      );
      stops.add(stop);
      work.then(
        (value) => {
          if (settled) discard(value);
          else finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
      if (interrupted) stop();
    });

  try {
    for (;;) {
      if (deadline - Date.now() <= 0) throw timeoutError();
      let connection: IpcConnection | null = null;
      try {
        connection = await bounded(connect(abandon.signal), (late) => late.close());
        // 接続にかかった時間を引いた、残りの時間だけ待つ。
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError();
        const envelope = await bounded(
          connection.request<FeedbackForAgent>(
            'feedback.wait',
            { requestId, timeoutMs: remaining },
            { timeoutMs: remaining + IPC_GRACE_MS },
          ),
          () => undefined,
        );
        if (envelope.ok) return envelope;
        const { code, message, details, retryable } = envelope.error;
        throw new VdeError(isErrorCode(code) ? code : 'E_INTERNAL', message, details, {
          retryable,
        });
      } catch (error) {
        if (!isVdeError(error) || !RECONNECTABLE.has(error.code)) throw error;
      } finally {
        connection?.close();
      }
      await bounded(
        delay(RECONNECT_INTERVAL_MS, undefined, { signal: abandon.signal }),
        () => undefined,
      );
    }
  } finally {
    unsubscribe();
    abandon.abort(new VdeError('E_INTERRUPTED', '待機を終えました。'));
  }
}
