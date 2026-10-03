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

// 仕様6.2: 起動待ちの上限。
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const LOCKED_RETRY_MS = 3000;

// 接続の処理を途中でやめるための合図。中断されたら、起動の待ちと接続の確認をやめ、timerも片付ける
// （起動を始めたdaemonは、そのまま起動を続ける）。
export interface ConnectOptions {
  signal?: AbortSignal;
}

export interface DaemonControl {
  readonly stateRoot: string;
  // 起動中のdaemonへ接続する。起動していなければnull。新しくは起動しない。
  connectExisting(options?: ConnectOptions): Promise<IpcConnection | null>;
  // 接続し、なければ起動してから接続する。
  ensure(options?: ConnectOptions): Promise<IpcConnection>;
  // ensureと同じ。この呼び出しでdaemonを新しく起動したかも返す。
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
    // 安全でないstate rootは、既存のdaemonへ接続するときも拒否する。
    if (!(await requirePrivateDirectoryIfExists(stateRoot, secure))) return null;
    const pointer = await readPointer(stateRoot);
    if (!pointer) return null;
    // 他人が用意したdirectoryのsocketやkeyを信用しない。
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
      // 接続できないだけなら「起動していない」。相手を確認できない場合はerrorにする。
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
      // 中断されたら、起動の完了を待たない。daemonは起動を続け、次の接続で使われる。
      const onAbort = () =>
        settle(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const logPath = join(stateRoot, 'logs', 'daemon.jsonl');
      const timer = setTimeout(() => {
        settle(
          new VdeError('E_DAEMON_START_FAILED', 'daemonが時間内に起動しませんでした。', {
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
            typeof text === 'string' ? text : 'daemonを起動できませんでした。',
            { ...(details as Record<string, unknown>), log: logPath },
          ),
        );
      });
      child.on('error', (error) => {
        settle(
          new VdeError(
            'E_DAEMON_START_FAILED',
            'daemonを起動できませんでした。',
            { log: logPath },
            { cause: error },
          ),
        );
      });
      child.on('exit', (exitCode) => {
        settle(
          new VdeError('E_DAEMON_START_FAILED', 'daemonが起動中に終了しました。', {
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

    // 起動lockを取る。取れない間は、先に起動したprocessのdaemonへ接続できるか確かめる。
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
          'daemonの起動を待ちましたが、接続できませんでした。',
          { reason: 'start-lock-timeout' },
        );
      }
      await delay(POLL_INTERVAL_MS, undefined, { signal });
    }

    try {
      // lockを取るまでの間に、別のprocessが起動を終えているかもしれない。
      const already = await connectExisting(options);
      if (already) return { connection: already, started: false };
      try {
        await spawnDaemon(signal);
      } catch (error) {
        // 別のdaemonが先にlockを取っていた場合は、そのdaemonの準備が終わるのを待つ。
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
        throw new VdeError('E_DAEMON_START_FAILED', '起動したdaemonへ接続できませんでした。', {
          log: join(stateRoot, 'logs', 'daemon.jsonl'),
        });
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
      // 停止によって応答前に接続が切れることがある。
    } finally {
      connection.close();
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      // lockの解放が停止処理の最後。そこまで待てば、直後に起動し直せる。
      const lock = await readCurrentLock(stateRoot, DAEMON_LOCK_NAME);
      const held =
        lock !== null && lock !== 'invalid' && lock.ownerId === daemonId && !lock.released;
      if (!held) return { wasRunning: true };
      if (Date.now() > deadline) {
        throw new VdeError('E_DAEMON_UNAVAILABLE', 'daemonが時間内に停止しませんでした。', {
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
