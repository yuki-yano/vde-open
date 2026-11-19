import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonControl } from '../cli/daemon-control.ts';
import { acquireLock, type ProcessProbe } from '../daemon/lock.ts';
import { createIpcKey } from '../daemon/runtime-files.ts';
import { resolveRuntimeLocation, type PathEnvironment } from '../persistence/paths.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { runDoctor } from './doctor.ts';

let base: string;
let home: string;
let environment: PathEnvironment;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vde-open-doctor-'));
  home = join(base, 'home');
  environment = {
    env: { VDE_OPEN_HOME: home },
    platform: process.platform,
    homeDir: base,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const statePath = () => join(home, 'state.json');

const doctor = (repair: boolean, probe?: ProcessProbe, env = environment) =>
  runDoctor({
    environment: env,
    control: createDaemonControl(env),
    version: 'test',
    repair,
    ...(probe && { probe }),
  });

// Leaves a verified state.json (storeVersion 2) and its backup state.prev.json (storeVersion 1).
async function seedTwoCommits(): Promise<void> {
  await mkdir(home, { mode: 0o700 });
  const store = await StateStore.open({ root: home, fs: nodeStoreFs });
  for (let commit = 0; commit < 2; commit += 1) {
    await store.transaction((tx) => {
      tx.state.catalogVersion += 1;
    });
  }
  await store.close();
}

describe('SYS-011 / SYS-012 doctor and repair of the state', () => {
  it('diagnosis changes nothing; repair restores the verified backup and sets the corrupt file aside', async () => {
    await seedTwoCommits();
    await writeFile(statePath(), 'broken');

    const diagnosis = await doctor(false);
    expect(diagnosis.report).toMatchObject({
      state: { status: 'corrupt' },
      previousState: { status: 'ok' },
      problems: [{ code: 'E_STATE_CORRUPT', repairable: true }],
      repairs: [],
    });
    expect(await readFile(statePath(), 'utf8')).toBe('broken');

    const repaired = await doctor(true);
    expect(repaired.report).toMatchObject({
      state: { status: 'ok' },
      repairs: ['state-restored-from-backup'],
    });
    expect(repaired.warnings.map((warning) => warning.code)).toEqual(['W_STATE_ROLLED_BACK']);
    const setAside = (await readdir(home)).filter((name) => name.startsWith('state.json.corrupt-'));
    expect(setAside).toHaveLength(1);
    expect(await readFile(join(home, setAside[0] as string), 'utf8')).toBe('broken');
    // The backup is the state from before the last commit.
    expect((await StateStore.open({ root: home, fs: nodeStoreFs })).storeVersion).toBe(1);
  });

  it.each([
    [
      'an unknown formatVersion',
      'E_STATE_FORMAT_UNSUPPORTED',
      async () => {
        const file = JSON.parse(await readFile(statePath(), 'utf8')) as Record<string, unknown>;
        file['formatVersion'] = 99;
        await writeFile(statePath(), JSON.stringify(file));
      },
    ],
    [
      'an unreadable backup',
      'E_STATE_CORRUPT',
      async () => {
        await writeFile(statePath(), 'broken');
        await writeFile(join(home, 'state.prev.json'), 'also broken');
      },
    ],
  ] as const)('with %s, repair leaves the state as it is', async (_name, code, damage) => {
    await seedTwoCommits();
    await damage();
    const before = await readFile(statePath());

    const { report } = await doctor(true);
    expect(report.repairs).toEqual([]);
    expect(report.problems).toEqual([expect.objectContaining({ code, repairable: false })]);
    expect((await readFile(statePath())).equals(before)).toBe(true);
  });

  it('does not put state content or the IPC key in the report', async () => {
    await seedTwoCommits();
    await writeFile(statePath(), '秘密の本文');
    const key = await createIpcKey(resolveRuntimeLocation(home, environment).keyPath);

    const output = JSON.stringify(await doctor(false));
    expect(output).toContain('E_STATE_CORRUPT');
    expect(output).not.toContain('秘密');
    expect(output).not.toContain(key.toString('hex'));
    expect(output).not.toContain(key.toString('base64'));
  });
});

describe('SYS-006 a lock whose owner is alive (a running daemon)', () => {
  it('is reported, and repair neither takes it over nor touches the runtime key, however old the lock is', async () => {
    const alive: ProcessProbe = { isAlive: () => true, startTime: () => Promise.resolve(null) };
    await mkdir(home, { mode: 0o700 });
    await acquireLock(home, 'daemon.lock', { pid: process.pid, ownerId: 'daemon_old' }, alive);
    const lockFiles = async () =>
      (await readdir(home)).filter((name) => name.startsWith('daemon.lock.'));
    const [lockName] = await lockFiles();
    const lockPath = join(home, lockName as string);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockPath, anHourAgo, anHourAgo);
    const lock = await readFile(lockPath, 'utf8');
    const { keyPath } = resolveRuntimeLocation(home, environment);
    await writeFile(keyPath, 'live-key');

    expect((await doctor(false, alive)).report.daemon).toMatchObject({
      reachable: false,
      lock: 'owner-alive',
    });
    await expect(doctor(true, alive)).rejects.toMatchObject({ code: 'E_DAEMON_LOCKED' });
    expect(await lockFiles()).toEqual([lockName]);
    expect(await readFile(lockPath, 'utf8')).toBe(lock);
    expect(await readFile(keyPath, 'utf8')).toBe('live-key');
  });
});

describe.skipIf(process.platform === 'win32')('SYS-008 a state root that is a symlink', () => {
  it('is reported as insecure, and repair refuses without changing anything behind the link', async () => {
    await seedTwoCommits();
    await writeFile(statePath(), 'broken');
    const link = join(base, 'home-link');
    await symlink(home, link);
    const viaLink = { ...environment, env: { VDE_OPEN_HOME: link } };

    expect((await doctor(false, undefined, viaLink)).report.stateRoot).toMatchObject({
      secure: false,
      reason: 'symlink',
    });
    await expect(doctor(true, undefined, viaLink)).rejects.toMatchObject({
      code: 'E_INSECURE_PATH',
    });
    expect(await readFile(statePath(), 'utf8')).toBe('broken');
  });
});
