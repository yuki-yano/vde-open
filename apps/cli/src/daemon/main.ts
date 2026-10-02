import { randomBytes, randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { IPC_PROTOCOL_VERSION, VdeError, type DaemonStatus, type Warning } from '@vde-open/shared';
import { ZodError } from 'zod';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import {
  resolveRuntimeLocation,
  resolveStateRoot,
  type PathEnvironment,
} from '../persistence/paths.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { startIpcServer, type IpcServer } from '../server/ipc-server.ts';
import {
  acquireLock,
  holdsLock,
  releaseLock,
  systemProcessProbe,
  type ProcessProbe,
} from './lock.ts';
import { createFileLogger, type Logger } from './logger.ts';
import { createIpcKey, DAEMON_LOCK_NAME, removePointer, writePointer } from './runtime-files.ts';
import { ensurePrivateDirectory } from './secure-dir.ts';

const LOCK_CHECK_INTERVAL_MS = 2000;

export interface DaemonOptions {
  environment: PathEnvironment;
  version: string;
  fs?: StoreFs;
  probe?: ProcessProbe;
}

export interface DaemonHandle {
  readonly daemonId: string;
  readonly stateRoot: string;
  // daemonが停止し終えたら解決する。
  readonly stopped: Promise<void>;
  stop(reason: string): Promise<void>;
}

interface MethodResult {
  data: unknown;
  catalogVersion?: number;
  warnings?: Warning[];
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { environment, version } = options;
  const probe = options.probe ?? systemProcessProbe;
  const secure = { uid: environment.uid, platform: environment.platform };
  const isWindows = environment.platform === 'win32';

  const stateRoot = resolveStateRoot(environment);
  await ensurePrivateDirectory(stateRoot, secure);

  // 単一writerのlock。所有者が生きているlockは引き継がない（仕様6.2）。
  const daemonId = `daemon_${randomUUID()}`;
  const acquired = await acquireLock(
    stateRoot,
    DAEMON_LOCK_NAME,
    { pid: process.pid, ownerId: daemonId },
    probe,
  );
  if (!acquired.acquired) {
    throw acquired.reason === 'invalid'
      ? new VdeError('E_DAEMON_LOCKED', 'daemonのlockを読めません。doctorで確認してください。', {
          reason: 'invalid-lock',
        })
      : new VdeError('E_DAEMON_LOCKED', '別のdaemonがstateを使用中です。', {
          reason: 'owner-alive',
          pid: acquired.holder?.pid ?? null,
        });
  }

  const logger: Logger = createFileLogger(stateRoot);
  const location = resolveRuntimeLocation(stateRoot, environment);
  let store: StateStore | null = null;
  let ipc: IpcServer | null = null;
  let lockTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  // 自分が検査・作成したものだけを後始末する。
  const owned = { runtimeDir: false, key: false, socket: false };
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const shutdown = async () => {
    if (lockTimer) clearInterval(lockTimer);
    // 受付済みの処理とcommitが終わるまで、lockを持ち続ける。
    // 途中で解放すると、次のdaemonの書込みと重なる。
    await ipc?.drain();
    await store?.close();
    await ipc?.close();
    // lockを失っているときは、後継のdaemonのものかもしれないruntime fileに触れない。
    if (await holdsLock(stateRoot, DAEMON_LOCK_NAME, daemonId)) {
      if (owned.socket && !isWindows) await rm(location.socketPath, { force: true });
      if (owned.key) await rm(location.keyPath, { force: true });
      if (owned.runtimeDir) await rmdir(location.runtimeDir).catch(() => undefined);
      await removePointer(stateRoot, daemonId);
      await releaseLock(stateRoot, DAEMON_LOCK_NAME, daemonId);
    }
  };

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      logger.log('daemon.stopping', { reason });
      await shutdown();
      await logger.flush();
      resolveStopped();
    })();
    return stopping;
  };

  try {
    store = await StateStore.open({ root: stateRoot, fs: options.fs ?? nodeStoreFs });
    const openedStore = store;
    // 結果を保証できない保存失敗の後は、書込みを続けずに終了する（仕様7.2）。
    openedStore.onFatal((error) => {
      logger.log('store.fatal', { code: error.code });
      setImmediate(() => void stop('commit-indeterminate'));
    });

    if (!isWindows) await ensurePrivateDirectory(dirname(location.runtimeDir), secure);
    await ensurePrivateDirectory(location.runtimeDir, secure);
    owned.runtimeDir = true;
    // lockを取得済みで、directoryも検査済み。残っているsocketは停止済みdaemonのもの。
    if (!isWindows) await rm(location.socketPath, { force: true });
    const key = await createIpcKey(location.keyPath);
    owned.key = true;

    const documents = new DocumentService(openedStore, createCursorCodec(randomBytes(32)));
    const startedAt = new Date().toISOString();

    const methods: Record<string, (params: unknown) => Promise<MethodResult> | MethodResult> = {
      'daemon.status': (): MethodResult => {
        const status: DaemonStatus = {
          state: 'running',
          daemonId,
          pid: process.pid,
          version,
          protocolVersion: IPC_PROTOCOL_VERSION,
          startedAt,
          stateRoot,
          openDocuments: openedStore.payload.openOrder.length,
          catalogVersion: openedStore.payload.catalogVersion,
        };
        return { data: status, catalogVersion: openedStore.payload.catalogVersion };
      },
      'daemon.stop': (): MethodResult => {
        // 応答を返してから停止する。
        setImmediate(() => void stop('requested'));
        return { data: { stopping: true } };
      },
      'documents.open': (params) => documents.open(params),
      'documents.list': (params) => documents.list(params),
      'documents.read': (params) => documents.read(params),
      'documents.close': (params) => documents.close(params),
    };

    ipc = await startIpcServer({
      socketPath: location.socketPath,
      key,
      daemonId,
      onEvent: (event, fields) => logger.log(event, fields),
      handle: async (method, params) => {
        if (stopping) throw new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。');
        const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
        if (!handler) throw new VdeError('E_UNKNOWN_METHOD', '未知のmethodです。', { method });
        try {
          return await handler(params);
        } catch (error) {
          if (error instanceof ZodError) {
            throw new VdeError('E_INVALID_ARGUMENT', '引数が正しくありません。', {
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            });
          }
          throw error;
        }
      },
    });
    owned.socket = true;

    await writePointer(stateRoot, {
      daemonId,
      pid: process.pid,
      protocolVersion: IPC_PROTOCOL_VERSION,
      version,
      startedAt,
      ...location,
    });

    // lockを失ったら、書込みを止めて終了する。
    const checkLock = async () => {
      if (!(await holdsLock(stateRoot, DAEMON_LOCK_NAME, daemonId))) await stop('lock-lost');
    };
    lockTimer = setInterval(() => void checkLock(), LOCK_CHECK_INTERVAL_MS);
    lockTimer.unref();

    logger.log('daemon.started', { openDocuments: openedStore.payload.openOrder.length });
  } catch (error) {
    logger.log('daemon.start-failed', {
      code: error instanceof VdeError ? error.code : 'E_INTERNAL',
    });
    await shutdown();
    await logger.flush();
    throw error;
  }

  return { daemonId, stateRoot, stopped, stop };
}
