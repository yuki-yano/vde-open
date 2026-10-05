import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchBuildInputs } from '../scripts/build-inputs.ts';
import { createBuildQueue } from '../scripts/build-queue.ts';

afterEach(() => vi.useRealTimers());

describe('build scheduling', () => {
  it('coalesces saves and builds changes received while the previous build is running', async () => {
    vi.useFakeTimers();
    const release: Array<() => void> = [];
    const build = vi.fn<() => Promise<void>>(
      () => new Promise<void>((resolve) => release.push(resolve)),
    );
    const errors = vi.fn<(error: unknown) => void>();
    const queue = createBuildQueue(build, errors, 100);
    queue.request();
    await vi.advanceTimersByTimeAsync(50);
    queue.request();
    await vi.advanceTimersByTimeAsync(99);
    expect(build).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(build).toHaveBeenCalledTimes(1);
    queue.request();
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(build).toHaveBeenCalledTimes(1);
    release[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(build).toHaveBeenCalledTimes(2);
    release[1]?.();
    await queue.stop();
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps watching after a failed build and retries on the next change', async () => {
    vi.useFakeTimers();
    const build = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('bad source'))
      .mockResolvedValue(undefined);
    const errors = vi.fn<(error: unknown) => void>();
    const queue = createBuildQueue(build, errors, 100);
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveBeenCalledOnce();
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(build).toHaveBeenCalledTimes(2);
    await queue.stop();
  });

  it('waits for the active build when stopping and discards queued changes', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const build = vi.fn<() => Promise<void>>(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const queue = createBuildQueue(build, vi.fn<(error: unknown) => void>(), 100);
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
    queue.request();
    const stopped = vi.fn<() => void>();
    const stopping = queue.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).not.toHaveBeenCalled();
    release?.();
    await stopping;
    queue.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(build).toHaveBeenCalledOnce();
  });
});

describe('build input watching', () => {
  it('follows nested additions and atomic saves without watching generated outputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vde-open-build-inputs-'));
    const src = join(root, 'src');
    mkdirSync(src);
    const config = join(root, 'config.ts');
    writeFileSync(config, 'original');
    const changed = vi.fn<() => void>();
    const errors = vi.fn<(error: Error) => void>();
    const close = watchBuildInputs(
      [
        { path: src, recursive: true },
        { path: config },
        { path: join(root, 'public'), recursive: true },
      ],
      changed,
      errors,
    );
    try {
      const nested = join(src, 'nested');
      mkdirSync(nested);
      writeFileSync(join(nested, 'module.ts'), 'first');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      changed.mockClear();
      const replacement = join(root, 'replacement');
      writeFileSync(replacement, 'replacement');
      renameSync(replacement, config);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      changed.mockClear();
      writeFileSync(config, 'another save');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      mkdirSync(join(root, 'public'));
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      changed.mockClear();
      writeFileSync(join(root, 'public', 'asset.svg'), '<svg/>');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      // Let already received filesystem notifications drain before testing exclusions.
      await new Promise((resolve) => setTimeout(resolve, 100));
      changed.mockClear();
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'cli.js'), 'built');
      writeFileSync(join(src, 'module.test.ts'), 'test only');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changed).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
