import { stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';

import { LIMITS } from '@vde-open/shared';
import { watch, type FSWatcher } from 'chokidar';

import { isExcludedDirectoryName, watchBaseOf } from '../documents/enumerate.ts';
import type { DocumentService } from '../documents/service.ts';
import { statSignature } from '../documents/source-reader.ts';

// 通知が欠けた場合に備えて、fileの状態を定期的に確かめる間隔。
const FILE_CHECK_INTERVAL_MS = 5000;
const RULE_SCAN_INTERVAL_MS = 30_000;
// 同時に読み直す文書の数。起動直後は、開いている全文書を確かめる。
const REFRESH_CONCURRENCY = 4;

export interface WatchService {
  // 現在のstateに合わせて、監視するdirectoryを増減する。
  sync(): void;
  close(): Promise<void>;
  // 監視しているdirectoryの数と、作ったwatcher・閉じ終えたwatcherの数（資源の漏れの確認に使う）。
  // 作った数と閉じ終えた数の差が、まだ閉じていないwatcherの数になる。
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

// fileの更新追従と、監視ruleによる新しい文書の登録（仕様8.5）。
// 監視するのは、開いている文書の親directoryと、ruleの起点だけ。
export function createWatchService(options: WatchServiceOptions): WatchService {
  const { documents } = options;
  const debounceMs = options.debounceMs ?? LIMITS.watchDebounceMs;
  const watchers = new Map<string, DirectoryWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  // 読めなかった文書の、読もうとした時点のfileの状態。状態が変わったら読み直す。
  // 読めた文書の状態は、DocumentServiceが公開済みの内容と対にして持っている。
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

  // 同じ対象への通知をまとめ、最後の通知から少し待って1回だけ処理する。
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

  // 文書と、文書が参照しているfileの、現在の状態。DocumentServiceが覚えている形と同じ並び。
  const signatureOf = async (documentId: string, path: string): Promise<string> =>
    (await Promise.all([path, ...documents.trackedFiles(documentId)].map(statOf))).join('|');

  // 同時に読み直す数を抑える。空きがなければ、空くまで待つ。
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
    // 待っている読み直しがあれば、枠をそのまま渡す。
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
      // 照合に使うのは、実際に読み取った内容に対応する状態。読み直した後のstatは使わない。
      // 読んだ後に変わっていれば、次の照合で食い違い、もう一度読み直す。
      if (outcome.signature === null) unreadable.set(documentId, observed);
      else unreadable.delete(documentId);
      // 参照しているfileが増減したら、監視するdirectoryも合わせる。
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
      // 文書そのものか、文書が参照しているfileが変わった。
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

  // 通知に頼らず、開いている文書の現状を確かめる。監視開始の直後や、通知が欠けた場合に効く。
  const checkDocuments = () => {
    for (const record of openFileDocuments()) {
      const path = record.canonicalPath as string;
      void signatureOf(record.documentId, path).then((signature) => {
        // daemonの起動後にまだ読んでいない文書は、保存済みの内容と合っているか分からない。
        // 停止中の変更を取りこぼさないよう、読み直して確かめる。
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
      // 直下だけの監視では、下の階層を読まない。
      ...(recursive ? {} : { depth: 0 }),
      ignored: (path) => {
        if (path === directory) return false;
        // 走査と同じ規則で、隠しdirectoryと除外directoryの下を監視しない。
        const segments = relative(directory, path).split(sep);
        return segments.slice(0, -1).some((segment) => isExcludedDirectoryName(segment));
      },
    });
    watcher.on('all', (_event, path) => {
      if (basename(path).startsWith('.')) return;
      handlePath(path);
    });
    // 監視するdirectoryが多いと、ほぼ同時に何度も呼ばれる。まとめて1回だけ確かめる。
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
      // 文書の親directoryと、文書が参照しているfileの親directory。
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
