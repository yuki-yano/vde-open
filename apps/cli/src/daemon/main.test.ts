import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonControl } from '../cli/daemon-control.ts';
import { runCli } from '../cli/run.ts';
import {
  resolveRuntimeLocation,
  resolveStateRoot,
  type PathEnvironment,
} from '../persistence/paths.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { createParseService } from '../workers/parse-service.ts';
import { holdsLock, readCurrentLock } from './lock.ts';
import { startDaemon, type DaemonHandle } from './main.ts';

let base: string;
let environment: PathEnvironment;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vde-open-daemon-'));
  environment = {
    env: { ...process.env, VDE_OPEN_HOME: join(base, 'home'), VDE_OPEN_TEST_EPHEMERAL_PORTS: '1' },
    platform: process.platform,
    homeDir: base,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
  daemon = null;
});

afterEach(async () => {
  await daemon?.stop('test-cleanup');
  // A daemon that lost its lock does not delete runtime files it cannot confirm as its own. Delete them as test cleanup.
  const { runtimeDir } = resolveRuntimeLocation(resolveStateRoot(environment), environment);
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

// No daemon holds the state after a failed start.
const lockFree = async () => {
  const lock = await readCurrentLock(resolveStateRoot(environment), 'daemon.lock');
  return lock === null || (lock !== 'invalid' && lock.released);
};

async function openDocument(path: string) {
  const connection = await createDaemonControl(environment).connectExisting();
  if (!connection) throw new Error('Cannot connect to the daemon.');
  try {
    return await connection.request<{ documents: Array<{ documentId: string }>; created: number }>(
      'documents.open',
      { cwd: base, paths: [path] },
    );
  } finally {
    connection.close();
  }
}

describe('SYS-010 save failure after the replace (at the daemon level)', () => {
  it('returns E_COMMIT_INDETERMINATE and exits, and a resend after restart is not applied twice', async () => {
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
    // The daemon stops writing and exits, leaving no runtime files or lock.
    await daemon.stopped;
    expect(await createDaemonControl(environment).connectExisting()).toBeNull();

    // After a restart, the state on disk is authoritative. Resending the same operation still leaves one document.
    daemon = await startDaemon({ environment, version: 'test' });
    const retried = await openDocument('a.md');
    expect(retried).toMatchObject({ ok: true, data: { created: 0 } });
    const connection = await createDaemonControl(environment).connectExisting();
    const list = await connection?.request<{ totalDocuments: number }>('documents.list', {});
    connection?.close();
    expect(list).toMatchObject({ ok: true, data: { totalDocuments: 1 } });
  });
});

describe('a daemon that lost its lock', () => {
  it('stops writing and exits without touching the successor lock and runtime files', async () => {
    daemon = await startDaemon({ environment, version: 'test' });
    const home = join(base, 'home');
    const { keyPath } = resolveRuntimeLocation(home, environment);
    const keyBefore = await readFile(keyPath);
    // Simulate another owner having acquired the next generation of the lock.
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

describe('stop overlapping with a commit', () => {
  it('keeps the lock until the running commit finishes and does not let the next daemon start', async () => {
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
      // Pause right before writing the next state temporary file.
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

    // While the commit is in progress, stopping does not complete and the lock is still held.
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

    // After stopping completes, it can start and restores the committed document.
    daemon = await startDaemon({ environment, version: 'test' });
    const connection = await createDaemonControl(environment).connectExisting();
    const list = await connection?.request<{ totalDocuments: number }>('documents.list', {});
    connection?.close();
    expect(list).toMatchObject({ ok: true, data: { totalDocuments: 1 } });
  });

  it('rejects requests after stopping has begun', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    daemon = await startDaemon({ environment, version: 'test' });
    const connection = await createDaemonControl(environment).connectExisting();
    if (!connection) throw new Error('Cannot connect to the daemon.');
    const stopping = daemon.stop('test');
    // Depending on how far stopping has progressed, this is either a rejection response or a dropped connection. It never succeeds.
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

describe.skipIf(process.platform === 'win32')('SYS-008 insecure state root and runtime', () => {
  it('the CLI does not connect to a running daemon through a symlinked state root', async () => {
    daemon = await startDaemon({ environment, version: 'test' });
    const link = join(base, 'home-link');
    await symlink(join(base, 'home'), link);
    let stdout = '';
    const exitCode = await runCli(['daemon', 'status', '--json'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      cwd: base,
      environment: { ...environment, env: { ...environment.env, VDE_OPEN_HOME: link } },
      stdoutIsTty: false,
      stdin: { isPiped: false, read: () => Promise.resolve(Buffer.alloc(0)) },
    });
    expect(exitCode).toBe(5);
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: 'E_INSECURE_PATH', details: { reason: 'symlink' } },
    });
  });

  it('does not create the socket in a runtime directory that is a symlink, and leaves the link target alone', async () => {
    const { runtimeDir, socketPath } = resolveRuntimeLocation(
      resolveStateRoot(environment),
      environment,
    );
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await writeFile(join(elsewhere, basename(socketPath)), 'unrelated');
    await mkdir(dirname(runtimeDir), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, runtimeDir);

    await expect(startDaemon({ environment, version: 'test' })).rejects.toMatchObject({
      code: 'E_INSECURE_PATH',
    });
    expect(await readdir(elsewhere)).toEqual([basename(socketPath)]);
    expect(await readFile(join(elsewhere, basename(socketPath)), 'utf8')).toBe('unrelated');
    expect(await lockFree()).toBe(true);
  });
});

describe('SEC-018 daemon log', () => {
  it('records IPC requests without the body, title, path, document key, or IPC key', async () => {
    const work = join(base, 'work');
    await mkdir(work);
    await writeFile(join(work, '極秘の計画.md'), '# 極秘の見出し\n\n極秘の本文\n');
    daemon = await startDaemon({ environment, version: 'test' });
    const ipcKey = await readFile(
      resolveRuntimeLocation(resolveStateRoot(environment), environment).keyPath,
    );
    const connection = await createDaemonControl(environment).connectExisting();
    if (!connection) throw new Error('Cannot connect to the daemon.');
    try {
      const opened = await connection.request<{ documents: Array<{ documentId: string }> }>(
        'documents.open',
        { cwd: work, paths: ['極秘の計画.md'], key: 'himitsu-key' },
      );
      const documentId = opened.ok ? opened.data.documents[0]?.documentId : undefined;
      expect(await connection.request('documents.read', { documentId })).toMatchObject({
        ok: true,
      });
    } finally {
      connection.close();
    }
    await daemon.stop('test');

    const log = await readFile(join(base, 'home', 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).toContain('"event":"ipc.request"');
    for (const secret of [
      '極秘',
      'himitsu-key',
      work,
      ipcKey.toString('hex'),
      ipcKey.toString('base64'),
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('a failing shutdown step', () => {
  it.each([
    ['throws', () => Promise.reject(new Error('close failed'))],
    ['never finishes', () => new Promise<void>(() => undefined)],
  ] as const)(
    'when closing the parse worker %s, the daemon still stops and releases its lock',
    async (_name, close) => {
      const real = createParseService();
      daemon = await startDaemon({
        environment,
        version: 'test',
        parse: { ...real, close: () => real.close().then(close) },
      });
      const home = resolveStateRoot(environment);
      expect(await holdsLock(home, 'daemon.lock', daemon.daemonId)).toBe(true);
      await daemon.stop('test');
      expect(await holdsLock(home, 'daemon.lock', daemon.daemonId)).toBe(false);
      const log = await readFile(join(home, 'logs', 'daemon.jsonl'), 'utf8');
      expect(log).toContain('"event":"daemon.shutdown_failed"');
      expect(log).toContain('"step":"parse"');
      expect(log).toContain('"event":"daemon.shutdown"');
    },
    15_000,
  );
});

describe('unknown method and invalid arguments', () => {
  it('responds with an error code and the daemon keeps running', async () => {
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

// A port another socket keeps in use, and a port that is free right now (released before returning).
async function occupy(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const portOf = (server: Server) => (server.address() as { port: number }).port;
async function freePort(): Promise<number> {
  const server = await occupy();
  const port = portOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function previewOriginOf(uiUrl: string): Promise<string> {
  const response = await fetch(`${uiUrl}_/api/v1/status`);
  return ((await response.json()) as { data: { previewOrigin: string } }).data.previewOrigin;
}

describe('fixed listener ports (listeners.json)', () => {
  const configPath = () => join(base, 'home', 'listeners.json');
  const writeConfig = async (text: string) => {
    await mkdir(join(base, 'home'), { recursive: true, mode: 0o700 });
    await writeFile(configPath(), text);
  };

  it('a restart with the saved ports gets the same URLs; start arguments are used once and not saved', async () => {
    // First start on OS-assigned ports, then save the ports it got.
    daemon = await startDaemon({ environment, version: 'test' });
    const first = { ui: daemon.uiUrl, preview: await previewOriginOf(daemon.uiUrl) };
    const ports = {
      managementPort: Number(new URL(first.ui).port),
      previewPort: Number(new URL(first.preview).port),
    };
    await daemon.stop('test');
    await writeConfig(JSON.stringify(ports));

    daemon = await startDaemon({ environment, version: 'test' });
    expect(daemon.uiUrl).toBe(first.ui);
    expect(await previewOriginOf(daemon.uiUrl)).toBe(first.preview);
    await daemon.stop('test');

    // An argument overrides the file for this start only.
    const override = await freePort();
    daemon = await startDaemon({ environment, version: 'test', managementPort: override });
    expect(daemon.uiUrl).toBe(`http://127.0.0.1:${String(override)}/`);
    await daemon.stop('test');
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(ports);

    daemon = await startDaemon({ environment, version: 'test' });
    expect(daemon.uiUrl).toBe(first.ui);
  });

  it('a busy management port fails the start with its purpose and port, and leaves nothing behind', async () => {
    const busy = await occupy();
    const previewPort = await freePort();
    try {
      await writeConfig(JSON.stringify({ managementPort: portOf(busy), previewPort }));
      await expect(startDaemon({ environment, version: 'test' })).rejects.toMatchObject({
        code: 'E_DAEMON_START_FAILED',
        message: expect.stringContaining(`management listener`),
        details: {
          reason: 'listen',
          listener: 'management',
          port: portOf(busy),
          cause: 'EADDRINUSE',
        },
      });
      expect(await lockFree()).toBe(true);
      await expect(
        access(join(resolveStateRoot(environment), 'runtime-pointer.json')),
      ).rejects.toThrow();
      // The preview listener started first was closed: its port can be taken again.
      const again = createServer();
      await new Promise<void>((resolve, reject) => {
        again.once('error', reject);
        again.listen(previewPort, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => again.close(resolve));
      // The other socket keeps running.
      expect(busy.listening).toBe(true);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
    // Once the port is free, the same settings start.
    daemon = await startDaemon({ environment, version: 'test' });
  });

  it('a busy preview port names the preview listener', async () => {
    const busy = await occupy();
    try {
      await expect(
        startDaemon({ environment, version: 'test', previewPort: portOf(busy) }),
      ).rejects.toMatchObject({
        code: 'E_DAEMON_START_FAILED',
        details: { listener: 'preview', port: portOf(busy) },
      });
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it.each([
    ['not JSON', '{', 'json'],
    ['an unknown key', '{"port": 1}', 'invalid:root'],
  ])('settings that are %s fail the start with the cause', async (_name, text, issue) => {
    await writeConfig(text);
    await expect(startDaemon({ environment, version: 'test' })).rejects.toMatchObject({
      code: 'E_DAEMON_START_FAILED',
      details: { reason: 'listener-config', issue },
    });
    expect(await lockFree()).toBe(true);
  });

  it('a listeners.json link whose target is gone is a start error, not the defaults', async () => {
    await mkdir(join(base, 'home'), { recursive: true, mode: 0o700 });
    await symlink(join(base, 'moved-away.json'), configPath());
    await expect(startDaemon({ environment, version: 'test' })).rejects.toMatchObject({
      code: 'E_DAEMON_START_FAILED',
      details: { reason: 'listener-config', issue: 'ENOENT' },
    });
  });

  it('the same port for both PC listeners is a start error', async () => {
    const port = await freePort();
    await expect(
      startDaemon({ environment, version: 'test', managementPort: port, previewPort: port }),
    ).rejects.toMatchObject({
      code: 'E_DAEMON_START_FAILED',
      details: { reason: 'duplicate-port' },
    });
  });
});
