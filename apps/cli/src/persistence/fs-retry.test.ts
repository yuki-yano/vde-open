import { describe, expect, it } from 'vitest';

import { retryOnWindows } from './fs-retry.ts';

const errorWith = (code: string) => Object.assign(new Error(code), { code });

// An operation that fails with the given codes in order, then succeeds.
function failing(codes: string[]): { run: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    run: () => {
      const code = codes[calls];
      calls += 1;
      return code === undefined ? Promise.resolve() : Promise.reject(errorWith(code));
    },
    calls: () => calls,
  };
}

describe('retrying file operations on Windows', () => {
  it('retries EPERM, EACCES, and EBUSY on Windows until the operation succeeds', async () => {
    const operation = failing(['EPERM', 'EACCES', 'EBUSY']);
    await retryOnWindows(operation.run, { platform: 'win32' });
    expect(operation.calls()).toBe(4);
  });

  it('does not retry on other platforms or for other errors', async () => {
    const posix = failing(['EPERM']);
    await expect(retryOnWindows(posix.run, { platform: 'linux' })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(posix.calls()).toBe(1);

    const missing = failing(['ENOENT']);
    await expect(retryOnWindows(missing.run, { platform: 'win32' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(missing.calls()).toBe(1);
  });

  it('gives up with the last error after the time limit', async () => {
    const operation = failing(Array.from({ length: 100 }, () => 'EPERM'));
    const started = Date.now();
    await expect(
      retryOnWindows(operation.run, { platform: 'win32', limitMs: 100 }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(operation.calls()).toBeGreaterThan(1);
  });
});
