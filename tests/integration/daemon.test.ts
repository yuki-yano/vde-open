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

// daemonのlockが保持されているか。解放済みのfileは残る。
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

// すでに終了したprocessのpid。
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid;
}

describe('SYS-001 daemonが起動していないときのstatus', () => {
  it('stoppedを返し、新しく起動しない', async () => {
    const result = await t.run(['daemon', 'status', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.json<Status>().data).toMatchObject({
      state: 'stopped',
      daemonId: null,
      pid: null,
    });
    // state rootも作らない。
    expect(existsSync(t.home)).toBe(false);
    expect(
      (await t.run(['daemon', 'stop', '--json'])).json<{ wasRunning: boolean }>().data.wasRunning,
    ).toBe(false);
  });
});

describe('daemonの起動と停止', () => {
  it('必要なcommandで自動起動し、停止後はruntime fileを残さない', async () => {
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
    // lockは解放済みの印として残る。runtimeの位置を示すpointerは残らない。
    expect(
      readdirSync(t.home)
        .filter((name) => !/\.lock\.\d+$/.test(name))
        .toSorted(),
    ).toEqual(['blobs', 'logs', 'state.json']);
    expect(lockIsHeld()).toBe(false);
    expect(() => process.kill(running.pid as number, 0)).toThrow();
  });

  it('SYS-003（部分検証）再起動後に文書IDと順序を復元し、daemonIdは変わる', async () => {
    for (const name of ['a', 'b', 'c']) t.write(`${name}.md`, `# ${name}\n`);
    await t.run(['open', 'b.md', 'a.md', 'c.md', '--json']);
    const before = await listIds();
    const first = await status();

    const restarted = (await t.run(['daemon', 'restart', '--json'])).json<Status>();
    expect(restarted.data.state).toBe('running');
    expect(restarted.data.daemonId).not.toBe(first.daemonId);
    expect(await listIds()).toEqual(before);

    // 停止中にlistを呼ぶと、保存したstateを復元するdaemonが起動する。
    await t.run(['daemon', 'stop', '--json']);
    expect(await listIds()).toEqual(before);
  });
});

describe('SYS-006 lockの所有者が生きている', () => {
  it('古いlockでも壊さず、第二のdaemonを作らない', async () => {
    mkdirSync(t.home, { mode: 0o700 });
    // このtest processを所有者にする。lockの更新時刻は1時間前だが、processは生きている。
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
    // 所有者が生きているlockは、修復でも回収しない。
    // 所有者が生きているlockは、修復でも引き継がない。runtimeに置かれたfileにも触れない。
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

describe('SYS-007 停止済みの所有者が残したruntime', () => {
  it('所有者の停止を確かめてから回収し、起動できる', async () => {
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

  it('lockのpidが別のprocessに再利用されていても、そのprocessを止めない', async () => {
    mkdirSync(t.home, { mode: 0o700 });
    // lockを書いた後に起動した、無関係のprocess。
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
    // 無関係のprocessは動いたまま。
    expect(() => process.kill(unrelated.pid as number, 0)).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('SYS-008 安全でないstate rootとruntime', () => {
  it('state rootがsymlinkなら拒否する', async () => {
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

  it('起動済みのdaemonへも、symlinkのstate root経由では接続しない', async () => {
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

  it('安全でないstate rootは、doctorの修復でも変更しない', async () => {
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

  it('state rootが他者に開かれた権限なら拒否する', async () => {
    mkdirSync(t.home, { mode: 0o755 });
    t.write('a.md', '# a\n');
    const result = await t.run(['open', 'a.md', '--json']);
    expect(result.exitCode).toBe(5);
    expect(result.json().error.details['reason']).toBe('permissions');
  });

  it('runtime directoryがsymlinkなら、そこにsocketを作らない', async () => {
    const location = runtimeLocation();
    const elsewhere = join(tmpdir(), `vde-open-else-${Date.now().toString()}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(location.runtimeDir, '..'), { recursive: true, mode: 0o700 });
    // リンク先に、runtime fileと同じ名前の無関係なfileを置いておく。
    writeFileSync(join(elsewhere, 'ipc.sock'), 'unrelated socket');
    writeFileSync(join(elsewhere, 'ipc.key'), 'unrelated key');
    symlinkSync(elsewhere, location.runtimeDir);
    try {
      t.write('a.md', '# a\n');
      const result = await t.run(['open', 'a.md', '--json']);
      expect(result.exitCode).toBe(5);
      expect(result.json().error.code).toBe('E_INSECURE_PATH');
      // 拒否した後に、リンク先のfileを消したり書き換えたりしない。
      expect(readdirSync(elsewhere).toSorted()).toEqual(['ipc.key', 'ipc.sock']);
      expect(readFileSync(join(elsewhere, 'ipc.sock'), 'utf8')).toBe('unrelated socket');
      expect(readFileSync(join(elsewhere, 'ipc.key'), 'utf8')).toBe('unrelated key');
      // 起動に失敗したdaemonはlockを残さない。
      expect(lockIsHeld()).toBe(false);
    } finally {
      rmSync(location.runtimeDir, { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('SYS-011 / SYS-012 stateの破損と明示修復', () => {
  async function seedTwoCommits(): Promise<string[]> {
    t.write('a.md', '# a\n');
    t.write('b.md', '# b\n');
    await t.run(['open', 'a.md', '--json']);
    await t.run(['open', 'b.md', '--json']);
    const ids = await listIds();
    await t.run(['daemon', 'stop', '--json']);
    return ids;
  }

  it('破損したstateでは起動を止め、空stateで上書きせず、doctorが説明する', async () => {
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
    // 診断だけでは何も変えない。
    expect(readFileSync(statePath).equals(corrupted)).toBe(true);
  });

  it('未知のformatVersionでは起動を止め、修復の対象にもしない', async () => {
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

  it('--repairは--yesがなければ実行しない', async () => {
    await seedTwoCommits();
    writeFileSync(join(t.home, 'state.json'), 'broken');
    const result = await t.run(['doctor', '--repair', '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(readFileSync(join(t.home, 'state.json'), 'utf8')).toBe('broken');
  });

  it('--repair --yesは検証済みのbackupへ戻し、巻き戻りを報告する', async () => {
    const ids = await seedTwoCommits();
    writeFileSync(join(t.home, 'state.json'), 'broken');

    const repair = (await t.run(['doctor', '--repair', '--yes', '--json'])).json<Doctor>();
    expect(repair.data.repairs).toEqual(['state-restored-from-backup']);
    expect(repair.warnings.map((warning) => warning.code)).toEqual(['W_STATE_ROLLED_BACK']);
    expect(repair.data.state.status).toBe('ok');
    // 読めなかったstateは消さずに退避する。
    expect(readdirSync(t.home).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
    // backupは最後のcommitの直前。2件目の登録は失われている。
    expect(await listIds()).toEqual([ids[0]]);
  });

  it('backupも読めなければ、修復せずにそのまま残す', async () => {
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

  it('daemonが動作中なら修復を拒否する', async () => {
    t.write('a.md', '# a\n');
    await t.run(['open', 'a.md', '--json']);
    const result = await t.run(['doctor', '--repair', '--yes', '--json']);
    expect(result.exitCode).toBe(8);
    expect(result.json().error.code).toBe('E_DAEMON_LOCKED');
  });

  it('doctorの出力に本文やIPCのkeyを含めない', async () => {
    t.write('a.md', '# 秘密の見出し\n\n秘密の本文\n');
    await t.run(['open', 'a.md', '--json']);
    const key = readFileSync(runtimeLocation().keyPath);
    const output = (await t.run(['doctor', '--json'])).stdout;
    expect(output).not.toContain('秘密');
    expect(output).not.toContain(key.toString('hex'));
    expect(output).not.toContain(key.toString('base64'));
  });
});

describe('SEC-018（部分検証）daemonのlog', () => {
  it('本文・title・path・keyを記録しない', async () => {
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

describe('SYS-016 state homeの分離', () => {
  it('別のhomeは別のdaemonとstateを使い、互いに影響しない', async () => {
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

describe('前景のdaemon', () => {
  it('serveで前景に起動でき、SIGTERMで後始末して終了する', async () => {
    const { cliEntry } = await import('./harness.ts');
    const child = spawn(process.execPath, [cliEntry, 'serve'], {
      cwd: t.work,
      env: { ...process.env, VDE_OPEN_HOME: t.home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stderr?.once('data', () => resolve());
      child.once('exit', () => reject(new Error('serveが起動前に終了しました')));
    });
    const running = await status();
    expect(running).toMatchObject({ state: 'running', pid: child.pid });

    // すでに動いているdaemonがあるとき、2つ目の前景daemonは起動しない。
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
