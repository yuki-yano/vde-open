import { randomBytes, randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { IPC_PROTOCOL_VERSION, VdeError, type DaemonStatus, type Warning } from '@vde-open/shared';
import { ZodError } from 'zod';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService, type DocumentEvent } from '../documents/service.ts';
import { FeedbackService } from '../feedback/service.ts';
import { isSourceRun, webRootPath } from '../entry-paths.ts';
import {
  resolveRuntimeLocation,
  resolveStateRoot,
  type PathEnvironment,
} from '../persistence/paths.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { createRenderService } from '../render/render-service.ts';
import { createSearchService, type SearchService } from '../search/search-service.ts';
import { createEventHub } from '../server/event-hub.ts';
import { startManagementServer, type ManagementServer } from '../server/http/management.ts';
import { startPreviewServer, type PreviewServer } from '../server/http/preview.ts';
import { startIpcServer, type IpcServer } from '../server/ipc-server.ts';
import { createSessionService } from '../server/session-service.ts';
import { createWatchService, type WatchService } from '../watch/watch-service.ts';
import { createParseService, type ParseService } from '../workers/parse-service.ts';
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
  // 管理UIのport。指定がなければOSに割り当ててもらう。
  managementPort?: number;
  // 文書を表示するlistenerのport。指定がなければOSに割り当ててもらう。
  previewPort?: number;
  // 文書の解析を差し替える（testで、遅い解析を再現するために使う）。
  parse?: ParseService;
}

export interface DaemonHandle {
  readonly daemonId: string;
  readonly stateRoot: string;
  // 管理UIのURL。認証の秘密は含まない。
  readonly uiUrl: string;
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
  let management: ManagementServer | null = null;
  let preview: PreviewServer | null = null;
  let watcher: WatchService | null = null;
  let parse: ParseService | null = null;
  let search: SearchService | null = null;
  let feedback: FeedbackService | null = null;
  let announceStopping: () => void = () => undefined;
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
    await watcher?.close();
    // 回答を待っている要求は、終わらずにdrainを止めるので、先に終わらせる（質問の状態は変えない）。
    feedback?.close();
    await ipc?.drain();
    announceStopping();
    await management?.close();
    await preview?.close();
    await store?.close();
    await parse?.close();
    await search?.close();
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

    parse = options.parse ?? createParseService();
    const parser = parse;
    const events = createEventHub(daemonId, () => openedStore.payload.catalogVersion);
    announceStopping = () => {
      events.publish({ type: 'daemon-stopping' });
    };
    // 文書を閉じたら、その文書の表示の権限をすぐに失効させる。
    let pruneGrants: () => void = () => undefined;
    const cursors = createCursorCodec(randomBytes(32));
    // 検索のindexは、別のthreadに置く。保存はせず、起動のたびに作り直す。
    // 文書の解析は、解析用のworkerで行う（検索のworkerを、重い解析で塞がない）。
    search = createSearchService({
      store: openedStore,
      cursors,
      analyze: (format, text) => parser.analyze(format, text),
    });
    const searching = search;
    const emit = (event: DocumentEvent) => {
      // 開いている文書、公開している版、読めるかどうかが変わったら、indexを合わせる。
      if (event.type !== 'focus-requested' && event.type !== 'feedback-changed') searching.sync();
      events.publish(event);
      // 開いている文書が変わったら、監視するdirectoryと、表示の権限も合わせる。
      if (event.type === 'catalog-changed') {
        watcher?.sync();
        pruneGrants();
      }
      // 文書を閉じて質問が中止になったら、回答を待っている要求へ伝える。
      if (event.type === 'feedback-changed' && event.requestId !== undefined) {
        feedback?.wake(event.requestId);
      }
    };
    const documents = new DocumentService({
      store: openedStore,
      cursors,
      searchStateOf: (documentId) => searching.stateOf(documentId),
      analyze: (format, text) => parser.analyze(format, text),
      scan: (kind, text) => parser.scan(kind, text),
      emit,
    });
    feedback = new FeedbackService({ store: openedStore, documents, emit });
    const answering = feedback;
    const sessions = createSessionService();
    const startedAt = new Date().toISOString();
    // 開発用のoriginは、sourceから実行しているときだけ受け付ける。配布物では常に無効。
    const devOrigin = isSourceRun ? (environment.env['VDE_OPEN_DEV_UI_ORIGIN'] ?? null) : null;

    // 文書の表示は、管理UIとは別のportで行う。管理の権限とoriginを共有しない（仕様10.1）。
    let managementOrigin: string | null = null;
    let previewOrigin = '';
    const render = createRenderService({
      store: openedStore,
      documents,
      sessions,
      parse: parser,
      previewOrigin: () => previewOrigin,
    });
    pruneGrants = () => render.pruneClosed();
    preview = await startPreviewServer(
      {
        render,
        // 表示を埋め込めるのは管理UIだけ。
        frameAncestors: () =>
          [managementOrigin, devOrigin].filter((origin): origin is string => origin !== null),
        onEvent: (event, fields) => logger.log(event, fields),
      },
      options.previewPort === undefined ? {} : { port: options.previewPort },
    );
    previewOrigin = preview.origin;

    management = await startManagementServer(
      {
        daemonId,
        version,
        documents,
        sessions,
        events,
        render,
        search: searching,
        feedback: answering,
        previewOrigin,
        webRoot: webRootPath(),
        devOrigin,
        isStopping: () => stopping !== null,
        onEvent: (event, fields) => logger.log(event, fields),
      },
      options.managementPort === undefined ? {} : { port: options.managementPort },
    );
    managementOrigin = management.origin;
    const uiUrl = `${management.origin}/`;
    watcher = createWatchService({
      documents,
      onEvent: (event, fields) => logger.log(event, fields),
    });
    const watching = watcher;
    watching.sync();
    // 保存済みの文書を、indexへ入れ始める。
    searching.sync();

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
          uiUrl,
        };
        return { data: status, catalogVersion: openedStore.payload.catalogVersion };
      },
      'daemon.stop': (): MethodResult => {
        // 応答を返してから停止する。
        setImmediate(() => void stop('requested'));
        return { data: { stopping: true } };
      },
      'documents.open': async (params) => {
        const result = await documents.open(params);
        watching.sync();
        return result;
      },
      'documents.list': (params) => documents.list(params),
      'documents.read': (params) => documents.read(params),
      'documents.search': (params) => searching.search(params),
      'documents.close': async (params) => {
        const result = await documents.close(params);
        watching.sync();
        return result;
      },
      'documents.focus': (params) => documents.focus(params),
      'documents.refresh': (params) => documents.refresh(params),
      'feedback.create': async (params) => {
        const result = await answering.create(params);
        watching.sync();
        return result;
      },
      'feedback.list': (params) => answering.list(params),
      'feedback.get': (params) => answering.get(params),
      'feedback.wait': (params) => answering.wait(params),
      'feedback.ack': (params) => answering.ack(params),
      'feedback.cancel': (params) => answering.cancel(params, 'agent'),
      'feedback.forget': (params) => answering.forget(params),
      'watch.list': () => documents.listWatchRules(),
      'watch.remove': async (params) => {
        const result = await documents.removeWatchRule(params);
        watching.sync();
        return result;
      },
      // browserを開くための一回限りのURLを作る。URLは秘密を含むので、logには残さない。
      'ui.bootstrap': (): MethodResult => ({
        data: { bootstrapUrl: `${uiUrl}#bootstrap=${sessions.createBootstrapTicket()}`, uiUrl },
      }),
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

  return { daemonId, stateRoot, uiUrl: management ? `${management.origin}/` : '', stopped, stop };
}
