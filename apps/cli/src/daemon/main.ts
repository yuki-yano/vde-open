import { randomBytes, randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { IPC_PROTOCOL_VERSION, VdeError, type DaemonStatus, type Warning } from '@vde-open/shared';
import { z, ZodError } from 'zod';

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
import { measureHeap } from '../diagnostics/heap.ts';
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

const diagnosticsParamsSchema = z.strictObject({ collectGarbage: z.boolean().default(false) });

export interface DaemonOptions {
  environment: PathEnvironment;
  version: string;
  fs?: StoreFs;
  probe?: ProcessProbe;
  // Port of the management UI. Assigned by the OS if not given.
  managementPort?: number;
  // Port of the listener that serves documents. Assigned by the OS if not given.
  previewPort?: number;
  // Replaces document parsing (used in tests to reproduce slow parsing).
  parse?: ParseService;
}

export interface DaemonHandle {
  readonly daemonId: string;
  readonly stateRoot: string;
  // URL of the management UI. Contains no authentication secret.
  readonly uiUrl: string;
  // Resolves once the daemon has finished stopping.
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

  // Single-writer lock. A lock whose owner is alive is not taken over (spec 6.2).
  const daemonId = `daemon_${randomUUID()}`;
  const acquired = await acquireLock(
    stateRoot,
    DAEMON_LOCK_NAME,
    { pid: process.pid, ownerId: daemonId },
    probe,
  );
  if (!acquired.acquired) {
    throw acquired.reason === 'invalid'
      ? new VdeError('E_DAEMON_LOCKED', 'The daemon lock cannot be read. Check it with doctor.', {
          reason: 'invalid-lock',
        })
      : new VdeError('E_DAEMON_LOCKED', 'Another daemon is using the state.', {
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
  // Aborted once stopping begins.
  const stopRequested = new AbortController();
  // Clean up only what we inspected or created.
  const owned = { runtimeDir: false, key: false, socket: false };
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const shutdown = async () => {
    // Among accepted work, first end the waits that need not finish (such as diagnostics waiting for index sync).
    stopRequested.abort();
    if (lockTimer) clearInterval(lockTimer);
    // Keep holding the lock until accepted work and commits finish.
    // Releasing early would overlap with the next daemon's writes.
    await watcher?.close();
    // Requests waiting for an answer never finish and would block the drain, so end them first (the question state is unchanged).
    feedback?.close();
    await ipc?.drain();
    announceStopping();
    await management?.close();
    await preview?.close();
    await store?.close();
    await parse?.close();
    await search?.close();
    await ipc?.close();
    // When the lock is lost, do not touch runtime files that may belong to a successor daemon.
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
    // After a save failure whose outcome cannot be guaranteed, exit instead of continuing to write (spec 7.2).
    openedStore.onFatal((error) => {
      logger.log('store.fatal', { code: error.code });
      setImmediate(() => void stop('commit-indeterminate'));
    });

    if (!isWindows) await ensurePrivateDirectory(dirname(location.runtimeDir), secure);
    await ensurePrivateDirectory(location.runtimeDir, secure);
    owned.runtimeDir = true;
    // The lock is acquired and the directory is inspected. Any remaining socket belongs to a stopped daemon.
    if (!isWindows) await rm(location.socketPath, { force: true });
    const key = await createIpcKey(location.keyPath);
    owned.key = true;

    parse = options.parse ?? createParseService();
    const parser = parse;
    const events = createEventHub(daemonId, () => openedStore.payload.catalogVersion);
    announceStopping = () => {
      events.publish({ type: 'daemon-stopping' });
    };
    // When a document is closed, revoke its render grants immediately.
    let pruneGrants: () => void = () => undefined;
    const cursors = createCursorCodec(randomBytes(32));
    // The search index lives on a separate thread. It is not persisted and is rebuilt on every start.
    // Document parsing runs in the parse worker (so heavy parsing does not block the search worker).
    search = createSearchService({
      store: openedStore,
      cursors,
      analyze: (format, text) => parser.analyze(format, text),
    });
    const searching = search;
    const emit = (event: DocumentEvent) => {
      // When the open documents, the published revisions, or readability change, sync the index.
      if (
        event.type !== 'focus-requested' &&
        event.type !== 'feedback-changed' &&
        event.type !== 'render-diagnostics'
      ) {
        searching.sync();
      }
      events.publish(event);
      // When the open documents change, also sync the watched directories and the render grants.
      if (event.type === 'catalog-changed') {
        watcher?.sync();
        pruneGrants();
      }
      // When closing a document cancels a question, notify the requests waiting for an answer.
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
    // The development origin is accepted only when running from source. Always disabled in the distributed build.
    const devOrigin = isSourceRun ? (environment.env['VDE_OPEN_DEV_UI_ORIGIN'] ?? null) : null;

    // Documents are served on a port separate from the management UI. Management privileges and origin are not shared (spec 10.1).
    let managementOrigin: string | null = null;
    let previewOrigin = '';
    const render = createRenderService({
      store: openedStore,
      documents,
      sessions,
      parse: parser,
      previewOrigin: () => previewOrigin,
      // When a view tries to load an unregistered file, notify the UI (the path is not included in the notification).
      onMissing: (documentId) => emit({ type: 'render-diagnostics', documentId }),
    });
    pruneGrants = () => render.pruneClosed();
    preview = await startPreviewServer(
      {
        render,
        // Only the management UI may embed the view.
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
    // Start adding the persisted documents to the index.
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
      // Resource counts and usage (used to check performance and resource leaks; PERF-003 to 005). Contains no document contents or secrets.
      'daemon.diagnostics': async (params): Promise<MethodResult> => {
        // Only when requested, collect garbage before measuring the heap (to compare the post-collection heap across iteration intervals).
        // Workers collect and measure on their own threads. The search worker measures after syncing the index to the current documents.
        const { collectGarbage } = diagnosticsParamsSchema.parse(params ?? {});
        const workers = {
          search: (await search?.diagnostics(collectGarbage, stopRequested.signal)) ?? null,
          parse: (await parse?.diagnostics(collectGarbage, stopRequested.signal)) ?? null,
        };
        const heapUsedBytes = measureHeap(collectGarbage);
        const activeResources: Record<string, number> = {};
        for (const kind of process.getActiveResourcesInfo()) {
          activeResources[kind] = (activeResources[kind] ?? 0) + 1;
        }
        const cpu = process.cpuUsage();
        return {
          data: {
            watchers: watching.watcherStats,
            eventSubscribers: events.subscriberCount,
            eventStreams: management?.eventStreams() ?? { streams: 0, maxPending: 0 },
            renderGrants: render.grantCount,
            // Number of retained items. If it keeps growing after iterations, something is not being released.
            retained: {
              documents: documents.retainedCounts(),
              search: search?.retainedCounts() ?? {},
              render: render.retainedCounts(),
              feedback: answering.retainedCounts(),
              sessions: sessions.retainedCounts(),
            },
            workers,
            activeResources,
            rssBytes: process.memoryUsage().rss,
            heapUsedBytes,
            cpuMicros: cpu.user + cpu.system,
          },
        };
      },
      'daemon.stop': (): MethodResult => {
        // Stop after returning the response.
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
      // Create a one-time URL for opening the browser. The URL contains a secret, so it is not logged.
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
        if (stopping) throw new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.');
        const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
        if (!handler) throw new VdeError('E_UNKNOWN_METHOD', 'Unknown method.', { method });
        try {
          return await handler(params);
        } catch (error) {
          if (error instanceof ZodError) {
            throw new VdeError('E_INVALID_ARGUMENT', 'Invalid arguments.', {
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

    // If the lock is lost, stop writing and exit.
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
