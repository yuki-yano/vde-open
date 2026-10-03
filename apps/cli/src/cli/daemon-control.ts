import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrorCode, VdeError, type DaemonStatus } from '@vde-open/shared';

import { acquireLock, readCurrentLock, releaseLock, systemProcessProbe } from '../daemon/lock.ts';
import {
  DAEMON_LOCK_NAME,
  readIpcKey,
  readPointer,
  START_LOCK_NAME,
} from '../daemon/runtime-files.ts';
import {
  ensurePrivateDirectory,
  inspectPrivateDirectory,
  requirePrivateDirectoryIfExists,
} from '../daemon/secure-dir.ts';
import { daemonEntryPath } from '../entry-paths.ts';
import { resolveStateRoot, type PathEnvironment } from '../persistence/paths.ts';
import { connectIpc, type IpcConnection } from '../server/ipc-client.ts';

// Spec 6.2: upper bound for waiting on startup.
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const LOCKED_RETRY_MS = 3000;

// Signal to abandon the connection process midway. When aborted, stop waiting for startup and
// checking the connection, and clear the timers (a daemon that has started continues starting).
export interface ConnectOptions {
  signal?: AbortSignal;
}

export interface DaemonControl {
  readonly stateRoot: string;
  // Connect to the running daemon. null if it is not running. Does not start a new one.
  connectExisting(options?: ConnectOptions): Promise<IpcConnection | null>;
  // Connect, or start the daemon first if none is running.
  ensure(options?: ConnectOptions): Promise<IpcConnection>;
  // Same as ensure. Also reports whether this call started a new daemon.
  ensureDetailed(
    options?: ConnectOptions,
  ): Promise<{ connection: IpcConnection; started: boolean }>;
  stop(): Promise<{ wasRunning: boolean }>;
  stoppedStatus(): DaemonStatus;
}

