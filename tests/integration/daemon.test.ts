import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRuntimeLocation } from '../../apps/cli/src/persistence/paths.ts';
import { createTestHome, type TestHome } from './harness.ts';

interface Status {
  state: 'running' | 'stopped';
  daemonId: string | null;
  pid: number | null;
  openDocuments: number | null;
}
interface Doctor {
  state: { status: string; storeVersion: number | null };
  previousState: { status: string };
  daemon: { reachable: boolean; lock: string };
  problems: Array<{ code: string; repairable: boolean }>;
  repairs: string[];
}

let t: TestHome;
const children: ChildProcess[] = [];

beforeEach(() => {
  t = createTestHome();
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await t.cleanup();
});

const status = async () => (await t.run(['daemon', 'status', '--json'])).json<Status>().data;
const listIds = async () =>
  (await t.run(['list', '--json']))
    .json<{ documents: Array<{ documentId: string }> }>()
    .data.documents.map((document) => document.documentId);

function runtimeLocation() {
  return resolveRuntimeLocation(t.home, {
    env: {},
    platform: process.platform,
    homeDir: '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
}

const LOCK_GENERATION_ONE = 'daemon.lock.000000000001';

function writeLock(owner: { pid: number; ownerId: string; startedAt: string }): string {
  const path = join(t.home, LOCK_GENERATION_ONE);
  writeFileSync(path, `${JSON.stringify({ generation: 1, released: false, ...owner })}\n`, {
    mode: 0o600,
  });
  return path;
}

// Whether the daemon lock is held. A released lock file remains.
function lockIsHeld(): boolean {
  if (!existsSync(t.home)) return false;
  const files = readdirSync(t.home)
    .filter((name) => /^daemon\.lock\.\d+$/.test(name))
    .toSorted();
  const latest = files.at(-1);
  if (!latest) return false;
  return !(JSON.parse(readFileSync(join(t.home, latest), 'utf8')) as { released: boolean })
    .released;
}

// pid of a process that has already exited.
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid;
}

describe('SYS-001 status when the daemon is not running', () => {
  it('returns stopped and does not start a new one', async () => {
    const result = await t.run(['daemon', 'status', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.json<Status>().data).toMatchObject({
      state: 'stopped',
      daemonId: null,
      pid: null,
    });
    // Does not create the state root either.
    expect(existsSync(t.home)).toBe(false);
    expect(
      (await t.run(['daemon', 'stop', '--json'])).json<{ wasRunning: boolean }>().data.wasRunning,
    ).toBe(false);
  });
});

describe('starting and stopping the daemon', () => {
  it('starts automatically for commands that need it, and leaves no runtime files after stopping', async () => {
    t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    const running = await status();
    expect(running).toMatchObject({ state: 'running', openDocuments: 1 });
    const location = runtimeLocation();
    expect(existsSync(location.socketPath)).toBe(true);

    const stopped = (await t.run(['daemon', 'stop', '--json'])).json<{ wasRunning: boolean }>();
    expect(stopped.data.wasRunning).toBe(true);
    expect((await status()).state).toBe('stopped');
    expect(existsSync(location.socketPath)).toBe(false);
    expect(existsSync(location.keyPath)).toBe(false);
    // The lock remains as a released marker. The pointer to the runtime location does not.
    expect(
      readdirSync(t.home)
        .filter((name) => !/\.lock\.\d+$/.test(name))
        .toSorted(),
    ).toEqual(['blobs', 'logs', 'state.json']);
    expect(lockIsHeld()).toBe(false);
    expect(() => process.kill(running.pid as number, 0)).toThrow();
  });

  it('SYS-003 (partial) restores document IDs and order after a restart, and the daemonId changes', async () => {
    for (const name of ['a', 'b', 'c']) t.write(`${name}.md`, `# ${name}\n`);
    await t.run(['open', 'b.md', 'a.md', 'c.md', '--json']);
    const before = await listIds();
    const first = await status();

    const restarted = (await t.run(['daemon', 'restart', '--json'])).json<Status>();
    expect(restarted.data.state).toBe('running');
    expect(restarted.data.daemonId).not.toBe(first.daemonId);
    expect(await listIds()).toEqual(before);

    // Calling list while stopped starts a daemon that restores the saved state.
    await t.run(['daemon', 'stop', '--json']);
    expect(await listIds()).toEqual(before);
  });
});

describe('SYS-006 the lock owner is alive', () => {
  it('does not break even an old lock, and does not create a second daemon', async () => {
    mkdirSync(t.home, { mode: 0o700 });
    // Make this test process the owner. The lock mtime is an hour ago, but the process is alive.
    const lockPath = writeLock({
      pid: process.pid,
      ownerId: 'daemon_old',
      startedAt: new Date().toISOString(),
    });
    const lock = readFileSync(lockPath, 'utf8');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, anHourAgo, anHourAgo);
    t.write('a.md', '# a\n');

    const result = await t.run(['open', 'a.md', '--json']);
    expect(result.exitCode).toBe(8);
    expect(result.json().error).toMatchObject({
      code: 'E_DAEMON_LOCKED',
      details: { reason: 'owner-alive' },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
    expect(existsSync(join(t.home, 'state.json'))).toBe(false);
    expect((await status()).state).toBe('stopped');

    const doctor = (await t.run(['doctor', '--json'])).json<Doctor>();
    expect(doctor.data.daemon).toMatchObject({ reachable: false, lock: 'owner-alive' });
    // A lock whose owner is alive is not reclaimed even by repair.
    // A lock whose owner is alive is not taken over even by repair. Files in the runtime are not touched either.
    const location = runtimeLocation();
    mkdirSync(location.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(location.keyPath, 'live-key');
    const repair = await t.run(['doctor', '--repair', '--yes', '--json']);
    expect(repair.exitCode).toBe(8);
    expect(repair.json().error.code).toBe('E_DAEMON_LOCKED');
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
    expect(readFileSync(location.keyPath, 'utf8')).toBe('live-key');
    expect(readdirSync(t.home).filter((name) => name.startsWith('daemon.lock.'))).toEqual([
      LOCK_GENERATION_ONE,
    ]);
    rmSync(lockPath);
  });
});

describe('SYS-007 runtime left by a stopped owner', () => {
  it('reclaims after confirming the owner has stopped, and can start', async () => {
    mkdirSync(t.home, { mode: 0o700 });
    const location = runtimeLocation();
    mkdirSync(location.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(location.socketPath, '');
    writeLock({ pid: deadPid(), ownerId: 'daemon_dead', startedAt: new Date().toISOString() });
    writeFileSync(
      join(t.home, 'runtime-pointer.json'),
      JSON.stringify({
        daemonId: 'daemon_dead',
        pid: 1,
        protocolVersion: 1,
        version: '0.0.0',
        startedAt: new Date().toISOString(),
        ...location,
      }),
    );

    const doctor = (await t.run(['doctor', '--json'])).json<Doctor>();
    expect(doctor.data.daemon.lock).toBe('owner-stopped');
    expect(doctor.data.problems).toEqual([
      expect.objectContaining({ code: 'W_STALE_RUNTIME', repairable: true }),
    ]);

    t.write('a.md', '# a\n');
    const opened = await t.run(['open', 'a.md', '--json']);
    expect(opened.exitCode, opened.stderr + opened.stdout).toBe(0);
    expect((await status()).state).toBe('running');
  });

  it('does not stop a process that reused the pid in the lock', async () => {
    mkdirSync(t.home, { mode: 0o700 });
    // An unrelated process started after the lock was written.
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    children.push(unrelated);
    writeLock({ pid: unrelated.pid as number, ownerId: 'daemon_reused', startedAt });

    const repair = (await t.run(['doctor', '--repair', '--yes', '--json'])).json<Doctor>();
    expect(repair.data.repairs).toEqual(['stale-runtime-removed']);
    t.write('a.md', '# a\n');
    expect((await t.run(['open', 'a.md', '--json'])).exitCode).toBe(0);
    // The unrelated process keeps running.
    expect(() => process.kill(unrelated.pid as number, 0)).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('SYS-008 insecure state root and runtime', () => {
  it('rejects a state root that is a symlink', async () => {
    const real = join(tmpdir(), `vde-open-real-${Date.now().toString()}`);
    mkdirSync(real, { mode: 0o700 });
    try {
      symlinkSync(real, t.home);
      t.write('a.md', '# a\n');
      const result = await t.run(['open', 'a.md', '--json']);
      expect(result.exitCode).toBe(5);
      expect(result.json().error).toMatchObject({
        code: 'E_INSECURE_PATH',
        details: { reason: 'symlink' },
      });
      expect(readdirSync(real)).toEqual([]);
    } finally {
      rmSync(t.home, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('does not connect even to a running daemon through a symlinked state root', async () => {
    t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    const link = `${t.home}-link`;
    symlinkSync(t.home, link);
    try {
      const viaLink = await t.run(['open', 'a.md', '--json'], { env: { VDE_OPEN_HOME: link } });
      expect(viaLink.exitCode).toBe(5);
      expect(viaLink.json().error).toMatchObject({
        code: 'E_INSECURE_PATH',
        details: { reason: 'symlink' },
      });
      const viaLinkStatus = await t.run(['daemon', 'status', '--json'], {
        env: { VDE_OPEN_HOME: link },
      });
      expect(viaLinkStatus.exitCode).toBe(5);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('does not modify an insecure state root even in doctor repair', async () => {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    await t.run(['open', 'a.md', '--json']);
    await t.run(['open', 'b.md', '--json']);
    await t.run(['daemon', 'stop', '--json']);
    writeFileSync(join(t.home, 'state.json'), 'broken');
    const link = `${t.home}-link`;
    symlinkSync(t.home, link);
    try {
      const report = (await t.run(['doctor', '--json'], { env: { VDE_OPEN_HOME: link } })).json<{
        stateRoot: { secure: boolean; reason: string };
      }>();
      expect(report.data.stateRoot).toMatchObject({ secure: false, reason: 'symlink' });

      const repair = await t.run(['doctor', '--repair', '--yes', '--json'], {
        env: { VDE_OPEN_HOME: link },
      });
      expect(repair.exitCode).toBe(5);
      expect(repair.json().error.code).toBe('E_INSECURE_PATH');
      expect(readFileSync(join(t.home, 'state.json'), 'utf8')).toBe('broken');
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('rejects a state root whose permissions are open to others', async () => {
    mkdirSync(t.home, { mode: 0o755 });
    t.write('a.md', '# a\n');
    const result = await t.run(['open', 'a.md', '--json']);
    expect(result.exitCode).toBe(5);
    expect(result.json().error.details['reason']).toBe('permissions');
  });

  it('does not create the socket in a runtime directory that is a symlink', async () => {
    const location = runtimeLocation();
    const elsewhere = join(tmpdir(), `vde-open-else-${Date.now().toString()}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(location.runtimeDir, '..'), { recursive: true, mode: 0o700 });
    // Put unrelated files with the same names as the runtime files at the link target.
    writeFileSync(join(elsewhere, 'ipc.sock'), 'unrelated socket');
    writeFileSync(join(elsewhere, 'ipc.key'), 'unrelated key');
    symlinkSync(elsewhere, location.runtimeDir);
    try {
      t.write('a.md', '# a\n');
      const result = await t.run(['open', 'a.md', '--json']);
      expect(result.exitCode).toBe(5);
      expect(result.json().error.code).toBe('E_INSECURE_PATH');
      // After rejecting, the files at the link target are neither removed nor rewritten.
      expect(readdirSync(elsewhere).toSorted()).toEqual(['ipc.key', 'ipc.sock']);
      expect(readFileSync(join(elsewhere, 'ipc.sock'), 'utf8')).toBe('unrelated socket');
      expect(readFileSync(join(elsewhere, 'ipc.key'), 'utf8')).toBe('unrelated key');
      // A daemon that failed to start leaves no lock.
      expect(lockIsHeld()).toBe(false);
    } finally {
      rmSync(location.runtimeDir, { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('SYS-011 / SYS-012 corrupt state and explicit repair', () => {
  async function seedTwoCommits(): Promise<string[]> {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    await t.run(['open', 'a.md', '--json']);
    await t.run(['open', 'b.md', '--json']);
    const ids = await listIds();
    await t.run(['daemon', 'stop', '--json']);
    return ids;
  }

  it('stops starting on corrupt state, does not overwrite with an empty state, and doctor explains', async () => {
    await seedTwoCommits();
    const statePath = join(t.home, 'state.json');
    writeFileSync(statePath, '{"formatVersion":1,"broken"');
    const corrupted = readFileSync(statePath);

    const result = await t.run(['list', '--json']);
    expect(result.exitCode).toBe(9);
    expect(result.json().error.code).toBe('E_STATE_CORRUPT');
    expect(readFileSync(statePath).equals(corrupted)).toBe(true);
    expect(lockIsHeld()).toBe(false);

    const doctor = (await t.run(['doctor', '--json'])).json<Doctor>();
    expect(doctor.data.state.status).toBe('corrupt');
    expect(doctor.data.previousState.status).toBe('ok');
    expect(doctor.data.problems).toEqual([
      expect.objectContaining({ code: 'E_STATE_CORRUPT', repairable: true }),
    ]);
    // Diagnosis alone changes nothing.
    expect(readFileSync(statePath).equals(corrupted)).toBe(true);
  });

  it('stops starting on an unknown formatVersion, and does not treat it as repairable', async () => {
    await seedTwoCommits();
    const statePath = join(t.home, 'state.json');
    const file = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    file['formatVersion'] = 99;
    writeFileSync(statePath, JSON.stringify(file));
    const future = readFileSync(statePath);

    const result = await t.run(['list', '--json']);
    expect(result.exitCode).toBe(9);
    expect(result.json().error.code).toBe('E_STATE_FORMAT_UNSUPPORTED');
    const repair = (await t.run(['doctor', '--repair', '--yes', '--json'])).json<Doctor>();
    expect(repair.data.repairs).toEqual([]);
    expect(readFileSync(statePath).equals(future)).toBe(true);
  });

  it('--repair does not run without --yes', async () => {
    await seedTwoCommits();
    writeFileSync(join(t.home, 'state.json'), 'broken');
    const result = await t.run(['doctor', '--repair', '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(readFileSync(join(t.home, 'state.json'), 'utf8')).toBe('broken');
  });

  it('--repair --yes restores the verified backup and reports the rollback', async () => {
    const ids = await seedTwoCommits();
    writeFileSync(join(t.home, 'state.json'), 'broken');

    const repair = (await t.run(['doctor', '--repair', '--yes', '--json'])).json<Doctor>();
    expect(repair.data.repairs).toEqual(['state-restored-from-backup']);
    expect(repair.warnings.map((warning) => warning.code)).toEqual(['W_STATE_ROLLED_BACK']);
    expect(repair.data.state.status).toBe('ok');
    // The unreadable state is set aside, not deleted.
    expect(readdirSync(t.home).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
    // The backup is from just before the last commit. The second registration is lost.
    expect(await listIds()).toEqual([ids[0]]);
  });

  it('leaves everything as is without repairing when the backup is unreadable too', async () => {
    await seedTwoCommits();
    writeFileSync(join(t.home, 'state.json'), 'broken');
    writeFileSync(join(t.home, 'state.prev.json'), 'also broken');
    const repair = (await t.run(['doctor', '--repair', '--yes', '--json'])).json<Doctor>();
    expect(repair.data.repairs).toEqual([]);
    expect(repair.data.problems).toEqual([
      expect.objectContaining({ code: 'E_STATE_CORRUPT', repairable: false }),
    ]);
    expect(readFileSync(join(t.home, 'state.json'), 'utf8')).toBe('broken');
  });

  it('refuses to repair while the daemon is running', async () => {
    t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    const result = await t.run(['doctor', '--repair', '--yes', '--json']);
    expect(result.exitCode).toBe(8);
    expect(result.json().error.code).toBe('E_DAEMON_LOCKED');
  });

  it('does not include the body or the IPC key in doctor output', async () => {
    t.write('a.md', '# 秘密の見出し\n\n秘密の本文\n');
    await t.run(['open', 'a.md', '--json']);
    const key = readFileSync(runtimeLocation().keyPath);
    const output = (await t.run(['doctor', '--json'])).stdout;
    expect(output).not.toContain('秘密');
    expect(output).not.toContain(key.toString('hex'));
    expect(output).not.toContain(key.toString('base64'));
  });
});

describe('SEC-018 (partial) daemon log', () => {
  it('does not record the body, title, path, or key', async () => {
    t.write('極秘の計画.md', '# 極秘の見出し\n\n極秘の本文\n');
    await t.run(['open', '極秘の計画.md', '--key', 'himitsu-key', '--json']);
    await t.run(['read', (await listIds())[0] as string, '--json']);
    const ipcKey = readFileSync(runtimeLocation().keyPath);
    await t.run(['daemon', 'stop', '--json']);

    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).toContain('"event":"ipc.request"');
    for (const secret of [
      '極秘',
      'himitsu-key',
      t.work,
      ipcKey.toString('hex'),
      ipcKey.toString('base64'),
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('SYS-016 isolation of state homes', () => {
  it('a different home uses a different daemon and state, without affecting each other', async () => {
    const other = createTestHome();
    try {
      t.write('a.md', '# a\n');
      other.write('b.md', '# b\n');
      await t.run(['open', 'a.md', '--json']);
      await other.run(['open', 'b.md', '--json']);

      const first = await status();
      const second = (await other.run(['daemon', 'status', '--json'])).json<Status>().data;
      expect(first.daemonId).not.toBe(second.daemonId);
      expect(first.pid).not.toBe(second.pid);
      expect(await listIds()).toHaveLength(1);

      await other.run(['daemon', 'stop', '--json']);
      expect((await status()).state).toBe('running');
      expect(await listIds()).toHaveLength(1);
    } finally {
      await other.cleanup();
    }
  });
});

describe('foreground daemon', () => {
  it('can start in the foreground with serve, and cleans up and exits on SIGTERM', async () => {
    const { cliEntry } = await import('./harness.ts');
    const child = spawn(process.execPath, [cliEntry, 'serve'], {
      cwd: t.work,
      env: { ...process.env, VDE_OPEN_HOME: t.home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stderr?.once('data', () => resolve());
      child.once('exit', () => reject(new Error('serve exited before starting')));
    });
    const running = await status();
    expect(running).toMatchObject({ state: 'running', pid: child.pid });

    // When a daemon is already running, a second foreground daemon does not start.
    const second = await t.run(['serve']);
    expect(second.exitCode).toBe(8);

    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect((await status()).state).toBe('stopped');
    expect(lockIsHeld()).toBe(false);
    renameSync(join(t.home, 'logs'), join(t.home, 'logs-kept'));
  });
});
