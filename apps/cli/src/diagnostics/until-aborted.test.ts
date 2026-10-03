import { describe, expect, it } from 'vitest';

import { untilAborted } from './until-aborted.ts';

describe('aborting a wait', () => {
  it('returns the original result and failure as-is when not aborted', async () => {
    const signal = new AbortController().signal;
    await expect(untilAborted(Promise.resolve(1), signal)).resolves.toBe(1);
    await expect(untilAborted(Promise.reject(new Error('failed')), signal)).rejects.toThrow(
      'failed',
    );
    await expect(untilAborted(Promise.resolve(2), undefined)).resolves.toBe(2);
  });

  it('ends with E_DAEMON_STOPPING without waiting for the original work when aborted while waiting', async () => {
    const controller = new AbortController();
    let finish: (value: number) => void = () => undefined;
    const waiting = untilAborted(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    // The result does not change even if the original work finishes later.
    finish(3);
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
  });

  it('ends with E_DAEMON_STOPPING immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      untilAborted(new Promise(() => undefined), controller.signal),
    ).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
  });
});

describe('failure of the original work after we stopped waiting', () => {
  it.each([
    ['when already aborted', true],
    ['when aborted while waiting', false],
  ])(
    '%s, a later failure of the original work is not an unhandled rejection',
    async (_name, abortFirst) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const controller = new AbortController();
        if (abortFirst) controller.abort();
        let fail: (error: Error) => void = () => undefined;
        const original = new Promise<number>((_resolve, reject) => {
          fail = reject;
        });
        const waiting = untilAborted(original, controller.signal);
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
        fail(new Error('failed later'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );
});
