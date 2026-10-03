import type { Stats } from 'node:fs';
import { lstat, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensurePrivateDirectory } from './secure-dir.ts';

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vde-open-secure-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('SYS-008 owner-only directory checks', () => {
  it('creates it with 0700 when missing', async () => {
    const target = join(base, 'a', 'b');
    await ensurePrivateDirectory(target, { uid, platform: process.platform });
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlink', async () => {
    const target = join(base, 'link');
    await symlink(base, target);
    await expect(
      ensurePrivateDirectory(target, { uid, platform: process.platform }),
    ).rejects.toMatchObject({ code: 'E_INSECURE_PATH', details: { reason: 'symlink' } });
  });

  it('rejects a directory owned by another user', async () => {
    const target = join(base, 'owned');
    await ensurePrivateDirectory(target, { uid, platform: process.platform });
    // Creating a directory owned by another user requires root, so the stat result is replaced instead.
    const asOtherUser = async (path: string): Promise<Stats> => {
      const stats = await lstat(path);
      return Object.assign(Object.create(Object.getPrototypeOf(stats) as object), stats, {
        uid: (uid ?? 0) + 1,
      }) as Stats;
    };
    await expect(
      ensurePrivateDirectory(target, { uid, platform: process.platform, lstat: asOtherUser }),
    ).rejects.toMatchObject({ code: 'E_INSECURE_PATH', details: { reason: 'owner' } });
  });
});
