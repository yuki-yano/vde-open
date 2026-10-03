import { describe, expect, it } from 'vitest';

import { untilAborted } from './until-aborted.ts';

describe('待ちの中断', () => {
  it('中断されなければ、元の結果と失敗をそのまま返す', async () => {
    const signal = new AbortController().signal;
    await expect(untilAborted(Promise.resolve(1), signal)).resolves.toBe(1);
    await expect(untilAborted(Promise.reject(new Error('失敗')), signal)).rejects.toThrow('失敗');
    await expect(untilAborted(Promise.resolve(2), undefined)).resolves.toBe(2);
  });

  it('待っている間に中断されたら、元の処理を待たずにE_DAEMON_STOPPINGで終える', async () => {
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
    // 後から元の処理が終わっても、結果は変わらない。
    finish(3);
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
  });

  it('すでに中断されていれば、すぐにE_DAEMON_STOPPINGで終える', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      untilAborted(new Promise(() => undefined), controller.signal),
    ).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
  });
});

describe('待つのをやめた後の、元の処理の失敗', () => {
  it.each([
    ['すでに中断されていたとき', true],
    ['待っている間に中断されたとき', false],
  ])('%s、元の処理が後から失敗しても、未処理のrejectionにしない', async (_name, abortFirst) => {
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
      fail(new Error('後から失敗'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
