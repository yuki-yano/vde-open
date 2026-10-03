import { stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';

import { LIMITS } from '@vde-open/shared';
import { watch, type FSWatcher } from 'chokidar';

import { isExcludedDirectoryName, watchBaseOf } from '../documents/enumerate.ts';
import type { DocumentService } from '../documents/service.ts';
import { statSignature } from '../documents/source-reader.ts';

// The interval for periodically checking file state, in case a notification is missed.
const FILE_CHECK_INTERVAL_MS = 5000;
const RULE_SCAN_INTERVAL_MS = 30_000;
// The number of documents to resync at once. Right after startup, every open document is checked.
const REFRESH_CONCURRENCY = 4;

export interface WatchService {
  // Adds and removes watched directories to match the current state.
  sync(): void;
  close(): Promise<void>;
  // The number of watched directories, and of watchers created and fully closed (used for resource leak checks).
  // The difference between created and closed is the number of watchers not yet closed.
  readonly watcherStats: { directories: number; created: number; closed: number };
}

export interface WatchServiceOptions {
  documents: DocumentService;
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
  debounceMs?: number;
  fileCheckIntervalMs?: number;
}

interface DirectoryWatcher {
  watcher: FSWatcher;
  recursive: boolean;
}

function isUnder(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return fromDirectory !== '' && !fromDirectory.startsWith('..') && !fromDirectory.startsWith(sep);
}

// Follows file updates and registers new documents through watch rules (spec 8.5).
// Only the parent directories of open documents and the roots of rules are watched.
export function createWatchService(options: WatchServiceOptions): WatchService {
  const { documents } = options;
  const debounceMs = options.debounceMs ?? LIMITS.watchDebounceMs;
  const watchers = new Map<string, DirectoryWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  // For documents that could not be read, the file state at the time of the attempt. Resync when it changes.
  // The state of readable documents is kept by DocumentService, paired with the published content.
  const unreadable = new Map<string, string>();
  let closed = false;
  const stats = { created: 0, closed: 0 };
  let activeRefreshes = 0;
  const waitingRefreshes: Array<() => void> = [];

  const report = (error: unknown) => {
    options.onEvent?.('watch.error', {
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  };

  // Coalesces notifications for the same target and handles them once, shortly after the last one.
  const schedule = (key: string, work: () => Promise<unknown>) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (!closed) void work().catch(report);
      }, debounceMs),
    );
  };

  const statOf = async (path: string): Promise<string> => {
    try {
      return statSignature(await stat(path));
    } catch {
      return 'missing';
    }
  };

  // The current state of the document and the files it references, in the same order DocumentService remembers.
  const signatureOf = async (documentId: string, path: string): Promise<string> =>
    (await Promise.all([path, ...documents.trackedFiles(documentId)].map(statOf))).join('|');

  // Limits concurrent resyncs. Waits for a free slot when there is none.
  const acquireRefresh = (): Promise<void> => {
    if (activeRefreshes < REFRESH_CONCURRENCY) {
      activeRefreshes += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waitingRefreshes.push(resolve);
    });
  };
  const releaseRefresh = () => {
    // If a resync is waiting, hand the slot straight to it.
    const next = waitingRefreshes.shift();
    if (next) next();
    else activeRefreshes -= 1;
  };

  const refreshDocument = async (documentId: string, path: string) => {
    await acquireRefresh();
    try {
      if (closed) return;
      const observed = await signatureOf(documentId, path);
      const outcome = await documents.refreshFromDisk(documentId);
      // The comparison uses the state matching the content actually read, not a stat taken after the resync.
      // If the file changed after the read, the next check will disagree and resync again.
      if (outcome.signature === null) unreadable.set(documentId, observed);
      else unreadable.delete(documentId);
      // When referenced files are added or removed, adjust the watched directories too.
      sync();
    } finally {
      releaseRefresh();
    }
  };

  const openFileDocuments = () =>
    Object.values(documents.state.documents).filter(
      (record) => record.isOpen && record.sourceKind === 'file' && record.canonicalPath !== null,
    );

  const scheduleRefresh = (documentId: string, path: string) => {
    schedule(`doc:${documentId}`, () => refreshDocument(documentId, path));
  };

  const handlePath = (path: string) => {
    for (const record of openFileDocuments()) {
      // The document itself, or a file it references, changed.
      if (
        record.canonicalPath === path ||
        documents.trackedFiles(record.documentId).includes(path)
      ) {
        scheduleRefresh(record.documentId, record.canonicalPath as string);
      }
    }
    for (const rule of documents.state.watchRules) {
      const base = watchBaseOf(rule);
      const covered = base.recursive
        ? isUnder(base.directory, path)
        : dirname(path) === base.directory;
      if (covered) {
        schedule(`rule:${rule.watchId}`, async () => {
          await documents.reconcileWatchRule(rule.watchId);
          sync();
        });
      }
    }
  };

  // Checks the current state of open documents without relying on notifications. Useful right after watching starts, or when a notification is missed.
  const checkDocuments = () => {
    for (const record of openFileDocuments()) {
      const path = record.canonicalPath as string;
      void signatureOf(record.documentId, path).then((signature) => {
        // A document not yet read since the daemon started may not match the saved content.
        // Resync to confirm, so changes made while stopped are not missed.
        const known =
          documents.readSignature(record.documentId) ?? unreadable.get(record.documentId);
        if (known !== signature) scheduleRefresh(record.documentId, path);
      });
    }
  };

  const closeWatcher = async (entry: DirectoryWatcher) => {
    await entry.watcher.close();
    stats.closed += 1;
  };

  const startWatcher = (directory: string, recursive: boolean) => {
    const watcher = watch(directory, {
      ignoreInitial: true,
      followSymlinks: false,
      // When watching only the top level, do not read lower levels.
      ...(recursive ? {} : { depth: 0 }),
      ignored: (path) => {
        if (path === directory) return false;
        // Like enumeration, do not watch under hidden and excluded directories.
        const segments = relative(directory, path).split(sep);
        return segments.slice(0, -1).some((segment) => isExcludedDirectoryName(segment));
      },
    });
    watcher.on('all', (_event, path) => {
      if (basename(path).startsWith('.')) return;
      handlePath(path);
    });
    // With many watched directories, this fires many times almost at once. Coalesce into a single check.
    watcher.on('ready', () => {
      schedule('check', () => {
        checkDocuments();
        return Promise.resolve();
      });
    });
    watcher.on('error', report);
    stats.created += 1;
    watchers.set(directory, { watcher, recursive });
  };

  function sync(): void {
    if (closed) return;
    const desired = new Map<string, boolean>();
    for (const record of openFileDocuments()) {
      // The document's parent directory, and the parent directories of the files it references.
      for (const path of [
        record.canonicalPath as string,
        ...documents.trackedFiles(record.documentId),
      ]) {
        const directory = dirname(path);
        desired.set(directory, desired.get(directory) ?? false);
      }
    }
    for (const rule of documents.state.watchRules) {
      const base = watchBaseOf(rule);
      desired.set(base.directory, (desired.get(base.directory) ?? false) || base.recursive);
    }
    for (const [directory, entry] of watchers) {
      if (desired.get(directory) === entry.recursive) continue;
      watchers.delete(directory);
      void closeWatcher(entry).catch(report);
    }
    for (const [directory, recursive] of desired) {
      if (!watchers.has(directory)) startWatcher(directory, recursive);
    }
    const open = new Set(openFileDocuments().map((record) => record.documentId));
    for (const documentId of unreadable.keys()) {
      if (!open.has(documentId)) unreadable.delete(documentId);
    }
  }

  const fileCheck = setInterval(
    checkDocuments,
    options.fileCheckIntervalMs ?? FILE_CHECK_INTERVAL_MS,
  );
  fileCheck.unref();

  const ruleScan = setInterval(() => {
    for (const rule of documents.state.watchRules) {
      schedule(`rule:${rule.watchId}`, async () => {
        await documents.reconcileWatchRule(rule.watchId);
        sync();
      });
    }
  }, RULE_SCAN_INTERVAL_MS);
  ruleScan.unref();

  return {
    sync,
    get watcherStats() {
      return { directories: watchers.size, ...stats };
    },
    async close() {
      closed = true;
      clearInterval(fileCheck);
      clearInterval(ruleScan);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const wake of waitingRefreshes.splice(0)) wake();
      const closing = [...watchers.values()].map(closeWatcher);
      watchers.clear();
      await Promise.allSettled(closing);
    },
  };
}
