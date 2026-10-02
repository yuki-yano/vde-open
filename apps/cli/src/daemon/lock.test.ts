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

describe('lockの取得と解放', () => {
  it('排他的に取得でき、所有者だけが解放できる', async () => {
    expect(await acquire('a')).toMatchObject({ acquired: true, info: { generation: 1 } });
    expect(await acquire('b')).toMatchObject({ acquired: false, reason: 'held' });
    expect(await holdsLock(dir, NAME, 'a')).toBe(true);

    await releaseLock(dir, NAME, 'b');
    expect(await holdsLock(dir, NAME, 'a')).toBe(true);
    await releaseLock(dir, NAME, 'a');
    expect(await holdsLock(dir, NAME, 'a')).toBe(false);
    expect(await readCurrentLock(dir, NAME)).toMatchObject({ ownerId: 'a', released: true });
  });

  it('解放後は次の世代として取得し、世代を再利用しない', async () => {
    await acquire('a');
    await releaseLock(dir, NAME, 'a');
    expect(await acquire('b')).toMatchObject({ acquired: true, info: { generation: 2 } });
    await releaseLock(dir, NAME, 'b');
    expect(await acquire('c')).toMatchObject({ acquired: true, info: { generation: 3 } });
    // 古い世代のfileは残さない。
    expect(await lockFiles()).toHaveLength(1);
  });

  it('同時に取得を試みても、成功するのは1つだけ', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => acquire(`owner-${String(index)}`)),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it('読めないlockは引き継がない', async () => {
    await writeFile(join(dir, `${NAME}.000000000001`), '{broken');
    expect(await readCurrentLock(dir, NAME)).toBe('invalid');
    expect(await acquire('a')).toEqual({ acquired: false, reason: 'invalid', holder: null });
    expect(await lockFiles()).toEqual([`${NAME}.000000000001`]);
  });
});

describe('SYS-006 / SYS-007 所有者の生存判定', () => {
  const lockedAt = '2026-10-02T12:00:00.000Z';
  const info = (startedAt: string): LockInfo => ({
    generation: 1,
    pid: process.pid,
    ownerId: 'a',
    startedAt,
    released: false,
  });

  it('processが無ければ停止済み', async () => {
    expect(await inspectOwner(info(lockedAt), dead)).toBe('dead');
  });

  it('processがあり、lockより前から動いていれば生存', async () => {
    const started = new Date('2026-10-02T11:59:59.000Z');
    expect(await inspectOwner(info(lockedAt), probe(true, started))).toBe('alive');
  });

  it('processがlockより後に起動していれば、pidの再利用なので停止済み', async () => {
    const started = new Date('2026-10-02T12:05:00.000Z');
    expect(await inspectOwner(info(lockedAt), probe(true, started))).toBe('dead');
  });

  it('起動時刻が分からなければ、生存として扱う', async () => {
    expect(await inspectOwner(info(lockedAt), probe(true, null))).toBe('alive');
  });

  it.skipIf(process.platform === 'win32')('実際のprocessの起動時刻を取得できる', async () => {
    const started = await systemProcessProbe.startTime(process.pid);
    expect(started).not.toBeNull();
    expect(Math.abs(Date.now() - (started as Date).getTime())).toBeLessThan(60 * 60 * 1000);
    expect(systemProcessProbe.isAlive(process.pid)).toBe(true);
  });
});

describe('停止済みの所有者からの引き継ぎ', () => {
  it('所有者が生きているlockは引き継がず、fileも変えない', async () => {
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

  it('所有者が停止済みなら、lockを外さずに次の世代で引き継ぐ', async () => {
    await acquire('crashed');
    expect(await acquire('successor', dead)).toMatchObject({
      acquired: true,
      info: { generation: 2 },
    });
    expect(await holdsLock(dir, NAME, 'successor')).toBe(true);
    expect(await holdsLock(dir, NAME, 'crashed')).toBe(false);
  });

  it('同時に引き継ぎを試みても、取得に成功するのは1つだけ', async () => {
    const crashedPid = 4_000_001;
    await acquireLock(dir, NAME, { pid: crashedPid, ownerId: 'crashed' }, alive);
    // 停止したのは元の所有者だけ。引き継ぎを試みるprocessは、互いを生存と判定する。
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

  it('観測の後に世代が2回進んでいたら、消された世代を作り直しても取得は成立しない', async () => {
    // 世代1は解放済み。Aはこれを見て世代2を作ろうとし、作成の直前で止まる。
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
        // 最初の1回だけ止める。やり直しの取得は止めない。
        if (paused) return;
        paused = true;
        aReachedLink();
        await new Promise<void>((resolve) => {
          resumeA = resolve;
        });
      },
    });
    await aWaiting;

    // その間に、Bが世代2を取得して解放し、Cが世代3を取得する。Cは世代2のfileを消す。
    expect(await acquire('B')).toMatchObject({ acquired: true, info: { generation: 2 } });
    await releaseLock(dir, NAME, 'B');
    expect(await acquire('C')).toMatchObject({ acquired: true, info: { generation: 3 } });
    expect(await lockFiles()).toEqual([`${NAME}.000000000003`]);

    // Aが再開する。世代2のfileは作れてしまうが、最大の世代ではないので取得は成立しない。
    resumeA();
    expect(await acquiringA).toMatchObject({
      acquired: false,
      reason: 'held',
      holder: { ownerId: 'C', generation: 3 },
    });
    expect(await holdsLock(dir, NAME, 'C')).toBe(true);
    expect(await holdsLock(dir, NAME, 'A')).toBe(false);
    // Aが作り直した世代2のfileは残さない。
    expect(await lockFiles()).toEqual([`${NAME}.000000000003`]);
  });

  it('古い観測にもとづく引き継ぎは、現在の所有者のlockを壊さない', async () => {
    // 停止済みと観測したlock（世代1）の後に、別のprocessが世代2を取り直している。
    await acquire('crashed');
    await acquire('fresh', dead);
    // 世代1を停止済みと見ていたprocessが取得を試みても、現在の世代2（生存）を見て諦める。
    expect(await acquire('late', alive)).toMatchObject({
      acquired: false,
      holder: { ownerId: 'fresh', generation: 2 },
    });
    expect(await holdsLock(dir, NAME, 'fresh')).toBe(true);
  });

  it('解放と再取得を挟んでも、過去の世代番号では取得できない', async () => {
    await acquire('first');
    await releaseLock(dir, NAME, 'first');
    await acquire('second');
    await releaseLock(dir, NAME, 'second');
    const third = await acquire('third');
    expect(third).toMatchObject({ acquired: true, info: { generation: 3 } });
    expect(await holdsLock(dir, NAME, 'third')).toBe(true);
  });
});
