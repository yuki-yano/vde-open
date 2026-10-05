import { canonicalJson, type DocumentRepository, type RepositoryCheckout } from '@vde-open/shared';

import {
  createLimiter,
  createRepositoryDetector,
  limitRepositoryFs,
  nodeRepositoryFs,
  type Detection,
  type Limiter,
  type RepositoryDetector,
  type RepositoryFs,
} from './repository.ts';

// Keeps which repository each open file document belongs to, in daemon memory only.
// The values are derived from paths and can go stale (a branch switch), so they are never stored in the state file.
//
// Documents in the same checkout share one checkout entry, so they always show the same branch.
// Every detection batch gets an increasing number. A result is applied only if no result from a later batch
// was applied to that document (or that checkout) already, so late results never roll a value back.

// How long an operation waits for detection before it finishes with the earlier value or `pending`.
export const REPOSITORY_WAIT_MS = 2000;
// Results that finish after the wait are applied as they arrive, gathered into one transaction (a state write,
// a catalog version, a notification). The first gathering waits this long; while results keep arriving it doubles
// up to the maximum, so a slow filesystem does not rewrite the state and invalidate list cursors many times a second.
export const REPOSITORY_LATE_APPLY_MS = 250;
export const REPOSITORY_LATE_APPLY_MAX_MS = 1000;
// Filesystem operations of detection running at once, across the daemon. Kept below the libuv pool size (4).
export const REPOSITORY_FS_CONCURRENCY = 2;

// A result from batch `sequence` replaces the current one unless a later batch already set it.
// A `pending` placeholder is replaced by the result of the batch that set it.
function supersedes(
  current: { sequence: number; value?: { state: string } } | undefined,
  sequence: number,
): boolean {
  return (
    current === undefined ||
    current.sequence < sequence ||
    (current.sequence === sequence && current.value?.state === 'pending')
  );
}

// What a document refers to. A document in a checkout takes the repository and the worktree from the checkout entry,
// so every document of one checkout shows the same repository, name, and branch.
type Stored =
  | { state: 'outside' }
  | { state: 'pending' }
  | { state: 'resolved'; checkoutId: string; pathInCheckout: string[] }
  // A document inside the .git directory has no checkout and keeps its repository itself.
  | {
      state: 'resolved';
      checkoutId: null;
      id: string;
      nameSegments: string[];
      pathInCheckout: string[];
    }
  | Extract<DocumentRepository, { state: 'unresolved' }>;

interface CheckoutEntry {
  sequence: number;
  info: RepositoryCheckout;
  repositoryId: string;
  nameSegments: string[];
}

export interface DetectionBatch {
  readonly sequence: number;
  readonly startedAt: number;
  // Results by canonical path, filled in as they finish.
  readonly results: ReadonlyMap<string, Detection>;
  readonly done: Promise<void>;
  // Settles when the detection of that path finishes.
  settled(path: string): Promise<void>;
}

// A document to update, with its close count when the batch result is applied.
export interface TrackedDocument {
  documentId: string;
  path: string;
  epoch: number;
}

export interface StagedRepositories {
  readonly changed: boolean;
  // Documents whose detection has not finished yet.
  readonly unfinished: TrackedDocument[];
  readonly documents: Map<string, { sequence: number; value: Stored }>;
  readonly checkouts: Map<string, CheckoutEntry>;
}

export interface RepositoryTrackerOptions {
  fs?: RepositoryFs;
  platform?: 'posix' | 'win32';
  waitMs?: number;
  lateApplyMs?: number;
  lateApplyMaxMs?: number;
  stopAt?: string;
  // Replaces detection itself (tests control results and the order they finish in).
  createDetector?: () => RepositoryDetector;
}

export class RepositoryTracker {
  readonly #fs: RepositoryFs;
  readonly #platform: 'posix' | 'win32';
  readonly #limiter: Limiter = createLimiter(REPOSITORY_FS_CONCURRENCY);
  readonly #stopAt: string | undefined;
  readonly #createDetector: (() => RepositoryDetector) | undefined;
  readonly waitMs: number;
  readonly lateApplyMs: number;
  readonly lateApplyMaxMs: number;
  #sequence = 0;
  readonly #documents = new Map<string, { sequence: number; value: Stored }>();
  readonly #checkouts = new Map<string, CheckoutEntry>();
  // Documents referring to each checkout. A checkout entry is dropped when nothing refers to it.
  readonly #members = new Map<string, Set<string>>();

