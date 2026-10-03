import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  holdsLock,
  inspectOwner,
  readCurrentLock,
  releaseLock,
  systemProcessProbe,
  type LockInfo,
  type ProcessProbe,
} from './lock.ts';

const NAME = 'daemon.lock';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vde-open-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const probe = (alive: boolean, startTime: Date | null = null): ProcessProbe => ({
  isAlive: () => alive,
  startTime: () => Promise.resolve(startTime),
});
const alive = probe(true);
const dead = probe(false);

const acquire = (ownerId: string, ownerProbe: ProcessProbe = alive) =>
  acquireLock(dir, NAME, { pid: process.pid, ownerId }, ownerProbe);

const lockFiles = async () => (await readdir(dir)).filter((name) => name.startsWith(`${NAME}.`));

describe('lock acquisition and release', () => {
  it('acquires exclusively and only the owner can release', async () => {
    expect(await acquire('a')).toMatchObject({ acquired: true, info: { generation: 1 } });
    expect(await acquire('b')).toMatchObject({ acquired: false, reason: 'held' });
    expect(await holdsLock(dir, NAME, 'a')).toBe(true);

    await releaseLock(dir, NAME, 'b');
    expect(await holdsLock(dir, NAME, 'a')).toBe(true);
    await releaseLock(dir, NAME, 'a');
    expect(await holdsLock(dir, NAME, 'a')).toBe(false);
    expect(await readCurrentLock(dir, NAME)).toMatchObject({ ownerId: 'a', released: true });
  });

  it('acquires as the next generation after release and never reuses a generation', async () => {
    await acquire('a');
    await releaseLock(dir, NAME, 'a');
    expect(await acquire('b')).toMatchObject({ acquired: true, info: { generation: 2 } });
    await releaseLock(dir, NAME, 'b');
    expect(await acquire('c')).toMatchObject({ acquired: true, info: { generation: 3 } });
    // Files of older generations are not kept.
    expect(await lockFiles()).toHaveLength(1);
  });

  it('only one succeeds when acquiring concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => acquire(`owner-${String(index)}`)),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it('does not take over an unreadable lock', async () => {
    await writeFile(join(dir, `${NAME}.000000000001`), '{broken');
    expect(await readCurrentLock(dir, NAME)).toBe('invalid');
    expect(await acquire('a')).toEqual({ acquired: false, reason: 'invalid', holder: null });
    expect(await lockFiles()).toEqual([`${NAME}.000000000001`]);
  });
});

describe('SYS-006 / SYS-007 owner liveness check', () => {
  const lockedAt = '2026-10-02T12:00:00.000Z';
  const info = (startedAt: string): LockInfo => ({
    generation: 1,
    pid: process.pid,
    ownerId: 'a',
    startedAt,
    released: false,
  });

  it('dead when the process does not exist', async () => {
    expect(await inspectOwner(info(lockedAt), dead)).toBe('dead');
  });

  it('alive when the process exists and started before the lock', async () => {
    const started = new Date('2026-10-02T11:59:59.000Z');
    expect(await inspectOwner(info(lockedAt), probe(true, started))).toBe('alive');
  });

  it('dead when the process started after the lock, since the pid was reused', async () => {
    const started = new Date('2026-10-02T12:05:00.000Z');
    expect(await inspectOwner(info(lockedAt), probe(true, started))).toBe('dead');
  });

  it('treated as alive when the start time is unknown', async () => {
    expect(await inspectOwner(info(lockedAt), probe(true, null))).toBe('alive');
  });

  it.skipIf(process.platform === 'win32')('reads the start time of a real process', async () => {
    const started = await systemProcessProbe.startTime(process.pid);
    expect(started).not.toBeNull();
    expect(Math.abs(Date.now() - (started as Date).getTime())).toBeLessThan(60 * 60 * 1000);
    expect(systemProcessProbe.isAlive(process.pid)).toBe(true);
  });
});

