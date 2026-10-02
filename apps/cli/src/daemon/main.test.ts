import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonControl } from '../cli/daemon-control.ts';
import {
  resolveRuntimeLocation,
  resolveStateRoot,
  type PathEnvironment,
} from '../persistence/paths.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { holdsLock } from './lock.ts';
import { startDaemon, type DaemonHandle } from './main.ts';

let base: string;
let environment: PathEnvironment;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vde-open-daemon-'));
  environment = {
    env: { ...process.env, VDE_OPEN_HOME: join(base, 'home') },
    platform: process.platform,
    homeDir: base,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
  daemon = null;
});

afterEach(async () => {
  await daemon?.stop('test-cleanup');
  // lockを失ったdaemonは、自分のものと確かめられないruntime fileを消さない。試験の後始末として消す。
  const { runtimeDir } = resolveRuntimeLocation(resolveStateRoot(environment), environment);
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

async function openDocument(path: string) {
  const connection = await createDaemonControl(environment).connectExisting();
  if (!connection) throw new Error('daemonへ接続できません');
  try {
    return await connection.request<{ documents: Array<{ documentId: string }>; created: number }>(
      'documents.open',
      { cwd: base, paths: [path] },
    );
  } finally {
    connection.close();
  }
}

describe('SYS-010 replace後の保存失敗（daemon単位）', () => {
  it('E_COMMIT_INDETERMINATEを返して終了し、再起動後の再送は二重に適用されない', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    let failSync = false;
    const fs: StoreFs = {
      ...nodeStoreFs,
      syncDirectory: (path) => {
        if (failSync && path === join(base, 'home')) {
          return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
        }
        return nodeStoreFs.syncDirectory(path);
      },
    };
    daemon = await startDaemon({ environment, version: 'test', fs });

    failSync = true;
    const failed = await openDocument('a.md');
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'E_COMMIT_INDETERMINATE', retryable: true },
    });
    // daemonは書込みを止めて終了し、runtime fileとlockを残さない。
    await daemon.stopped;
    expect(await createDaemonControl(environment).connectExisting()).toBeNull();

    // 再起動後はディスクのstateを正とする。同じ操作を再送しても文書は1件のまま。
    daemon = await startDaemon({ environment, version: 'test' });
    const retried = await openDocument('a.md');
    expect(retried).toMatchObject({ ok: true, data: { created: 0 } });
    const connection = await createDaemonControl(environment).connectExisting();
    const list = await connection?.request<{ totalDocuments: number }>('documents.list', {});
    connection?.close();
    expect(list).toMatchObject({ ok: true, data: { totalDocuments: 1 } });
  });
});

describe('lockを失ったdaemon', () => {
  it('書込みを止めて終了し、後継のlockとruntime fileに触れない', async () => {
    daemon = await startDaemon({ environment, version: 'test' });
    const home = join(base, 'home');
    const { keyPath } = resolveRuntimeLocation(home, environment);
    const keyBefore = await readFile(keyPath);
    // 別の所有者が、次の世代のlockを取った状態を作る。
    const successor = join(home, 'daemon.lock.000000000002');
    await writeFile(
      successor,
      `${JSON.stringify({ generation: 2, pid: process.pid, ownerId: 'successor', startedAt: new Date().toISOString(), released: false })}\n`,
    );
    await daemon.stopped;
    expect(JSON.parse(await readFile(successor, 'utf8'))).toMatchObject({
      ownerId: 'successor',
      released: false,
    });
    expect((await readFile(keyPath)).equals(keyBefore)).toBe(true);
  });
});

describe('停止とcommitの交差', () => {
  it('実行中のcommitが終わるまでlockを解放せず、次のdaemonを起動させない', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    const home = join(base, 'home');
    let releaseWrite: () => void = () => undefined;
    let enteredWrite: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let block = false;
    const fs: StoreFs = {
      ...nodeStoreFs,
      // 次stateの一時fileを書く直前で止める。
      writeFileDurable: async (path, data, mode) => {
        if (block && path.includes('.tmp-state-')) {
          enteredWrite();
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        }
        return nodeStoreFs.writeFileDurable(path, data, mode);
      },
    };
    daemon = await startDaemon({ environment, version: 'test', fs });

    block = true;
    const opening = openDocument('a.md');
    await entered;
    let stopFinished = false;
    const stopping = daemon.stop('test').then(() => {
      stopFinished = true;
    });

    // commitの途中では停止が完了せず、lockも保持したまま。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopFinished).toBe(false);
    expect(await holdsLock(home, 'daemon.lock', daemon.daemonId)).toBe(true);
    await expect(startDaemon({ environment, version: 'test' })).rejects.toMatchObject({
      code: 'E_DAEMON_LOCKED',
    });

    releaseWrite();
    await stopping;
    expect(await opening).toMatchObject({ ok: true, data: { created: 1 } });
    expect(await holdsLock(home, 'daemon.lock', daemon.daemonId)).toBe(false);

    // 停止が完了した後は起動でき、commit済みの文書を復元する。
    daemon = await startDaemon({ environment, version: 'test' });
    const connection = await createDaemonControl(environment).connectExisting();
    const list = await connection?.request<{ totalDocuments: number }>('documents.list', {});
    connection?.close();
    expect(list).toMatchObject({ ok: true, data: { totalDocuments: 1 } });
  });

  it('停止処理に入った後のrequestは受け付けない', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    daemon = await startDaemon({ environment, version: 'test' });
    const connection = await createDaemonControl(environment).connectExisting();
    if (!connection) throw new Error('daemonへ接続できません');
    const stopping = daemon.stop('test');
    // 停止の進み具合により、拒否の応答か、接続の切断のどちらかになる。成功にはならない。
    const outcome = await connection.request('documents.open', { cwd: base, paths: ['a.md'] }).then(
      (envelope) => (envelope.ok ? 'accepted' : envelope.error.code),
      (error: { code: string }) => error.code,
    );
    expect(['E_DAEMON_STOPPING', 'E_DAEMON_UNAVAILABLE']).toContain(outcome);
    connection.close();
    await stopping;

    daemon = await startDaemon({ environment, version: 'test' });
    const after = await createDaemonControl(environment).connectExisting();
    const list = await after?.request<{ totalDocuments: number }>('documents.list', {});
    after?.close();
    expect(list).toMatchObject({ ok: true, data: { totalDocuments: 0 } });
  });
});

describe('未知のmethodと不正な引数', () => {
  it('error codeで応答し、daemonは動き続ける', async () => {
    daemon = await startDaemon({ environment, version: 'test' });
    const connection = await createDaemonControl(environment).connectExisting();
    try {
      expect(await connection?.request('feedback.submit', {})).toMatchObject({
        ok: false,
        error: { code: 'E_UNKNOWN_METHOD' },
      });
      expect(await connection?.request('__proto__', {})).toMatchObject({
        ok: false,
        error: { code: 'E_UNKNOWN_METHOD' },
      });
      expect(
        await connection?.request('documents.read', { documentId: '../etc/passwd' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'E_INVALID_ARGUMENT' },
      });
      expect(await connection?.request('daemon.status', {})).toMatchObject({ ok: true });
    } finally {
      connection?.close();
    }
  });
});
