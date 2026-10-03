import type { Envelope, FeedbackForAgent } from '@vde-open/shared';
import { VdeError } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import type { IpcConnection } from '../server/ipc-client.ts';
import { waitForAnswer } from './wait-for-answer.ts';

const REQUEST_ID = `req_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
const submitted = { requestId: REQUEST_ID, status: 'submitted' } as FeedbackForAgent;
const ok = (data: FeedbackForAgent): Envelope<FeedbackForAgent> =>
  ({ ok: true, data, warnings: [], meta: {} }) as unknown as Envelope<FeedbackForAgent>;
const failure = (code: string): Envelope<FeedbackForAgent> =>
  ({
    ok: false,
    error: { code, message: code, details: {}, retryable: true },
    meta: {},
  }) as unknown as Envelope<FeedbackForAgent>;

interface FakeConnection extends IpcConnection {
  closed: boolean;
  // Wait timeouts received.
  waited: number[];
}

// A connection whose response is reply. With null, it never responds.
function connection(reply: Envelope<FeedbackForAgent> | null = null): FakeConnection {
  const fake: FakeConnection = {
    daemonId: 'daemon_test',
    closed: false,
    waited: [],
    request<T>(_method: string, params: unknown) {
      fake.waited.push((params as { timeoutMs: number }).timeoutMs);
      return reply === null
        ? new Promise<Envelope<T>>(() => undefined)
        : Promise.resolve(reply as unknown as Envelope<T>);
    },
    close() {
      fake.closed = true;
    },
  };
  return fake;
}

const delay = <T>(ms: number, value: () => T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
const noInterrupt = () => () => undefined;

async function timed<T>(work: Promise<T>): Promise<{ elapsed: number; error: unknown }> {
  const startedAt = Date.now();
  try {
    await work;
    return { elapsed: Date.now() - startedAt, error: null };
  } catch (error) {
    return { elapsed: Date.now() - startedAt, error };
  }
}

describe('SYS-013 wait deadline', () => {
  it('the deadline stays as set at the start even when connecting is slow; a connection that opens late is closed', async () => {
    const late = connection();
    let given: AbortSignal | null = null;
    const result = await timed(
      waitForAnswer({
        requestId: REQUEST_ID,
        timeoutMs: 300,
        connect: (signal) => {
          given = signal;
          return delay(500, () => late);
        },
        subscribeInterrupt: noInterrupt,
      }),
    );
    expect(result.error).toMatchObject({ code: 'E_TIMEOUT', details: { status: 'pending' } });
    expect(result.elapsed).toBeLessThan(450);
    // The connection process (such as waiting for startup) is also told to stop.
    expect((given as AbortSignal | null)?.aborted).toBe(true);
    await delay(300, () => undefined);
    expect(late.closed).toBe(true);
    expect(late.waited).toEqual([]);
  });

  it('the wait time passed to the daemon is the remainder after connecting; ends at the deadline even without a response', async () => {
    const silent = connection();
    const result = await timed(
      waitForAnswer({
        requestId: REQUEST_ID,
        timeoutMs: 500,
        connect: () => delay(200, () => silent),
        subscribeInterrupt: noInterrupt,
      }),
    );
    expect(result.error).toMatchObject({ code: 'E_TIMEOUT' });
    expect(result.elapsed).toBeLessThan(650);
    expect(silent.waited).toHaveLength(1);
    expect(silent.waited[0]).toBeLessThanOrEqual(320);
    expect(silent.closed).toBe(true);
  });

  it('when the daemon is stopped, reconnects within the deadline and receives the answer', async () => {
    const answered = connection(ok(submitted));
    const attempts: string[] = [];
    const envelope = await waitForAnswer({
      requestId: REQUEST_ID,
      timeoutMs: 2000,
      connect: () => {
        attempts.push('connect');
        if (attempts.length === 1) {
          return Promise.reject(new VdeError('E_DAEMON_UNAVAILABLE', 'stopped'));
        }
        return Promise.resolve(
          attempts.length === 2 ? connection(failure('E_DAEMON_STOPPING')) : answered,
        );
      },
      subscribeInterrupt: noInterrupt,
    });
    expect(envelope.ok && envelope.data.status).toBe('submitted');
    expect(attempts).toHaveLength(3);
    expect(answered.closed).toBe(true);
  });

  it('an interrupt ends immediately even mid-connection, and the question stays pending', async () => {
    let interrupt: () => void = () => undefined;
    const late = connection();
    const waiting = timed(
      waitForAnswer({
        requestId: REQUEST_ID,
        timeoutMs: 5000,
        connect: () => delay(400, () => late),
        subscribeInterrupt: (listener) => {
          interrupt = listener;
          return () => undefined;
        },
      }),
    );
    await delay(50, () => undefined);
    interrupt();
    const result = await waiting;
    expect(result.error).toMatchObject({ code: 'E_INTERRUPTED' });
    expect(result.elapsed).toBeLessThan(150);
    await delay(450, () => undefined);
    expect(late.closed).toBe(true);
  });
});