  constructor(options: RepositoryTrackerOptions = {}) {
    this.#fs = limitRepositoryFs(options.fs ?? nodeRepositoryFs, this.#limiter);
    this.#platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.waitMs = options.waitMs ?? REPOSITORY_WAIT_MS;
    this.lateApplyMs = options.lateApplyMs ?? REPOSITORY_LATE_APPLY_MS;
    this.lateApplyMaxMs = options.lateApplyMaxMs ?? REPOSITORY_LATE_APPLY_MAX_MS;
    this.#stopAt = options.stopAt;
    this.#createDetector = options.createDetector;
  }

  // Starts detecting the given canonical paths. Directories are looked at once per batch.
  begin(paths: Iterable<string>): DetectionBatch {
    this.#sequence += 1;
    const detector =
      this.#createDetector?.() ??
      createRepositoryDetector({
        fs: this.#fs,
        platform: this.#platform,
        ...(this.#stopAt === undefined ? {} : { stopAt: this.#stopAt }),
      });
    const results = new Map<string, Detection>();
    const settled = new Map<string, Promise<void>>();
    const work = [...new Set(paths)].map((path) => {
      const finished = detector.detect(path).then(
        (detection) => {
          results.set(path, detection);
        },
        () => {
          // Detection turns every filesystem failure into a result. Anything else is treated as unreadable.
          results.set(path, {
            state: 'unresolved',
            id: path,
            nameSegments: [],
            pathInCheckout: [],
            reason: 'unreadable',
          });
        },
      );
      settled.set(path, finished);
      return finished;
    });
    return {
      sequence: this.#sequence,
      startedAt: Date.now(),
      results,
      done: Promise.all(work).then(() => undefined),
      settled: (path) => settled.get(path) ?? Promise.resolve(),
    };
  }

  // Waits for the batch until the wait limit counted from its start. Unfinished detections keep running.
  async wait(batch: DetectionBatch): Promise<void> {
    const remaining = batch.startedAt + this.waitMs - Date.now();
    if (remaining <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      batch.done,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, remaining);
      }),
    ]);
    clearTimeout(timer);
  }

  #compose(stored: Stored | undefined, checkouts = this.#checkouts): DocumentRepository {
    if (stored === undefined) return { state: 'pending' };
    if (stored.state === 'outside') return null;
    if (stored.state !== 'resolved') return stored;
    if (stored.checkoutId === null) {
      const { checkoutId: _none, ...rest } = stored;
      return { ...rest, checkout: null };
    }
    const entry = checkouts.get(stored.checkoutId);
    if (entry === undefined) return { state: 'pending' };
    return {
      state: 'resolved',
      id: entry.repositoryId,
      nameSegments: entry.nameSegments,
      checkout: entry.info,
      pathInCheckout: stored.pathInCheckout,
    };
  }

  // The repository shown for a file document.
  view(documentId: string): DocumentRepository {
    return this.#compose(this.#documents.get(documentId)?.value);
  }

  // Works out what applying the batch to these documents changes, without changing anything.
  // The caller passes only documents that are still open and were not closed since the batch was scheduled for them.
  // With `pendingWhenUnfinished`, a document with no earlier value shows `pending` until its detection finishes.
  stage(
    batch: DetectionBatch,
    targets: TrackedDocument[],
    options: { pendingWhenUnfinished: boolean },
  ): StagedRepositories {
    const documents = new Map<string, { sequence: number; value: Stored }>();
    const checkouts = new Map<string, CheckoutEntry>();
    const unfinished: TrackedDocument[] = [];
    const appliesTo = (current: { sequence: number; value?: Stored } | undefined) =>
      supersedes(current, batch.sequence);

    for (const target of targets) {
      const current = this.#documents.get(target.documentId);
      const detection = batch.results.get(target.path);
      if (detection === undefined) {
        unfinished.push(target);
        if (options.pendingWhenUnfinished && current === undefined) {
          documents.set(target.documentId, {
            sequence: batch.sequence,
            value: { state: 'pending' },
          });
        }
        continue;
      }
      if (!appliesTo(current)) continue;
      let value: Stored;
      if (detection.state === 'resolved' && detection.checkout !== null) {
        const { checkout } = detection;
        value = {
          state: 'resolved',
          checkoutId: checkout.id,
          pathInCheckout: detection.pathInCheckout,
        };
        // The repository and the worktree belong to the checkout: a newer result updates every document in it.
        if (appliesTo(this.#checkouts.get(checkout.id))) {
          checkouts.set(checkout.id, {
            sequence: batch.sequence,
            info: checkout,
            repositoryId: detection.id,
            nameSegments: detection.nameSegments,
          });
        }
      } else if (detection.state === 'resolved') {
        const { checkout: _none, ...rest } = detection;
        value = { ...rest, checkoutId: null };
      } else {
        value = detection;
      }
      documents.set(target.documentId, { sequence: batch.sequence, value });
    }

    // Whether any document shows something different: the updated documents,
    // and the documents in an updated checkout (their branch changes with it).
    const merged = new Map(this.#checkouts);
    for (const [id, entry] of checkouts) merged.set(id, entry);
    const affected = new Set(documents.keys());
    for (const id of checkouts.keys()) {
      for (const member of this.#members.get(id) ?? []) affected.add(member);
    }
    let changed = false;
    for (const documentId of affected) {
      const before = this.view(documentId);
      const after = this.#compose(
        documents.get(documentId)?.value ?? this.#documents.get(documentId)?.value,
        merged,
      );
      if (canonicalJson(before) !== canonicalJson(after)) {
        changed = true;
        break;
      }
    }
    return { changed, unfinished, documents, checkouts };
  }

  // Applies a staged result. Called right after the transaction that staged it committed.
  apply(staged: StagedRepositories): void {
    for (const [id, entry] of staged.checkouts) {
      if (supersedes(this.#checkouts.get(id), entry.sequence)) this.#checkouts.set(id, entry);
    }
    for (const [documentId, entry] of staged.documents) {
      // A placeholder never replaces a value.
      const current = this.#documents.get(documentId);
      if (entry.value.state === 'pending' && current !== undefined) continue;
      if (supersedes(current, entry.sequence)) this.#setDocument(documentId, entry);
    }
    this.#dropUnused();
  }

  #setDocument(documentId: string, entry: { sequence: number; value: Stored }): void {
    const before = this.#documents.get(documentId)?.value;
    if (before?.state === 'resolved' && before.checkoutId !== null) {
      this.#members.get(before.checkoutId)?.delete(documentId);
    }
    this.#documents.set(documentId, entry);
    if (entry.value.state === 'resolved' && entry.value.checkoutId !== null) {
      let members = this.#members.get(entry.value.checkoutId);
      if (!members) {
        members = new Set();
        this.#members.set(entry.value.checkoutId, members);
      }
      members.add(documentId);
    }
  }

  // Forgets closed documents. Checkouts nothing refers to anymore are dropped.
  forget(documentIds: Iterable<string>): void {
    for (const documentId of documentIds) {
      const before = this.#documents.get(documentId)?.value;
      if (before?.state === 'resolved' && before.checkoutId !== null) {
        this.#members.get(before.checkoutId)?.delete(documentId);
      }
      this.#documents.delete(documentId);
    }
    this.#dropUnused();
  }

  #dropUnused(): void {
    for (const [id, members] of this.#members) {
      if (members.size === 0) this.#members.delete(id);
    }
    for (const id of this.#checkouts.keys()) {
      if (!this.#members.has(id)) this.#checkouts.delete(id);
    }
  }

  retainedCounts(): Record<string, number> {
    return {
      repositoryDocuments: this.#documents.size,
      repositoryCheckouts: this.#checkouts.size,
      repositoryOperations: this.#limiter.active,
    };
  }
}