describe('takeover from a dead owner', () => {
  it('does not take over a lock whose owner is alive and leaves the files unchanged', async () => {
    await acquire('owner');
    const before = await lockFiles();
    expect(await acquire('intruder', alive)).toMatchObject({
      acquired: false,
      reason: 'held',
      holder: { ownerId: 'owner' },
    });
    expect(await lockFiles()).toEqual(before);
    expect(await holdsLock(dir, NAME, 'owner')).toBe(true);
  });

  it('takes over with the next generation without removing the lock when the owner is dead', async () => {
    await acquire('crashed');
    expect(await acquire('successor', dead)).toMatchObject({
      acquired: true,
      info: { generation: 2 },
    });
    expect(await holdsLock(dir, NAME, 'successor')).toBe(true);
    expect(await holdsLock(dir, NAME, 'crashed')).toBe(false);
  });

  it('only one succeeds when taking over concurrently', async () => {
    const crashedPid = 4_000_001;
    await acquireLock(dir, NAME, { pid: crashedPid, ownerId: 'crashed' }, alive);
    // Only the original owner is dead. Processes attempting the takeover see each other as alive.
    const onlyCrashedIsDead: ProcessProbe = {
      isAlive: (pid) => pid !== crashedPid,
      startTime: () => Promise.resolve(null),
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        acquireLock(
          dir,
          NAME,
          { pid: 5_000_000 + index, ownerId: `successor-${String(index)}` },
          onlyCrashedIsDead,
        ),
      ),
    );
    const winners = results.filter((result) => result.acquired);
    expect(winners).toHaveLength(1);
    const current = await readCurrentLock(dir, NAME);
    expect(current).toMatchObject({ generation: 2, released: false });
    expect(winners[0]).toMatchObject({ info: { ownerId: (current as LockInfo).ownerId } });
  });

  it('does not acquire by recreating a deleted generation when the generation advanced twice after the observation', async () => {
    // Generation 1 is released. A sees this, tries to create generation 2, and pauses right before creating it.
    await acquire('first');
    await releaseLock(dir, NAME, 'first');

    let resumeA: () => void = () => undefined;
    let aReachedLink: () => void = () => undefined;
    const aWaiting = new Promise<void>((resolve) => {
      aReachedLink = resolve;
    });
    let paused = false;
    const acquiringA = acquireLock(dir, NAME, { pid: process.pid, ownerId: 'A' }, alive, {
      beforeLink: async () => {
        // Pause only the first time. Retried acquisitions are not paused.
        if (paused) return;
        paused = true;
        aReachedLink();
        await new Promise<void>((resolve) => {
          resumeA = resolve;
        });
      },
    });
    await aWaiting;

    // Meanwhile, B acquires generation 2 and releases it, and C acquires generation 3. C deletes the generation 2 file.
    expect(await acquire('B')).toMatchObject({ acquired: true, info: { generation: 2 } });
    await releaseLock(dir, NAME, 'B');
    expect(await acquire('C')).toMatchObject({ acquired: true, info: { generation: 3 } });
    expect(await lockFiles()).toEqual([`${NAME}.000000000003`]);

    // A resumes. It can create the generation 2 file, but it is not the highest generation, so acquisition fails.
    resumeA();
    expect(await acquiringA).toMatchObject({
      acquired: false,
      reason: 'held',
      holder: { ownerId: 'C', generation: 3 },
    });
    expect(await holdsLock(dir, NAME, 'C')).toBe(true);
    expect(await holdsLock(dir, NAME, 'A')).toBe(false);
    // The generation 2 file recreated by A is not kept.
    expect(await lockFiles()).toEqual([`${NAME}.000000000003`]);
  });

  it('a takeover based on a stale observation does not break the lock of the current owner', async () => {
    // After the lock observed as dead (generation 1), another process has re-acquired as generation 2.
    await acquire('crashed');
    await acquire('fresh', dead);
    // Even if the process that saw generation 1 as dead tries to acquire, it sees the current generation 2 (alive) and gives up.
    expect(await acquire('late', alive)).toMatchObject({
      acquired: false,
      holder: { ownerId: 'fresh', generation: 2 },
    });
    expect(await holdsLock(dir, NAME, 'fresh')).toBe(true);
  });

  it('cannot acquire with a past generation number even across release and re-acquisition', async () => {
    await acquire('first');
    await releaseLock(dir, NAME, 'first');
    await acquire('second');
    await releaseLock(dir, NAME, 'second');
    const third = await acquire('third');
    expect(third).toMatchObject({ acquired: true, info: { generation: 3 } });
    expect(await holdsLock(dir, NAME, 'third')).toBe(true);
  });
});