export function createDaemonControl(environment: PathEnvironment): DaemonControl {
  const stateRoot = resolveStateRoot(environment);
  const secure = { uid: environment.uid, platform: environment.platform };

  const connectExisting = async ({
    signal,
  }: ConnectOptions = {}): Promise<IpcConnection | null> => {
    signal?.throwIfAborted();
    // An unsafe state root is rejected even when connecting to an existing daemon.
    if (!(await requirePrivateDirectoryIfExists(stateRoot, secure))) return null;
    const pointer = await readPointer(stateRoot);
    if (!pointer) return null;
    // Do not trust a socket or key in a directory prepared by someone else.
    if ((await inspectPrivateDirectory(pointer.runtimeDir, secure)) !== 'ok') return null;
    const key = await readIpcKey(pointer.keyPath);
    if (!key) return null;
    try {
      return await connectIpc({
        socketPath: pointer.socketPath,
        key,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      // Merely failing to connect means "not running". Failing to verify the peer is an error.
      if (error instanceof VdeError && error.code === 'E_DAEMON_UNAVAILABLE') return null;
      throw error;
    }
  };

  const spawnDaemon = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [daemonEntryPath()], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: environment.env,
        windowsHide: true,
      });
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (child.connected) child.disconnect();
        child.unref();
        if (error) reject(error);
        else resolve();
      };
      // When aborted, do not wait for startup to finish. The daemon keeps starting and is used by the next connection.
      const onAbort = () =>
        settle(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const logPath = join(stateRoot, 'logs', 'daemon.jsonl');
      const timer = setTimeout(() => {
        settle(
          new VdeError('E_DAEMON_START_FAILED', 'The daemon did not start in time.', {
            log: logPath,
          }),
        );
      }, START_TIMEOUT_MS);
      child.on('message', (message) => {
        const { type, code, message: text, details } = message as Record<string, unknown>;
        if (type === 'ready') {
          settle();
          return;
        }
        settle(
          new VdeError(
            typeof code === 'string' && isErrorCode(code) ? code : 'E_DAEMON_START_FAILED',
            typeof text === 'string' ? text : 'The daemon could not be started.',
            { ...(details as Record<string, unknown>), log: logPath },
          ),
        );
      });
      child.on('error', (error) => {
        settle(
          new VdeError(
            'E_DAEMON_START_FAILED',
            'The daemon could not be started.',
            { log: logPath },
            { cause: error },
          ),
        );
      });
      child.on('exit', (exitCode) => {
        settle(
          new VdeError('E_DAEMON_START_FAILED', 'The daemon exited while starting.', {
            exitCode,
            log: logPath,
          }),
        );
      });
      if (signal?.aborted) onAbort();
    });

  const ensureDetailed = async (
    options: ConnectOptions = {},
  ): Promise<{ connection: IpcConnection; started: boolean }> => {
    const { signal } = options;
    const existing = await connectExisting(options);
    if (existing) return { connection: existing, started: false };

    await ensurePrivateDirectory(stateRoot, secure);
    const ownerId = `start_${randomUUID()}`;
    const deadline = Date.now() + START_TIMEOUT_MS;

    // Acquire the start lock. While it is held elsewhere, check whether the daemon started by the earlier process is reachable.
    for (;;) {
      signal?.throwIfAborted();
      const outcome = await acquireLock(
        stateRoot,
        START_LOCK_NAME,
        { pid: process.pid, ownerId },
        systemProcessProbe,
      );
      if (outcome.acquired) break;
      const connection = await connectExisting(options);
      if (connection) return { connection, started: false };
      if (Date.now() > deadline) {
        throw new VdeError(
          'E_DAEMON_UNAVAILABLE',
          'Waited for the daemon to start, but could not connect.',
          { reason: 'start-lock-timeout' },
        );
      }
      await delay(POLL_INTERVAL_MS, undefined, { signal });
    }

    try {
      // Another process may have finished starting while we waited for the lock.
      const already = await connectExisting(options);
      if (already) return { connection: already, started: false };
      try {
        await spawnDaemon(signal);
      } catch (error) {
        // If another daemon took the lock first, wait for that daemon to become ready.
        if (!(error instanceof VdeError) || error.code !== 'E_DAEMON_LOCKED') throw error;
        const waitUntil = Date.now() + LOCKED_RETRY_MS;
        for (;;) {
          const other = await connectExisting(options);
          if (other) return { connection: other, started: false };
          if (Date.now() > waitUntil) throw error;
          await delay(POLL_INTERVAL_MS, undefined, { signal });
        }
      }
      const connection = await connectExisting(options);
      if (!connection) {
        throw new VdeError(
          'E_DAEMON_START_FAILED',
          'Could not connect to the daemon that was started.',
          {
            log: join(stateRoot, 'logs', 'daemon.jsonl'),
          },
        );
      }
      return { connection, started: true };
    } finally {
      await releaseLock(stateRoot, START_LOCK_NAME, ownerId);
    }
  };

  const ensure = async (options: ConnectOptions = {}): Promise<IpcConnection> =>
    (await ensureDetailed(options)).connection;

  const stop = async (): Promise<{ wasRunning: boolean }> => {
    const connection = await connectExisting();
    if (!connection) return { wasRunning: false };
    const daemonId = connection.daemonId;
    try {
      await connection.request('daemon.stop', {});
    } catch {
      // Stopping may drop the connection before the response arrives.
    } finally {
      connection.close();
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      // Releasing the lock is the last step of stopping. Waiting for it lets a restart follow immediately.
      const lock = await readCurrentLock(stateRoot, DAEMON_LOCK_NAME);
      const held =
        lock !== null && lock !== 'invalid' && lock.ownerId === daemonId && !lock.released;
      if (!held) return { wasRunning: true };
      if (Date.now() > deadline) {
        throw new VdeError('E_DAEMON_UNAVAILABLE', 'The daemon did not stop in time.', {
          daemonId,
        });
      }
      await delay(POLL_INTERVAL_MS);
    }
  };

  const stoppedStatus = (): DaemonStatus => ({
    state: 'stopped',
    daemonId: null,
    pid: null,
    version: null,
    protocolVersion: null,
    startedAt: null,
    stateRoot,
    openDocuments: null,
    catalogVersion: null,
    uiUrl: null,
  });

  return { stateRoot, connectExisting, ensure, ensureDetailed, stop, stoppedStatus };
}
