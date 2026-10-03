import { setTimeout as delay } from 'node:timers/promises';

import {
  isErrorCode,
  isVdeError,
  VdeError,
  type Envelope,
  type FeedbackForAgent,
} from '@vde-open/shared';

import type { IpcConnection } from '../server/ipc-client.ts';

// Errors that trigger a reconnect so that waiting for the answer continues across daemon stops and restarts.
const RECONNECTABLE = new Set([
  'E_DAEMON_STOPPING',
  'E_DAEMON_UNAVAILABLE',
  'E_DAEMON_START_FAILED',
  'E_DAEMON_LOCKED',
]);
const RECONNECT_INTERVAL_MS = 250;
// The IPC timeout for the daemon response is slightly longer than the wait deadline. The wait deadline is
// enforced separately, so the IPC timeout only keeps the daemon-side timeout response from counting as an IPC failure.
const IPC_GRACE_MS = 1000;

export interface WaitForAnswerOptions {
  requestId: string;
  timeoutMs: number;
  // Connect to the daemon, starting it if needed. When the signal is aborted, stop waiting for startup and
  // connecting, and leave no timers behind (do not keep the process alive after the wait ends).
  connect: (signal: AbortSignal) => Promise<IpcConnection>;
  // Subscribe to the interrupt (SIGINT) signal. Returns a function that unsubscribes.
  subscribeInterrupt: (listener: () => void) => () => void;
}

// Wait until the answer is submitted or the question is cancelled (spec 11.6, SYS-013). The deadline is set at
// the start, and connecting, reconnecting, and waiting for the daemon response all stop at that deadline.
// Reconnecting after the daemon stops does not extend it. On timeout or interrupt, the question stays pending.
export async function waitForAnswer(
  options: WaitForAnswerOptions,
): Promise<Envelope<FeedbackForAgent>> {
  const { requestId, connect } = options;
  const deadline = Date.now() + options.timeoutMs;
  const timeoutError = () =>
    new VdeError('E_TIMEOUT', 'The wait for the answer timed out. The question is still pending.', {
      requestId,
      status: 'pending',
    });
  const interruptedError = () =>
    new VdeError('E_INTERRUPTED', 'The wait was interrupted. The question is still pending.', {
      requestId,
    });
  let interrupted = false;
  // When the wait ends, abandon any connection process and reconnect delay still in progress.
  const abandon = new AbortController();
  const stops = new Set<() => void>();
  const unsubscribe = options.subscribeInterrupt(() => {
    interrupted = true;
    for (const stop of stops) stop();
  });

  // Wait for the work only until the deadline or an interrupt. A result that arrives late (a connection that opened afterwards) is cleaned up by discard.
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
        // Wait only for the time remaining after the connection took its share.
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
    abandon.abort(new VdeError('E_INTERRUPTED', 'The wait has ended.'));
  }
}
