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
import { createParseService, type ParseService } from '../workers/parse-service.ts';
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
  // A daemon that lost its lock does not delete runtime files it cannot confirm as its own. Delete them as test cleanup.
  const { runtimeDir } = resolveRuntimeLocation(resolveStateRoot(environment), environment);
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

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

describe('diagnostics overlapping with stop', () => {
  it('does not delay stopping while diagnostics wait for index sync', async () => {
    // Slow down parsing so index sync takes a while (8 documents x 500ms).
    const real = createParseService();
    const slow: ParseService = {
      ...real,
      analyze: async (format, text) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return real.analyze(format, text);
      },
    };
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(base, `${String(index)}.md`), `# Document ${String(index)}\n\nBody\n`);
    }
    daemon = await startDaemon({ environment, version: 'test', parse: slow });
    for (let index = 0; index < 8; index += 1) await openDocument(`${String(index)}.md`);
    const connection = await createDaemonControl(environment).connectExisting();
    if (!connection) throw new Error('Cannot connect to the daemon.');
    const diagnosing = connection
      .request('daemon.diagnostics', { collectGarbage: true }, { timeoutMs: 30_000 })
      .then(
        (envelope) => (envelope.ok ? 'completed' : envelope.error.code),
        (error: { code: string }) => error.code,
      );
    // Stop after diagnostics start waiting for index sync.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await daemon.stop('test');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(['E_DAEMON_STOPPING', 'E_DAEMON_UNAVAILABLE']).toContain(await diagnosing);
    connection.close();
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
