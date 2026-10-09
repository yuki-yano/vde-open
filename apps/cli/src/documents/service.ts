import { randomBytes, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  assetTypeOf,
  buildLineIndex,
  byteRangeOfLines,
  classifyLink,
  classifyReference,
  extractTitle,
  HTML_STATIC_PARSER_PROFILE,
  lineOfByte,
  MARKDOWN_PARSER_PROFILE,
  ParseLimitError,
  truncateAtCodePoint,
  type DocumentAnalysis,
} from '@vde-open/document';
import { scanReferences, type ScanKind, type ScannedReference } from '@vde-open/document/render';
import {
  closeParamsSchema,
  documentIdSchema,
  htmlModeChangeParamsSchema,
  LIMITS,
  listParamsSchema,
  openParamsSchema,
  readParamsSchema,
  reorderParamsSchema,
  VdeError,
  type CloseResult,
  type DocumentFormat,
  type DocumentRepository,
  type DocumentSummary,
  type HtmlMode,
  type LinkOpenResult,
  type ListResult,
  type OpenResult,
  type OutlineItem,
  type ReadResult,
  type RefreshResult,
  type SourceState,
  type Warning,
  type WatchListResult,
  type WatchRule,
} from '@vde-open/shared';

import { buildManifest, type LoadedAsset } from '../assets/manifest.ts';
import {
  pendingRequestIdsOf,
  pinnedRevisions,
  type DocumentRecord,
  type RevisionRecord,
  type StatePayload,
} from '../persistence/state-schema.ts';
import type { StateStore, Transaction } from '../persistence/state-store.ts';
import type { CursorCodec } from './cursor.ts';
import {
  displayPathOf,
  expandTargets,
  formatOfPath,
  scanWatchTarget,
  watchBaseOf,
  type Candidate,
} from './enumerate.ts';
import {
  RepositoryTracker,
  type DetectionBatch,
  type RepositoryTrackerOptions,
  type StagedRepositories,
  type TrackedDocument,
} from './repository-tracker.ts';
import { computeRevision } from './revision.ts';
import {
  canonicalizePath,
  decodeSource,
  readSourceFile,
  type LoadedSource,
} from './source-reader.ts';

export interface ServiceResult<T> {
  data: T;
  catalogVersion: number;
  warnings: Warning[];
}

// Change notification. Carries only IDs, revisions, and statuses (spec 6.5). Never includes answer contents.
export interface DocumentEvent {
  type:
    | 'catalog-changed'
    | 'document-changed'
    | 'document-status'
    | 'focus-requested'
    | 'feedback-changed'
    | 'render-diagnostics';
  documentId?: string;
  revision?: string | null;
  requestId?: string;
  status?: 'pending' | 'submitted' | 'cancelled';
  draftVersion?: number;
  acknowledged?: boolean;
}

export interface DocumentServiceOptions {
  store: StateStore;
  cursors: CursorCodec;
  now?: () => Date;
  // Called only after a commit succeeds.
  emit?: (event: DocumentEvent) => void;
  // Analyzes the document structure. Heavy work, so the daemon offloads it to a worker.
  analyze?: (format: DocumentFormat, text: string) => Promise<DocumentAnalysis>;
  // Replaces the file read (used in tests to control the order in which reads complete).
  readSource?: (path: string, format: DocumentFormat) => Promise<LoadedSource>;
  // Collects candidate local files referenced by the document or CSS. The daemon offloads it to a worker.
  scan?: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
  // Per-document search state shown in the list. Without it, documents are treated as excluded from search.
  searchStateOf?: (documentId: string) => DocumentSummary['searchState'];
  // How the repository of a file document is detected (tests replace the filesystem and the wait limit).
  repositories?: RepositoryTrackerOptions;
}

// Result of re-reading a file. signature is the file state matching the content read; null if it could not be read.
export interface RefreshOutcome {
  changed: boolean;
  signature: string | null;
}

interface Incoming {
  sourceKind: 'file' | 'stdin' | 'generated';
  canonicalPath: string | null;
  displayPath: string | null;
  pathSegments: string[];
  format: DocumentFormat;
  bytes: Buffer;
  text: string;
  fallbackTitle: string;
  // State of the document and referenced files at read time. null for stdin.
  signature: string | null;
  assetsRoot: string | null;
  extraAssets: string[];
  // Document location (path relative to assets-root).
  documentLogicalPath: string;
  assets: LoadedAsset[];
  // Files tracked for changes besides the document (referenced assets, and referenced files that do not exist).
  trackedFiles: string[];
  // The reference scan did not finish (timeout or structure limit). No assets were collected.
  assetScanFailed: boolean;
}

// A loaded document before its assets are collected.
type IncomingSource = Omit<
  Incoming,
  | 'assetsRoot'
  | 'extraAssets'
  | 'documentLogicalPath'
  | 'assets'
  | 'trackedFiles'
  | 'assetScanFailed'
>;

// Confirmation for opening an unregistered document. Bound to the confirmed document, revision, link, and target.
interface LinkConfirmation {
  documentId: string;
  revision: string;
  linkId: string;
  canonicalPath: string;
  expiresAt: number;
}

const LINK_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_LINK_CONFIRMATIONS = 256;

// How assets are collected. root and explicit are undefined unless the user specified them (the registered value or the default is used).
interface AssetSettings {
  root: string | undefined;
  explicit: string[] | undefined;
  // Whether an unreadable explicitly specified asset is an error.
  strict: boolean;
}

const INHERITED_ASSETS: AssetSettings = { root: undefined, explicit: undefined, strict: false };

interface ResolvedCandidates {
  // Candidates by canonical path. Symlinked and duplicate entries are merged into one.
  unique: Map<string, { candidate: Candidate; format: DocumentFormat }>;
  problems: Problem[];
}

interface Problem {
  path: string;
  code: string;
  reason: string;
}

interface UpsertOptions {
  title?: string | undefined;
  key?: string | undefined;
  // Requested HTML view mode. Without it, new documents are static and existing documents keep theirs.
  htmlMode?: HtmlMode | undefined;
  // If false, closed documents are not reopened (used for updates driven by watch).
  reopen: boolean;
}

interface UpsertOutcome {
  documentId: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped';
  openSetChanged: boolean;
  revisionChanged: boolean;
}

// Limits on retained analysis results.
const ANALYSIS_CACHE_ENTRIES = 32;
const ANALYSIS_CACHE_BYTES = 32 * 1024 * 1024;

// How long to wait for a file that is temporarily missing (spec 8.5).
const MISSING_RETRY_MS = 1000;
const MISSING_RETRY_INTERVAL_MS = 100;

function profileOf(format: DocumentFormat): string {
  if (format === 'image') return 'image-v1';
  return format === 'markdown' ? MARKDOWN_PARSER_PROFILE : HTML_STATIC_PARSER_PROFILE;
}

export function toSummary(
  record: DocumentRecord,
  order: number,
  searchState: DocumentSummary['searchState'] = 'excluded',
  pendingRequestIds: string[] = [],
  interactiveAllowed = false,
  repository: DocumentRepository = null,
): DocumentSummary {
  return {
    documentId: record.documentId,
    key: record.key,
    format: record.format,
    sourceKind: record.sourceKind,
    title: record.title,
    displayPath: record.displayPath,
    pathSegments: record.pathSegments,
    canonicalPath: record.sourceKind === 'file' ? record.canonicalPath : null,
    repository,
    revision: record.currentRevision,
    sourceState: record.sourceState,
    searchState,
    openedAt: record.openedAt,
    updatedAt: record.updatedAt,
    order,
    pendingRequestIds,
    htmlMode: record.format === 'html' ? record.htmlMode : null,
    interactiveAllowed,
  };
}

// Keeps the latest 2 revisions, revisions created within 5 minutes, and revisions pinned by questions (spec 4.4, 11.4).
export function pruneRevisions(
  revisions: RevisionRecord[],
  now: number,
  pinned: ReadonlySet<string>,
): RevisionRecord[] {
  return revisions.filter((entry, index) => {
    const isRecent = index >= revisions.length - LIMITS.retainedRevisions;
    return (
      isRecent ||
      pinned.has(entry.revision) ||
      now - Date.parse(entry.createdAt) < LIMITS.revisionGraceMs
    );
  });
}

function openSourceBytes(state: StatePayload): number {
  let total = 0;
  for (const documentId of state.openOrder) {
    const record = state.documents[documentId];
    const current = record?.revisions.find((entry) => entry.revision === record.currentRevision);
    total += current?.byteLength ?? 0;
  }
  return total;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !fromRoot.startsWith(sep);
}

// Whether the document is within the rule's watch scope. For globs, checks whether it is under the watch base.
function ruleCovers(rule: WatchRule, canonicalPath: string): boolean {
  const base = watchBaseOf(rule);
  if (!isInside(base.directory, canonicalPath)) return false;
  return base.recursive || resolve(canonicalPath, '..') === base.directory;
}

function assetScanWarning(path: string): Warning {
  return {
    code: 'W_ASSET_SCAN_FAILED',
    message: `Could not scan the files referenced by ${path}. Images and CSS were not registered. Run refresh to scan again.`,
    details: { path },
  };
}

function assetScanError(): VdeError {
  return new VdeError(
    'E_PARSE_FAILED',
    'The document was not updated because the files it references could not be scanned.',
    { reason: 'asset-scan-failed' },
  );
}

function assertOpenLimits(state: StatePayload): void {
  if (state.openOrder.length > LIMITS.openDocuments) {
    throw new VdeError(
      'E_LIMIT_EXCEEDED',
      'The limit on the number of open documents would be exceeded.',
      {
        limit: 'openDocuments',
        max: LIMITS.openDocuments,
        actual: state.openOrder.length,
      },
    );
  }
  const sourceBytes = openSourceBytes(state);
  if (sourceBytes > LIMITS.openSourceBytes) {
    throw new VdeError(
      'E_LIMIT_EXCEEDED',
      'The total size of open documents would exceed the limit.',
      {
        limit: 'openSourceBytes',
        max: LIMITS.openSourceBytes,
        actual: sourceBytes,
      },
    );
  }
}

export class DocumentService {
  readonly #store: StateStore;
  readonly #cursors: CursorCodec;
  readonly #now: () => Date;
  readonly #emit: (event: DocumentEvent) => void;
  readonly #analyze: ((format: DocumentFormat, text: string) => Promise<DocumentAnalysis>) | null;
  readonly #readSource: (path: string, format: DocumentFormat) => Promise<LoadedSource>;
  // Analysis results by revision. Keyed by revision so a late result for an old revision is never used for a new one.
  // They include section bodies, so both the entry count and the total source size are limited.
  readonly #analysisCache = new Map<string, { analysis: DocumentAnalysis; bytes: number }>();
  #analysisCacheBytes = 0;
  readonly #scan: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
  readonly #searchStateOf: (documentId: string) => DocumentSummary['searchState'];
  // By canonical path: the file state matching the published content, and files tracked besides the document.
  // signature is null when the file could not be read.
  readonly #signatures = new Map<string, { signature: string | null; files: string[] }>();
  // Queue per canonical path. Runs "read then publish" for the same file one at a time.
  readonly #pathQueues = new Map<string, Promise<void>>();
  // How many times each document has been closed. Keeps results of work started before a close from binding to the reopened document.
  readonly #openEpochs = new Map<string, number>();
  // Permission to run scripts (interactive view). Document ID, the close count when granted, and the permission generation.
  // Held only in daemon memory (not carried over automatically across restarts, closes, or replacement by another source; spec 10.2).
  // The generation changes on every grant. Re-granting after revocation does not revive views issued under the previous permission.
  readonly #interactive = new Map<string, { epoch: number; generation: number }>();
  #interactiveGenerations = 0;
  readonly #linkConfirmations = new Map<string, LinkConfirmation>();
  // Which repository each open file document belongs to. Daemon memory only.
  readonly #repositories: RepositoryTracker;

  constructor(options: DocumentServiceOptions) {
    this.#store = options.store;
    this.#cursors = options.cursors;
    this.#now = options.now ?? (() => new Date());
    this.#emit = options.emit ?? (() => undefined);
    this.#analyze = options.analyze ?? null;
    this.#readSource = options.readSource ?? readSourceFile;
    this.#scan = options.scan ?? ((kind, text) => Promise.resolve(scanReferences(kind, text)));
    this.#searchStateOf = options.searchStateOf ?? (() => 'excluded');
    this.#repositories = new RepositoryTracker(options.repositories);
  }

  // Detects the repositories of the open file documents before the daemon accepts requests.
  // Waits up to the wait limit. Documents still being detected show `pending` and are updated when detection finishes.
  // Missing documents are detected from their stored path too, since nothing is known about them yet.
  // Nobody holds a list yet, so the catalog version does not change and nothing is notified.
  async initializeRepositories(): Promise<void> {
    const state = this.#store.payload;
    const targets = this.#trackedFiles(state, state.openOrder);
    if (targets.length === 0) return;
    const batch = this.#repositories.begin(targets.map((target) => target.path));
    await this.#repositories.wait(batch);
    const staged = this.#repositories.stage(batch, targets, { pendingWhenUnfinished: true });
    this.#repositories.apply(staged);
    this.#applyWhenDone(batch, staged.unfinished);
  }

  #trackedFiles(state: StatePayload, documentIds: Iterable<string>): TrackedDocument[] {
    const targets: TrackedDocument[] = [];
    for (const documentId of documentIds) {
      const record = state.documents[documentId];
      if (record?.isOpen && record.sourceKind === 'file' && record.canonicalPath !== null) {
        targets.push({ documentId, path: record.canonicalPath, epoch: this.openEpoch(documentId) });
      }
    }
    return targets;
  }

  // Applies a finished (or partly finished) batch in its own transaction.
  // Documents closed or closed and reopened since they were scheduled are skipped.
  // If anything shown changes, the catalog version goes up so a paged list started before cannot mix old and new values.
  async #applyBatch(batch: DetectionBatch, targets: TrackedDocument[]): Promise<TrackedDocument[]> {
    let staged: StagedRepositories | null = null;
    await this.#store.transaction((tx) => {
      const live = targets.filter(
        (target) =>
          tx.state.documents[target.documentId]?.isOpen === true &&
          this.openEpoch(target.documentId) === target.epoch,
      );
      const next = this.#repositories.stage(batch, live, { pendingWhenUnfinished: false });
      if (next.changed) tx.state.catalogVersion += 1;
      staged = next;
    });
    // Applied right after the commit, before any other request can read the list.
    const applied = staged as StagedRepositories | null;
    if (applied === null) return [];
    this.#repositories.apply(applied);
    if (applied.changed) this.#emit({ type: 'catalog-changed' });
    return applied.unfinished;
  }

  // Detection that did not finish within the wait limit keeps running. Each result is applied when it arrives,
  // without waiting for the rest of its batch (one stuck path must not hold back the others).
  // Results that arrive close together are gathered into one transaction and one notification; the gathering
  // grows while results keep coming (see REPOSITORY_LATE_APPLY_MS).
  #applyWhenDone(batch: DetectionBatch, targets: TrackedDocument[]): void {
    if (targets.length === 0) return;
    let ready: TrackedDocument[] = [];
    let timer: NodeJS.Timeout | null = null;
    let delay = this.#repositories.lateApplyMs;
    const flush = () => {
      timer = null;
      const now = ready;
      ready = [];
      delay = Math.min(delay * 2, this.#repositories.lateApplyMaxMs);
      // The store can be closed by then (the daemon is stopping). The value stays as it was.
      void this.#applyBatch(batch, now).catch(() => undefined);
    };
    for (const target of targets) {
      void batch.settled(target.path).then(() => {
        ready.push(target);
        timer ??= setTimeout(flush, delay);
      });
    }
  }

  // Detects again for documents that are not missing (an explicit refresh). Missing documents keep their value.
  async #redetect(documentIds: string[]): Promise<void> {
    const state = this.#store.payload;
    const targets = this.#trackedFiles(
      state,
      documentIds.filter((documentId) => state.documents[documentId]?.sourceState !== 'missing'),
    );
    if (targets.length === 0) return;
    const batch = this.#repositories.begin(targets.map((target) => target.path));
    await this.#repositories.wait(batch);
    this.#applyWhenDone(batch, await this.#applyBatch(batch, targets));
  }

  // Runs "read then publish" one at a time for the same file.
  // If run concurrently, old content read first could be published later and overwrite new content.
  // The order reads start does not determine which is newer (a read started earlier may read newer content later).
  // When handling several files, acquire them in a fixed order so they never wait on each other.
  async #withPathLocks<T>(paths: Iterable<string>, work: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const path of [...new Set(paths)].toSorted()) {
        releases.push(await this.#acquirePath(path));
      }
      return await work();
    } finally {
      for (const release of releases) release();
    }
  }

  #acquirePath(path: string): Promise<() => void> {
    const previous = this.#pathQueues.get(path) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => {
      open = resolveHeld;
    });
    const tail = previous.then(() => held);
    this.#pathQueues.set(path, tail);
    return previous.then(() => () => {
      open();
      if (this.#pathQueues.get(path) === tail) this.#pathQueues.delete(path);
    });
  }

  // File state matching the content in state. null if not yet read since the daemon started.
  readSignature(documentId: string): string | null {
    const path = this.#store.payload.documents[documentId]?.canonicalPath;
    return path ? (this.#signatures.get(path)?.signature ?? null) : null;
  }

  // Files tracked for changes besides the document. Watch joins the states of the document and these files and compares with readSignature.
  trackedFiles(documentId: string): string[] {
    const path = this.#store.payload.documents[documentId]?.canonicalPath;
    return path ? (this.#signatures.get(path)?.files ?? []) : [];
  }

  // Collects the local files referenced by a loaded document.
  async #withAssets(
    source: IncomingSource,
    existing: DocumentRecord | undefined,
    settings: AssetSettings,
  ): Promise<Incoming> {
    const { canonicalPath } = source;
    const assetsRoot =
      settings.root ??
      (existing ? existing.assetsRoot : canonicalPath === null ? null : dirname(canonicalPath));
    const extraAssets = settings.explicit ?? existing?.extraAssets ?? [];
    // A document that cannot use local assets cannot register explicit ones either. Do not ignore them silently.
    if (assetsRoot === null && settings.explicit !== undefined) {
      throw new VdeError('E_INVALID_ARGUMENT', '--asset requires --assets-root.', {
        assets: settings.explicit,
      });
    }
    let documentLogicalPath = source.format === 'html' ? 'index.html' : 'index.md';
    if (canonicalPath !== null && assetsRoot !== null) {
      const fromRoot = relative(assetsRoot, canonicalPath);
      if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        throw new VdeError('E_INVALID_ARGUMENT', 'The document is not inside assets-root.', {
          path: source.displayPath ?? canonicalPath,
          assetsRoot,
        });
      }
      documentLogicalPath = fromRoot.split(sep).join('/');
    }
    if (source.format === 'image') {
      const type = assetTypeOf(documentLogicalPath);
      if (type?.role !== 'image' && type?.role !== 'svg') {
        throw new VdeError('E_UNSUPPORTED_FORMAT', 'The file extension is not an image format.');
      }
      if (extraAssets.length > 0) {
        throw new VdeError('E_INVALID_ARGUMENT', '--asset is not available for standalone images.');
      }
      return {
        ...source,
        assetsRoot,
        extraAssets: [],
        documentLogicalPath,
        assets: [],
        trackedFiles: [],
        assetScanFailed: false,
      };
    }
    // Distinguish a scan that did not finish from a document with no references.
    let assetScanFailed = false;
    const manifest = await buildManifest({
      format: source.format,
      text: source.text,
      documentLogicalPath,
      assetsRoot,
      explicit: extraAssets,
      strictExplicit: settings.strict,
      scan: async (kind, text) => {
        try {
          return await this.#scan(kind, text);
        } catch (error) {
          const unparsable =
            error instanceof ParseLimitError ||
            (error instanceof VdeError && error.code === 'E_PARSE_FAILED');
          if (!unparsable) throw error;
          assetScanFailed = true;
          return [];
        }
      },
    });
    // Partially collected assets are not used. The document is treated as one whose assets could not be collected.
    // Tracked files and the state used for comparison come from the same result. If they disagree, re-reads continue even without changes.
    const tracked = assetScanFailed ? [] : manifest.tracked;
    return {
      ...source,
      signature:
        source.signature === null
          ? null
          : [source.signature, ...tracked.map((entry) => entry.signature)].join('|'),
      assetsRoot,
      extraAssets,
      documentLogicalPath,
      assets: assetScanFailed ? [] : manifest.assets,
      trackedFiles: tracked.map((entry) => entry.path),
      assetScanFailed,
    };
  }

  // Whether the current revision of an open document has fully scanned assets.
  // If so, it is not replaced by a failed scan result (that would lose the assets and tracked files).
  #hasCompleteAssets(existing: DocumentRecord | undefined): boolean {
    if (!existing?.isOpen) return false;
    const current = existing.revisions.find((entry) => entry.revision === existing.currentRevision);
    return current?.assetScan === 'complete';
  }

  // How many times the document has been closed. Keeps work started before a close from applying to the reopened document.
  openEpoch(documentId: string): number {
    return this.#openEpochs.get(documentId) ?? 0;
  }

  // For an HTML document, the permission generation if the interactive view was explicitly allowed in this daemon.
  interactiveGeneration(documentId: string): number | null {
    const record = this.#store.payload.documents[documentId];
    const permission = this.#interactive.get(documentId);
    const allowed =
      record !== undefined &&
      record.isOpen &&
      record.format === 'html' &&
      record.htmlMode === 'interactive' &&
      permission !== undefined &&
      permission.epoch === this.openEpoch(documentId);
    return allowed ? permission.generation : null;
  }

  interactiveAllowed(documentId: string): boolean {
    return this.interactiveGeneration(documentId) !== null;
  }

  // Changes the permission. Granting while already granted keeps the generation. Returns true if it changed.
  #setInteractive(documentId: string, allowed: boolean): boolean {
    const before = this.interactiveGeneration(documentId);
    if (!allowed) this.#interactive.delete(documentId);
    else if (before === null) {
      this.#interactiveGenerations += 1;
      this.#interactive.set(documentId, {
        epoch: this.openEpoch(documentId),
        generation: this.#interactiveGenerations,
      });
    }
    return before !== this.interactiveGeneration(documentId);
  }

  // Changes the HTML view mode by an explicit action in the management UI. Switching to interactive requires confirmation (spec 10.2).
  async setHtmlMode(rawParams: unknown): Promise<ServiceResult<DocumentSummary>> {
    const params = htmlModeChangeParamsSchema.parse(rawParams);
    if (params.mode === 'interactive' && !params.confirmed) {
      throw new VdeError(
        'E_CONFIRMATION_REQUIRED',
        'Switching to the interactive view requires confirmation.',
        { documentId: params.documentId },
      );
    }
    const result = await this.#store.transaction((tx) => {
      const record = tx.state.documents[params.documentId];
      if (!record?.isOpen) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', 'The document is not open.', {
          documentId: params.documentId,
        });
      }
      if (record.format !== 'html') {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          'The view mode can only be chosen for HTML documents.',
          {
            documentId: params.documentId,
          },
        );
      }
      if (record.htmlMode !== params.mode) {
        record.htmlMode = params.mode;
        record.updatedAt = this.#now().toISOString();
      }
      return { catalogVersion: tx.state.catalogVersion };
    });
    this.#setInteractive(params.documentId, params.mode === 'interactive');
    this.#emit({ type: 'document-status', documentId: params.documentId });
    return {
      data: this.#summary(this.#store.payload, params.documentId),
      catalogVersion: result.catalogVersion,
      warnings: [],
    };
  }

  #record(item: Incoming): void {
    if (item.canonicalPath === null) return;
    this.#signatures.set(item.canonicalPath, {
      signature: item.signature,
      files: item.trackedFiles,
    });
  }

  #existingFile(canonicalPath: string): DocumentRecord | undefined {
    return Object.values(this.#store.payload.documents).find(
      (record) => record.sourceKind === 'file' && record.canonicalPath === canonicalPath,
    );
  }

  // Decides how to collect assets from the user's options.
  async #assetSettings(params: ReturnType<typeof openParamsSchema.parse>): Promise<AssetSettings> {
    let root: string | undefined;
    if (params.assetsRoot !== undefined) {
      const requested = resolve(params.cwd, params.assetsRoot);
      try {
        root = await realpath(requested);
        if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new VdeError('E_INVALID_ARGUMENT', '--assets-root must be a directory.', {
          assetsRoot: params.assetsRoot,
        });
      }
    }
    const explicit =
      params.assets.length === 0
        ? undefined
        : params.assets.map((asset) => {
            const reference = classifyReference(asset, '');
            if (reference.kind !== 'local') {
              throw new VdeError(
                'E_ASSET_REJECTED',
                `${asset} cannot be registered as an asset. Specify a path relative to assets-root.`,
                {
                  asset,
                  reason: reference.kind === 'rejected' ? reference.reason : reference.kind,
                },
              );
            }
            return reference.logicalPath;
          });
    return { root, explicit, strict: true };
  }

  get state(): StatePayload {
    return this.#store.payload;
  }

  // Counts of retained entries (used to check for resource leaks; daemon.diagnostics).
  retainedCounts(): Record<string, number> {
    return {
      analysisCache: this.#analysisCache.size,
      signatures: this.#signatures.size,
      pathQueues: this.#pathQueues.size,
      openEpochs: this.#openEpochs.size,
      interactive: this.#interactive.size,
      linkConfirmations: this.#linkConfirmations.size,
      ...this.#repositories.retainedCounts(),
    };
  }

  // Checks all candidates first; if any has a problem, registers nothing (spec 5.2).
  async open(rawParams: unknown): Promise<ServiceResult<OpenResult>> {
    const params = openParamsSchema.parse(rawParams);
    const warnings: Warning[] = [];

    if (params.stdin) {
      if (params.paths.length > 0) {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdin and paths cannot be specified together.');
      }
      if (params.format === 'auto') {
        throw new VdeError('E_INVALID_ARGUMENT', '--format is required when opening from stdin.');
      }
      if (params.watch) {
        throw new VdeError('E_INVALID_ARGUMENT', '--watch applies to a directory or a glob.');
      }
      if (params.htmlMode !== undefined && params.format !== 'html') {
        throw new VdeError('E_INVALID_ARGUMENT', '--html-mode applies to HTML documents.');
      }
      const { format, key } = params;
      const bytes = Buffer.from(params.stdin.content, 'utf8');
      const text = decodeSource(bytes, 'stdin');
      const settings = await this.#assetSettings(params);
      const openStdin = async (): Promise<ServiceResult<OpenResult>> => {
        // When updating a document with the same key, use the registered asset settings unless specified.
        const existing =
          key === undefined
            ? undefined
            : Object.values(this.#store.payload.documents).find(
                (record) => record.sourceKind !== 'file' && record.key === key,
              );
        const item = await this.#withAssets(
          {
            sourceKind: 'stdin',
            canonicalPath: null,
            displayPath: null,
            pathSegments: [],
            format,
            bytes,
            text,
            fallbackTitle: key ?? 'stdin',
            signature: null,
          },
          existing,
          settings,
        );
        if (item.assetScanFailed) {
          if (this.#hasCompleteAssets(existing)) throw assetScanError();
          warnings.push(assetScanWarning('stdin'));
        }
        return this.#commitOpen(params, [item], [], settings, warnings);
      };
      // Updates with the same key run scan-to-register one at a time, for the same reason as file documents.
      // A document without a key becomes a new document every time, so there is nothing to wait for.
      return key === undefined ? openStdin() : this.#withPathLocks([`stdin-key:${key}`], openStdin);
    }

    if (params.paths.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', 'Specify the documents to open.');
    }
    const expansion = await expandTargets(params.cwd, params.paths, params.recursive);
    const watchTargets = params.watch ? expansion.watchTargets : [];
    if (params.watch && watchTargets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '--watch applies to a directory or a glob.');
    }
    for (const target of expansion.emptyTargets) {
      warnings.push({
        code: 'W_NO_DOCUMENTS',
        message: `No documents found in ${target}.`,
        details: { path: target },
      });
    }
    const resolved = await this.#resolveCandidates(
      expansion.candidates,
      params.format === 'auto' ? null : params.format,
    );
    const settings = await this.#assetSettings(params);
    if (settings.explicit !== undefined && resolved.unique.size !== 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        '--asset can only be specified when opening a single document.',
        {
          documents: resolved.unique.size,
        },
      );
    }
    if (
      params.htmlMode !== undefined &&
      ![...resolved.unique.values()].some((entry) => entry.format === 'html')
    ) {
      throw new VdeError('E_INVALID_ARGUMENT', '--html-mode applies to HTML documents.');
    }
    // Repository detection runs while the documents are read, and is waited for up to the wait limit.
    const batch = this.#repositories.begin(resolved.unique.keys());
    return this.#withPathLocks(resolved.unique.keys(), async () => {
      const incoming = await this.#readCandidates(resolved, settings, warnings);
      // With --watch, the rule alone can be registered even if there are no documents yet.
      if (incoming.length === 0 && watchTargets.length === 0) {
        throw new VdeError('E_PATH_NOT_FOUND', 'No documents found.', {
          paths: params.paths,
        });
      }
      await this.#repositories.wait(batch);
      return this.#commitOpen(params, incoming, watchTargets, settings, warnings, batch);
    });
  }

  async #commitOpen(
    params: ReturnType<typeof openParamsSchema.parse>,
    incoming: Incoming[],
    watchTargets: Awaited<ReturnType<typeof expandTargets>>['watchTargets'],
    settings: AssetSettings,
    warnings: Warning[],
    batch?: DetectionBatch,
  ): Promise<ServiceResult<OpenResult>> {
    if ((params.title !== undefined || params.key !== undefined) && incoming.length !== 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        '--title and --key can only be specified when opening a single document.',
        { documents: incoming.length },
      );
    }

    const events: DocumentEvent[] = [];
    let repositories: StagedRepositories | null = null;
    const result = await this.#store.transaction((tx) => {
      const state = tx.state;
      const timestamp = this.#now().toISOString();
      const touched: string[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let openSetChanged = false;

      for (const item of incoming) {
        const outcome = this.#upsert(tx, item, {
          title: params.title,
          key: params.key,
          htmlMode: item.format === 'html' ? params.htmlMode : undefined,
          reopen: true,
        });
        touched.push(outcome.documentId);
        if (outcome.outcome === 'created') created += 1;
        else if (outcome.outcome === 'updated') updated += 1;
        else unchanged += 1;
        openSetChanged ||= outcome.openSetChanged;
        // Title-only or status-only changes are also notified. The UI re-fetches the list on notification.
        if (outcome.outcome === 'updated') {
          events.push({
            type: outcome.revisionChanged ? 'document-changed' : 'document-status',
            documentId: outcome.documentId,
            revision: state.documents[outcome.documentId]?.currentRevision ?? null,
          });
        }
        // An explicitly opened document is no longer suppressed ("closed, do not restore") by watch rules.
        if (item.canonicalPath !== null) {
          for (const rule of state.watchRules) {
            rule.suppressedPaths = rule.suppressedPaths.filter(
              (path) => path !== item.canonicalPath,
            );
          }
        }
      }

      const rules: WatchRule[] = [];
      for (const target of watchTargets) {
        let rule = state.watchRules.find(
          (candidate) =>
            candidate.kind === target.kind &&
            candidate.root === target.root &&
            candidate.pattern === target.pattern &&
            candidate.recursive === target.recursive,
        );
        if (!rule) {
          rule = {
            watchId: `watch_${randomUUID()}`,
            ...target,
            suppressedPaths: [],
            createdAt: timestamp,
            assetsRoot: settings.root ?? null,
          };
          state.watchRules.push(rule);
        } else if (settings.root !== undefined) {
          // The same target was registered again with assets-root. Documents found later also use the new value.
          rule.assetsRoot = settings.root;
        }
        rules.push(rule);
      }

      assertOpenLimits(state);
      // Matched with the documents after they are registered (a new document has an ID only now).
      if (batch !== undefined) {
        repositories = this.#repositories.stage(batch, this.#trackedFiles(state, touched), {
          pendingWhenUnfinished: true,
        });
      }
      const repositoryChanged = (repositories as StagedRepositories | null)?.changed === true;
      if (created + updated > 0 || repositoryChanged) state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      if (openSetChanged || repositoryChanged) events.unshift({ type: 'catalog-changed' });

      return {
        data: {
          documents: touched.map((documentId) => this.#summary(state, documentId)),
          watchRules: structuredClone(rules),
          created,
          updated,
          unchanged,
        },
        catalogVersion: state.catalogVersion,
        warnings,
      };
    });
    // Applied right after the commit, before any other request can read the list.
    const staged = repositories as StagedRepositories | null;
    if (staged !== null && batch !== undefined) {
      this.#repositories.apply(staged);
      this.#applyWhenDone(batch, staged.unfinished);
    }
    for (const item of incoming) this.#record(item);
    // Script permission changes only after the commit. An explicit interactive option grants it;
    // a static option or a stdin update (replacement with other content) revokes it. Reopening the same file keeps it.
    const permissionChanged: string[] = [];
    result.data.documents.forEach((summary, index) => {
      const item = incoming[index];
      if (summary.format !== 'html' || !item) return;
      let changed = false;
      // A stdin update replaces the content. Revoke the previous permission, then re-grant if explicitly requested.
      if (params.htmlMode === 'static' || item.sourceKind !== 'file') {
        changed = this.#setInteractive(summary.documentId, false);
      }
      if (params.htmlMode === 'interactive') {
        changed = this.#setInteractive(summary.documentId, true) || changed;
      }
      if (changed) permissionChanged.push(summary.documentId);
    });
    result.data.documents = result.data.documents.map((summary) =>
      this.#summary(this.#store.payload, summary.documentId),
    );
    for (const event of events) this.#emit(event);
    for (const documentId of permissionChanged) {
      if (!events.some((event) => event.documentId === documentId)) {
        this.#emit({ type: 'document-status', documentId });
      }
    }
    return result;
  }

  // Format checks run on all candidates; content is read only after removing duplicates.
  async #resolveCandidates(
    candidates: Candidate[],
    explicitFormat: DocumentFormat | null,
  ): Promise<ResolvedCandidates> {
    const problems: Problem[] = [];
    const unique = new Map<string, { candidate: Candidate; format: DocumentFormat }>();
    for (const candidate of candidates) {
      const format = candidate.explicit
        ? (explicitFormat ?? formatOfPath(candidate.absolutePath))
        : formatOfPath(candidate.absolutePath);
      if (!format) {
        problems.push({
          path: candidate.displayPath,
          code: 'E_UNSUPPORTED_FORMAT',
          reason: 'unknown-extension',
        });
        continue;
      }
      // Symlinked and duplicate entries count as one canonical file.
      const canonicalPath = await canonicalizePath(candidate.absolutePath);
      const first = unique.get(canonicalPath);
      // If the same file is both specified directly and enumerated, the direct one wins.
      if (!first || (candidate.explicit && !first.candidate.explicit)) {
        unique.set(canonicalPath, { candidate, format });
      }
    }
    if (unique.size > LIMITS.openDocuments) {
      throw new VdeError(
        'E_LIMIT_EXCEEDED',
        'The limit on the number of open documents would be exceeded.',
        {
          limit: 'openDocuments',
          max: LIMITS.openDocuments,
          actual: unique.size,
        },
      );
    }
    return { unique, problems };
  }

  // Reads candidate contents. The caller acquires the queues of the target files first.
  async #readCandidates(
    resolved: ResolvedCandidates,
    settings: AssetSettings,
    warnings: Warning[],
  ): Promise<Incoming[]> {
    const problems = [...resolved.problems];
    // The total size is checked while reading. Never load more than the limit into memory.
    const incoming: Incoming[] = [];
    let loadedBytes = 0;
    for (const [canonicalPath, { candidate, format }] of resolved.unique) {
      let loaded;
      try {
        loaded = await this.#readSource(candidate.absolutePath, format);
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        problems.push({
          path: candidate.displayPath,
          code: error.code,
          reason: String(error.details['reason'] ?? error.details['limit'] ?? 'unreadable'),
        });
        continue;
      }
      // The path started pointing at another file after the queue was acquired. Ordering cannot be guaranteed, so do not register.
      if (loaded.canonicalPath !== canonicalPath) {
        problems.push({ path: candidate.displayPath, code: 'E_IO', reason: 'changed-during-read' });
        continue;
      }
      loadedBytes += loaded.bytes.byteLength;
      if (loadedBytes > LIMITS.openSourceBytes) {
        throw new VdeError(
          'E_LIMIT_EXCEEDED',
          'The total size of open documents would exceed the limit.',
          {
            limit: 'openSourceBytes',
            max: LIMITS.openSourceBytes,
          },
        );
      }
      try {
        const existing = this.#existingFile(loaded.canonicalPath);
        const item = await this.#withAssets(
          {
            sourceKind: 'file',
            canonicalPath: loaded.canonicalPath,
            displayPath: candidate.displayPath,
            pathSegments: loaded.canonicalPath.split(sep).filter((segment) => segment !== ''),
            format,
            bytes: loaded.bytes,
            text: loaded.text,
            fallbackTitle: basename(loaded.canonicalPath),
            signature: loaded.signature,
          },
          existing,
          settings,
        );
        if (item.assetScanFailed) {
          // Do not replace a document with fully scanned assets by a failed scan result.
          if (this.#hasCompleteAssets(existing)) {
            problems.push({
              path: candidate.displayPath,
              code: 'E_PARSE_FAILED',
              reason: 'asset-scan-failed',
            });
            continue;
          }
          warnings.push(assetScanWarning(candidate.displayPath));
        }
        incoming.push(item);
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        problems.push({
          path: candidate.displayPath,
          code: error.code,
          reason: String(
            error.details['reason'] ?? error.details['limit'] ?? error.details['asset'] ?? 'asset',
          ),
        });
      }
    }
    if (problems.length > 0) {
      const first = problems[0] as Problem;
      throw new VdeError(
        first.code as VdeError['code'],
        `${String(problems.length)} document(s) could not be opened, so none were registered.`,
        { problems },
      );
    }
    return incoming;
  }

  // Applies the loaded content to state. Identical content does not add a revision.
  #upsert(tx: Transaction, item: Incoming, options: UpsertOptions): UpsertOutcome {
    const state = tx.state;
    const now = this.#now();
    const timestamp = now.toISOString();
    const existing = this.#findExisting(state, item, options.key);
    if (options.key !== undefined) {
      const holder = Object.values(state.documents).find((record) => record.key === options.key);
      if (holder && holder.documentId !== existing?.documentId) {
        throw new VdeError('E_KEY_CONFLICT', 'That key is used by another document.', {
          key: options.key,
          documentId: holder.documentId,
        });
      }
    }
    if (existing && !existing.isOpen && !options.reopen) {
      return {
        documentId: existing.documentId,
        outcome: 'skipped',
        openSetChanged: false,
        revisionChanged: false,
      };
    }
    // Check against the state at registration time. Do not replace a document with fully scanned assets by a failed scan result.
    if (item.assetScanFailed && this.#hasCompleteAssets(existing)) throw assetScanError();

    const sourceSha256 = tx.putBlob(item.bytes);
    const assets = item.assets.map((asset) => ({
      logicalPath: asset.logicalPath,
      mime: asset.mime,
      role: asset.role,
      sha256: tx.putBlob(asset.bytes),
      byteLength: asset.bytes.byteLength,
    }));
    // If a referenced file changes, the revision changes even with the same content (spec 4.1).
    const revision = computeRevision({
      format: item.format,
      sourceSha256,
      parserProfileVersion: profileOf(item.format),
      assets: assets.map(({ logicalPath, mime, role, sha256 }) => ({
        logicalPath,
        mime,
        role,
        sha256,
      })),
    });
    const title =
      options.title ??
      (item.format === 'image' ? null : extractTitle(item.text, item.format)) ??
      item.fallbackTitle;
    const revisionRecord: RevisionRecord = {
      revision,
      format: item.format,
      sourceSha256,
      byteLength: item.bytes.byteLength,
      parserProfileVersion: profileOf(item.format),
      createdAt: timestamp,
      documentLogicalPath: item.documentLogicalPath,
      assets,
      assetScan: item.assetScanFailed ? 'failed' : 'complete',
    };

    if (!existing) {
      const documentId = `doc_${randomUUID()}`;
      const htmlMode: HtmlMode = options.htmlMode ?? 'static';
      state.documents[documentId] = {
        documentId,
        sourceKind: item.sourceKind,
        canonicalPath: item.canonicalPath,
        key: options.key ?? null,
        format: item.format,
        title,
        titleExplicit: options.title !== undefined,
        displayPath: item.displayPath,
        pathSegments: item.pathSegments,
        isOpen: true,
        openedAt: timestamp,
        updatedAt: timestamp,
        sourceState: 'ready',
        currentRevision: revision,
        revisions: [revisionRecord],
        assetsRoot: item.assetsRoot,
        extraAssets: item.extraAssets,
        htmlMode,
      };
      state.openOrder.push(documentId);
      return { documentId, outcome: 'created', openSetChanged: true, revisionChanged: true };
    }

    let changed = false;
    let openSetChanged = false;
    let revisionChanged = false;
    if (!existing.isOpen) {
      existing.isOpen = true;
      existing.openedAt = timestamp;
      state.openOrder.push(existing.documentId);
      changed = true;
      openSetChanged = true;
    }
    if (existing.currentRevision !== revision) {
      const kept = existing.revisions.filter((entry) => entry.revision !== revision);
      kept.push(revisionRecord);
      existing.revisions = pruneRevisions(
        kept,
        now.getTime(),
        pinnedRevisions(state, existing.documentId),
      );
      existing.currentRevision = revision;
      existing.format = item.format;
      changed = true;
      revisionChanged = true;
    } else {
      // Even with the same revision, whether the scan completed can change (a document with no references).
      const current = existing.revisions.find((entry) => entry.revision === revision);
      if (current && current.assetScan !== revisionRecord.assetScan) {
        current.assetScan = revisionRecord.assetScan;
        changed = true;
      }
    }
    if (existing.sourceState !== 'ready') {
      existing.sourceState = 'ready';
      changed = true;
    }
    if (
      existing.assetsRoot !== item.assetsRoot ||
      existing.extraAssets.join('\n') !== item.extraAssets.join('\n')
    ) {
      existing.assetsRoot = item.assetsRoot;
      existing.extraAssets = item.extraAssets;
      changed = true;
    }
    if (options.title !== undefined) {
      changed ||= existing.title !== title || !existing.titleExplicit;
      existing.title = title;
      existing.titleExplicit = true;
    } else if (!existing.titleExplicit && existing.title !== title) {
      existing.title = title;
      changed = true;
    }
    if (options.key !== undefined && existing.key !== options.key) {
      existing.key = options.key;
      changed = true;
    }
    if (options.htmlMode !== undefined && existing.htmlMode !== options.htmlMode) {
      existing.htmlMode = options.htmlMode;
      changed = true;
    }
    if (options.reopen && item.displayPath !== null && existing.displayPath !== item.displayPath) {
      existing.displayPath = item.displayPath;
      changed = true;
    }
    if (changed) existing.updatedAt = timestamp;
    return {
      documentId: existing.documentId,
      outcome: changed ? 'updated' : 'unchanged',
      openSetChanged,
      revisionChanged,
    };
  }

  // Document info shown in the list. Includes order, search state, and pending questions.
  #summary(state: StatePayload, documentId: string): DocumentSummary {
    return toSummary(
      state.documents[documentId] as DocumentRecord,
      state.openOrder.indexOf(documentId),
      this.#searchStateOf(documentId),
      pendingRequestIdsOf(state, documentId),
      this.interactiveAllowed(documentId),
      state.documents[documentId]?.sourceKind === 'file'
        ? this.#repositories.view(documentId)
        : null,
    );
  }

  #findExisting(
    state: StatePayload,
    item: Incoming,
    key: string | undefined,
  ): DocumentRecord | undefined {
    if (item.sourceKind === 'file') {
      return Object.values(state.documents).find(
        (record) => record.sourceKind === 'file' && record.canonicalPath === item.canonicalPath,
      );
    }
    // stdin without a key becomes a new document on every call.
    if (key === undefined) return undefined;
    return Object.values(state.documents).find(
      (record) => record.sourceKind !== 'file' && record.key === key,
    );
  }

  list(rawParams: unknown): ServiceResult<ListResult> {
    const params = listParamsSchema.parse(rawParams);
    const state = this.#store.payload;
    let offset = 0;
    if (params.cursor !== undefined) {
      const payload = this.#cursors.decode(params.cursor, 'list');
      if (payload['catalogVersion'] !== state.catalogVersion) {
        throw new VdeError(
          'E_CURSOR_STALE',
          'The list has changed. Fetch it again from the start.',
          {
            catalogVersion: state.catalogVersion,
          },
        );
      }
      offset = payload['offset'] as number;
    }
    const page = state.openOrder.slice(offset, offset + params.limit);
    const next = offset + page.length;
    return {
      data: {
        documents: page.map((documentId) => this.#summary(state, documentId)),
        totalDocuments: state.openOrder.length,
        nextCursor:
          next < state.openOrder.length
            ? this.#cursors.encode({
                op: 'list',
                offset: next,
                catalogVersion: state.catalogVersion,
              })
            : null,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  #requireOpen(documentId: string): DocumentRecord {
    const record = this.#store.payload.documents[documentId];
    if (!record) {
      throw new VdeError('E_DOCUMENT_NOT_FOUND', 'The document was not found.', { documentId });
    }
    // A closed document is not returned by a normal read even if revisions remain (spec 4.4).
    if (!record.isOpen) {
      throw new VdeError('E_DOCUMENT_NOT_OPEN', 'The document is not open.', { documentId });
    }
    return record;
  }

  async read(rawParams: unknown): Promise<ServiceResult<ReadResult>> {
    const params = readParamsSchema.parse(rawParams);
    const state = this.#store.payload;
    const record = this.#requireOpen(params.documentId);
    const selectors = [params.outline, params.section !== undefined, params.lines !== undefined];
    if (selectors.filter(Boolean).length > 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        'Only one of --outline, --section, and --lines can be specified.',
      );
    }

    let mode: ReadResult['mode'] = params.outline
      ? 'outline'
      : params.section !== undefined
        ? 'section'
        : 'source';
    let revision = params.revision ?? record.currentRevision;
    let sectionId = params.section;
    let offset: number | null = null;
    let endByteExclusive: number | null = null;
    if (params.cursor !== undefined) {
      // A cursor is bound to the revision and read kind it was issued with. The range and revision cannot be changed later.
      if (params.revision !== undefined || selectors.some(Boolean)) {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          'A cursor cannot be combined with --revision, --outline, --section, or --lines.',
        );
      }
      const payload = this.#cursors.decode(params.cursor, 'read');
      if (payload['documentId'] !== params.documentId) {
        throw new VdeError('E_INVALID_CURSOR', 'The cursor belongs to another document.', {
          reason: 'document',
        });
      }
      mode = payload['mode'] as ReadResult['mode'];
      revision = payload['revision'] as string;
      offset = payload['offset'] as number;
      endByteExclusive = (payload['end'] as number | undefined) ?? null;
      sectionId = payload['sectionId'] as string | undefined;
    }

    // Never substitute the current revision for one that is not retained. Check every time, even when continuing with a cursor.
    const entry = this.#requireRevision(record, revision);
    if (entry.format === 'image') {
      throw new VdeError(
        'E_UNSUPPORTED_FORMAT',
        'Images have no text source, outline, or sections.',
        {
          documentId: record.documentId,
          format: 'image',
        },
      );
    }
    if (mode === 'outline') return this.#readOutline(record, entry, params.maxBytes, offset ?? 0);
    if (mode === 'section') {
      return this.#readSection(record, entry, sectionId ?? '', params.maxBytes, offset ?? 0);
    }

    const source = await this.#store.readBlob(entry.sourceSha256);
    const index = buildLineIndex(source);
    let startByte = offset;
    if (startByte === null || endByteExclusive === null) {
      if (params.lines) {
        const range = byteRangeOfLines(index, params.lines.start, params.lines.end);
        if (!range) {
          throw new VdeError('E_INVALID_ARGUMENT', 'The line range is outside the document.', {
            lines: params.lines,
            lineCount: index.lineCount,
          });
        }
        startByte = range.startByte;
        endByteExclusive = range.endByteExclusive;
      } else {
        startByte = 0;
        endByteExclusive = source.byteLength;
      }
    }

    const cut = truncateAtCodePoint(source, startByte, endByteExclusive, params.maxBytes);
    const truncated = cut < endByteExclusive;
    return {
      data: {
        documentId: record.documentId,
        revision: entry.revision,
        mode: 'source',
        content: source.subarray(startByte, cut).toString('utf8'),
        sourceRange: {
          startByte,
          endByteExclusive: cut,
          lineStart: lineOfByte(index, startByte),
          lineEnd: lineOfByte(index, Math.max(startByte, cut - 1)),
        },
        extraction: 'source',
        truncated,
        nextCursor: truncated
          ? this.#cursors.encode({
              op: 'read',
              mode: 'source',
              documentId: record.documentId,
              revision: entry.revision,
              offset: cut,
              end: endByteExclusive,
            })
          : null,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  #requireRevision(record: DocumentRecord, revision: string | null): RevisionRecord {
    const entry = record.revisions.find((candidate) => candidate.revision === revision);
    if (!revision || !entry) {
      // Never substitute the current revision for one that is not retained.
      throw new VdeError('E_REVISION_UNAVAILABLE', 'The specified revision is not retained.', {
        documentId: record.documentId,
        revision: revision ?? null,
      });
    }
    return entry;
  }

  // The outline. Items are not split; returns as many as fit the budget in the array's JSON form (spec 5.4).
  async #readOutline(
    record: DocumentRecord,
    entry: RevisionRecord,
    maxBytes: number,
    offset: number,
  ): Promise<ServiceResult<ReadResult>> {
    // Analysis uses the format the revision was created with, not the document's current format.
    const analysis = await this.#analysisOf(entry);
    const outline: OutlineItem[] = [];
    let bytes = 2;
    for (const item of analysis.outline.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (outline.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        if (outline.length === 0) {
          // Returning an empty array with a cursor would not advance. Report the required size.
          throw new VdeError(
            'E_MAX_BYTES_TOO_SMALL',
            '--max-bytes is too small to return the first outline item.',
            { requiredBytes: bytes + size },
          );
        }
        break;
      }
      outline.push(item);
      bytes += size;
    }
    const next = offset + outline.length;
    const truncated = next < analysis.outline.length;
    return {
      data: {
        documentId: record.documentId,
        revision: entry.revision,
        mode: 'outline',
        outline,
        // Source positions cannot be determined exactly, so guessed line numbers are not returned (spec 8.3).
        sourceRange: null,
        extraction: entry.format === 'markdown' ? 'markdown' : 'static-html',
        truncated,
        nextCursor: truncated
          ? this.#cursors.encode({
              op: 'read',
              mode: 'outline',
              documentId: record.documentId,
              revision: entry.revision,
              offset: next,
            })
          : null,
      },
      catalogVersion: this.#store.payload.catalogVersion,
      warnings: [],
    };
  }

  // Extracted text of one section. Returns the heading and body, not the original source.
  async #readSection(
    record: DocumentRecord,
    entry: RevisionRecord,
    sectionId: string,
    maxBytes: number,
    offset: number,
  ): Promise<ServiceResult<ReadResult>> {
    const analysis = await this.#analysisOf(entry);
    const section = analysis.sections.find((candidate) => candidate.sectionId === sectionId);
    if (!section) {
      // Section IDs are defined only within a revision. IDs from another revision cannot be used.
      throw new VdeError('E_SECTION_NOT_FOUND', 'The section was not found.', {
        documentId: record.documentId,
        revision: entry.revision,
        sectionId,
      });
    }
    const content = Buffer.from(
      [section.title, section.text].filter((part) => part !== '').join('\n\n'),
      'utf8',
    );
    const cut = truncateAtCodePoint(content, offset, content.byteLength, maxBytes);
    const truncated = cut < content.byteLength;
    return {
      data: {
        documentId: record.documentId,
        revision: entry.revision,
        mode: 'section',
        sectionId,
        content: content.subarray(offset, cut).toString('utf8'),
        sourceRange: null,
        extraction: entry.format === 'markdown' ? 'markdown' : 'static-html',
        truncated,
        nextCursor: truncated
          ? this.#cursors.encode({
              op: 'read',
              mode: 'section',
              documentId: record.documentId,
              revision: entry.revision,
              sectionId,
              offset: cut,
            })
          : null,
      },
      catalogVersion: this.#store.payload.catalogVersion,
      warnings: [],
    };
  }

  async #analysisOf(entry: RevisionRecord): Promise<DocumentAnalysis> {
    const cached = this.#analysisCache.get(entry.revision);
    if (cached) return cached.analysis;
    if (!this.#analyze) {
      throw new VdeError('E_INTERNAL', 'Document analysis is not available.');
    }
    const source = await this.#store.readBlob(entry.sourceSha256);
    const analysis = await this.#analyze(entry.format, source.toString('utf8'));
    // The result is bound only to the analyzed revision. It is never returned for another revision.
    if (!this.#analysisCache.has(entry.revision)) {
      this.#analysisCache.set(entry.revision, { analysis, bytes: entry.byteLength });
      this.#analysisCacheBytes += entry.byteLength;
    }
    while (
      this.#analysisCache.size > 1 &&
      (this.#analysisCache.size > ANALYSIS_CACHE_ENTRIES ||
        this.#analysisCacheBytes > ANALYSIS_CACHE_BYTES)
    ) {
      const oldest = this.#analysisCache.keys().next().value;
      if (oldest === undefined) break;
      this.#analysisCacheBytes -= this.#analysisCache.get(oldest)?.bytes ?? 0;
      this.#analysisCache.delete(oldest);
    }
    return analysis;
  }

  // The revision record of an open document to display. Defaults to the current revision.
  describeRevision(
    documentId: string,
    revision: string | undefined,
  ): { record: DocumentRecord; entry: RevisionRecord } {
    const record = this.#requireOpen(documentId);
    return { record, entry: this.#requireRevision(record, revision ?? record.currentRevision) };
  }

  // Opens the local document a link in the document points to (spec 10.4). Only hrefs extracted by analysis are accepted.
  // If the document is already open, only switches the view. An unregistered document is opened only with the user's confirmation.
  async openLinked(link: {
    documentId: string;
    revision: string;
    linkId: string;
    href: string;
    confirmation: string | undefined;
  }): Promise<ServiceResult<LinkOpenResult>> {
    const { documentId, href } = link;
    const record = this.#requireOpen(documentId);
    const target = classifyLink(href);
    const base =
      target.kind !== 'document'
        ? null
        : target.fromRoot || record.canonicalPath === null
          ? record.assetsRoot
          : dirname(record.canonicalPath);
    if (target.kind !== 'document' || base === null) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        'This link does not point to a document that can be opened.',
      );
    }
    const absolute = resolve(base, ...target.segments);
    const canonical = await canonicalizePath(absolute);
    // A confirmation can be used once. The given confirmation is consumed here whatever the outcome.
    const now = this.#now().getTime();
    const offered =
      link.confirmation === undefined ? undefined : this.#linkConfirmations.get(link.confirmation);
    if (link.confirmation !== undefined) this.#linkConfirmations.delete(link.confirmation);
    const existing = this.#existingFile(canonical);
    if (existing?.isOpen) {
      await this.focus({ documentId: existing.documentId });
      return {
        data: { status: 'focused', documentId: existing.documentId },
        catalogVersion: this.#store.payload.catalogVersion,
        warnings: [],
      };
    }
    // Valid only if the confirmed document, revision, link, and target all match the current resolution.
    // If the target changed after confirmation (document updated, assets-root changed), confirm again.
    const confirmed =
      offered !== undefined &&
      offered.expiresAt > now &&
      offered.documentId === documentId &&
      offered.revision === link.revision &&
      offered.linkId === link.linkId &&
      offered.canonicalPath === canonical;
    if (!confirmed) {
      // Never add a document to the list based only on a link in a document. Show the target and ask for confirmation.
      for (const [key, entry] of this.#linkConfirmations) {
        if (entry.expiresAt <= now) this.#linkConfirmations.delete(key);
      }
      while (this.#linkConfirmations.size >= MAX_LINK_CONFIRMATIONS) {
        const oldest = this.#linkConfirmations.keys().next().value;
        if (oldest === undefined) break;
        this.#linkConfirmations.delete(oldest);
      }
      const confirmation = randomBytes(16).toString('base64url');
      this.#linkConfirmations.set(confirmation, {
        documentId,
        revision: link.revision,
        linkId: link.linkId,
        canonicalPath: canonical,
        expiresAt: now + LINK_CONFIRMATION_TTL_MS,
      });
      throw new VdeError(
        'E_CONFIRMATION_REQUIRED',
        'This document is not open yet. Opening it requires confirmation.',
        // changed means the given confirmation did not hold (target changed, expired, or already used).
        { path: canonical, confirmation, changed: link.confirmation !== undefined },
      );
    }
    // Open exactly the confirmed target.
    const opened = await this.open({ cwd: dirname(canonical), paths: [canonical] });
    const openedId = opened.data.documents[0]?.documentId as string;
    await this.focus({ documentId: openedId });
    return {
      data: { status: 'opened', documentId: openedId },
      catalogVersion: this.#store.payload.catalogVersion,
      warnings: opened.warnings,
    };
  }

  // Only removes from the list; never deletes the original. Checks all targets first (spec 5.5).
  async close(rawParams: unknown): Promise<ServiceResult<CloseResult>> {
    const params = closeParamsSchema.parse(rawParams);
    if (!params.all && params.targets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', 'Specify the documents to close.');
    }
    // Paths are matched after resolving to the same canonical path as at registration.
    // Display-relative paths are not used, since they point to different files under a different cwd.
    const canonicalTargets = new Map<string, string>();
    for (const target of params.targets) {
      if (target.startsWith('doc_')) continue;
      canonicalTargets.set(target, await canonicalizePath(resolve(params.cwd, target)));
    }
    let changed = false;
    const cancelled: DocumentEvent[] = [];
    const result = await this.#store.transaction((tx) => {
      const state = tx.state;
      const timestamp = this.#now().toISOString();
      const records = params.all
        ? state.openOrder.map((documentId) => state.documents[documentId] as DocumentRecord)
        : params.targets.map((target) => this.#resolveTarget(state, target, canonicalTargets));

      const closed: string[] = [];
      const alreadyClosed: string[] = [];
      for (const record of records) {
        if (closed.includes(record.documentId) || alreadyClosed.includes(record.documentId)) {
          continue;
        }
        if (!record.isOpen) {
          alreadyClosed.push(record.documentId);
          continue;
        }
        record.isOpen = false;
        closed.push(record.documentId);
        // A document within a watch rule's scope is not restored automatically by a rescan (spec 5.3).
        if (record.canonicalPath !== null) {
          for (const rule of state.watchRules) {
            if (
              ruleCovers(rule, record.canonicalPath) &&
              !rule.suppressedPaths.includes(record.canonicalPath)
            ) {
              rule.suppressedPaths.push(record.canonicalPath);
            }
          }
        }
      }
      // Pending questions on closed documents are cancelled in the same commit (spec 7.3). Submitted answers remain.
      for (const request of Object.values(state.feedbackRequests)) {
        if (request.status !== 'pending' || !closed.includes(request.documentId)) continue;
        request.status = 'cancelled';
        request.cancellation = { cancelledAt: timestamp, reason: 'document_closed' };
        request.updatedAt = timestamp;
        cancelled.push({
          type: 'feedback-changed',
          requestId: request.requestId,
          documentId: request.documentId,
          status: 'cancelled',
        });
      }
      if (closed.length > 0) {
        state.openOrder = state.openOrder.filter((documentId) => !closed.includes(documentId));
        if (state.activeDocumentId !== null && closed.includes(state.activeDocumentId)) {
          state.activeDocumentId = state.openOrder[0] ?? null;
        }
        state.catalogVersion += 1;
        changed = true;
      }
      // --all also removes all watch rules.
      if (params.all) state.watchRules = [];
      return {
        data: { closed, alreadyClosed },
        catalogVersion: state.catalogVersion,
        warnings: [],
      };
    });
    // Keeps work started before the close (such as issuing render grants) from applying to the document after the close.
    for (const documentId of result.data.closed) {
      this.#openEpochs.set(documentId, this.openEpoch(documentId) + 1);
    }
    this.#repositories.forget(result.data.closed);
    if (changed) this.#emit({ type: 'catalog-changed' });
    for (const event of cancelled) this.#emit(event);
    return result;
  }

  #resolveTarget(
    state: StatePayload,
    target: string,
    canonicalTargets: Map<string, string>,
  ): DocumentRecord {
    const byId = state.documents[target];
    if (byId) return byId;
    const canonicalPath = canonicalTargets.get(target);
    if (canonicalPath !== undefined) {
      const byPath = Object.values(state.documents).find(
        (record) => record.sourceKind === 'file' && record.canonicalPath === canonicalPath,
      );
      if (byPath) return byPath;
    }
    throw new VdeError('E_DOCUMENT_NOT_FOUND', 'The document was not found.', { target });
  }

  // Saves the display order. Files are not moved (spec 13.1).
  async reorder(rawParams: unknown): Promise<ServiceResult<ListResult>> {
    const params = reorderParamsSchema.parse(rawParams);
    const changed = await this.#store.transaction((tx) => {
      const state = tx.state;
      if (state.catalogVersion !== params.expectedCatalogVersion) {
        throw new VdeError('E_CATALOG_CONFLICT', 'The list has changed. Fetch it again.', {
          catalogVersion: state.catalogVersion,
        });
      }
      const current = new Set(state.openOrder);
      const requested = new Set(params.order);
      const sameSet =
        params.order.length === state.openOrder.length &&
        requested.size === params.order.length &&
        [...current].every((documentId) => requested.has(documentId));
      if (!sameSet) {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          'The order must list the ID of every open document exactly once.',
        );
      }
      if (params.order.every((documentId, index) => state.openOrder[index] === documentId)) {
        return false;
      }
      state.openOrder = [...params.order];
      state.catalogVersion += 1;
      return true;
    });
    if (changed) this.#emit({ type: 'catalog-changed' });
    return this.list({ limit: LIMITS.listLimitMax });
  }

  // When only a question is given, creates a document whose content is the question's title and instructions (spec 11.1).
  // Created inside the caller's transaction, in the same commit as the question. The caller emits the document notification.
  createGenerated(tx: Transaction, input: { title: string; text: string }): string {
    const outcome = this.#upsert(
      tx,
      {
        sourceKind: 'generated',
        canonicalPath: null,
        displayPath: null,
        pathSegments: [],
        format: 'markdown',
        bytes: Buffer.from(input.text, 'utf8'),
        text: input.text,
        fallbackTitle: input.title,
        signature: null,
        assetsRoot: null,
        extraAssets: [],
        documentLogicalPath: 'index.md',
        assets: [],
        trackedFiles: [],
        assetScanFailed: false,
      },
      { title: input.title, reopen: true },
    );
    assertOpenLimits(tx.state);
    tx.state.catalogVersion += 1;
    tx.state.activeDocumentId ??= outcome.documentId;
    return outcome.documentId;
  }

  // Notification of an explicit UI selection. The document is not re-registered (spec 5.5).
  async focus(rawParams: unknown): Promise<ServiceResult<{ documentId: string }>> {
    const documentId = documentIdSchema.parse((rawParams as { documentId?: unknown }).documentId);
    this.#requireOpen(documentId);
    const catalogVersion = await this.#store.transaction((tx) => {
      tx.state.activeDocumentId = documentId;
      return tx.state.catalogVersion;
    });
    this.#emit({ type: 'focus-requested', documentId });
    return { data: { documentId }, catalogVersion, warnings: [] };
  }

  // Re-reads files. Without a target, all open file documents.
  async refresh(rawParams: unknown): Promise<ServiceResult<RefreshResult>> {
    const raw = (rawParams as { documentId?: unknown }).documentId;
    const targets =
      raw === undefined
        ? this.#store.payload.openOrder
        : [this.#requireOpen(documentIdSchema.parse(raw)).documentId];
    const changed: string[] = [];
    for (const documentId of targets) {
      if ((await this.refreshFromDisk(documentId)).changed) changed.push(documentId);
    }
    // Only an explicit refresh detects repositories again (not the automatic reload on a file change).
    await this.#redetect(targets);
    const state = this.#store.payload;
    return {
      data: {
        documents: targets.flatMap((documentId) => {
          const record = state.documents[documentId];
          return record?.isOpen ? [this.#summary(state, documentId)] : [];
        }),
        changed,
      },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  // Reads the current content of an open file document and publishes it as a new revision if changed.
  // If it became unreadable, only the status is updated; old content is never treated as new.
  async refreshFromDisk(documentId: string): Promise<RefreshOutcome> {
    const before = this.#store.payload.documents[documentId];
    if (!before?.isOpen || before.sourceKind !== 'file' || before.canonicalPath === null) {
      return { changed: false, signature: null };
    }
    const canonicalPath = before.canonicalPath;
    return this.#withPathLocks([canonicalPath], () =>
      this.#refreshLocked(documentId, canonicalPath),
    );
  }

  async #refreshLocked(documentId: string, canonicalPath: string): Promise<RefreshOutcome> {
    let loaded: LoadedSource | null = null;
    let failure: SourceState = 'error';
    const deadline = Date.now() + MISSING_RETRY_MS;
    for (;;) {
      try {
        const format = this.#store.payload.documents[documentId]?.format;
        if (format === undefined) return { changed: false, signature: null };
        loaded = await this.#readSource(canonicalPath, format);
        break;
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        if (error.code === 'E_PATH_NOT_FOUND') {
          // It may be missing only temporarily during a save. Wait a little and read again.
          failure = 'missing';
          if (Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, MISSING_RETRY_INTERVAL_MS));
            continue;
          }
        } else {
          failure = error.details['reason'] === 'permission-denied' ? 'unreadable' : 'error';
        }
        break;
      }
    }

    // Referenced files are re-read too. Even with the same content, changed assets make a new revision.
    let item: Incoming | null = null;
    const current = this.#store.payload.documents[documentId];
    if (loaded && current && loaded.canonicalPath === canonicalPath) {
      try {
        item = await this.#withAssets(
          {
            sourceKind: 'file',
            canonicalPath: loaded.canonicalPath,
            displayPath: current.displayPath,
            pathSegments: current.pathSegments,
            format: current.format,
            bytes: loaded.bytes,
            text: loaded.text,
            fallbackTitle: basename(loaded.canonicalPath),
            signature: loaded.signature,
          },
          current,
          INHERITED_ASSETS,
        );
      } catch (error) {
        // E.g. assets exceeded a limit. Truncated content is not published as a new revision.
        if (!(error instanceof VdeError)) throw error;
        failure = 'error';
      }
      // The references could not be scanned. If a revision with fully scanned assets exists, keep that revision, its assets,
      // and tracked files, and set only the status to error. A file change or a manual refresh scans again.
      if (item?.assetScanFailed && this.#hasCompleteAssets(current)) {
        item = null;
        failure = 'error';
      }
    }
    const read = item;

    const events: DocumentEvent[] = [];
    const applied = await this.#store.transaction((tx) => {
      const state = tx.state;
      const record = state.documents[documentId];
      // If closed while reading, do nothing.
      if (!record?.isOpen) return false;
      if (!read || read.canonicalPath !== record.canonicalPath) {
        if (record.sourceState !== failure) {
          record.sourceState = failure;
          record.updatedAt = this.#now().toISOString();
          state.catalogVersion += 1;
          events.push({ type: 'document-status', documentId, revision: record.currentRevision });
        }
        return true;
      }
      const outcome = this.#upsert(tx, read, { reopen: false });
      if (outcome.outcome !== 'updated') return true;
      assertOpenLimits(state);
      state.catalogVersion += 1;
      events.push({
        type: outcome.revisionChanged ? 'document-changed' : 'document-status',
        documentId,
        revision: record.currentRevision,
      });
      return true;
    });
    if (!applied) return { changed: false, signature: null };
    // The content read was published (or the read failure was recorded). Remember the matching file state.
    // If it could not be read, keep tracking the files tracked so far.
    if (read) this.#record(read);
    else {
      const files = this.#signatures.get(canonicalPath)?.files ?? [];
      this.#signatures.set(canonicalPath, { signature: null, files });
    }
    for (const event of events) this.#emit(event);
    return { changed: events.length > 0, signature: read?.signature ?? null };
  }

  // Scans a watch rule's targets and registers newly found documents.
  // Closed documents (suppressedPaths) and already open documents are skipped.
  async reconcileWatchRule(watchId: string): Promise<string[]> {
    const before = this.#store.payload;
    const rule = before.watchRules.find((candidate) => candidate.watchId === watchId);
    if (!rule) return [];
    const openPaths = new Set(
      Object.values(before.documents)
        .filter((record) => record.isOpen && record.canonicalPath !== null)
        .map((record) => record.canonicalPath),
    );
    // Already open and closed documents are excluded without reading their content.
    const candidates = new Map<string, DocumentFormat>();
    for (const path of await scanWatchTarget(rule)) {
      const format = formatOfPath(path);
      if (!format) continue;
      const candidatePath = await canonicalizePath(path);
      if (openPaths.has(candidatePath) || rule.suppressedPaths.includes(candidatePath)) continue;
      candidates.set(candidatePath, format);
    }
    if (candidates.size === 0) return [];
    // The count is checked before reading content. Never load more than the limit into memory.
    if (before.openOrder.length + candidates.size > LIMITS.openDocuments) {
      throw new VdeError(
        'E_LIMIT_EXCEEDED',
        'The limit on the number of open documents would be exceeded.',
        {
          limit: 'openDocuments',
          max: LIMITS.openDocuments,
          actual: before.openOrder.length + candidates.size,
        },
      );
    }

    return this.#withPathLocks(candidates.keys(), () =>
      this.#registerDiscovered(watchId, candidates),
    );
  }

  async #registerDiscovered(
    watchId: string,
    candidates: Map<string, DocumentFormat>,
  ): Promise<string[]> {
    const before = this.#store.payload;
    const rule = before.watchRules.find((candidate) => candidate.watchId === watchId);
    if (!rule) return [];
    const batch = this.#repositories.begin(candidates.keys());
    const isOpenPath = (state: StatePayload, path: string) =>
      Object.values(state.documents).some(
        (record) => record.isOpen && record.sourceKind === 'file' && record.canonicalPath === path,
      );

    // The total size, including open documents, is checked while reading.
    let totalBytes = openSourceBytes(before);
    const discovered: Incoming[] = [];
    for (const [path, format] of candidates) {
      // Documents opened or closed while waiting in the queue are not read.
      if (isOpenPath(before, path) || rule.suppressedPaths.includes(path)) continue;
      let loaded;
      try {
        loaded = await this.#readSource(path, format);
      } catch (error) {
        // A single error does not stop the whole watch. Try again on the next scan.
        if (error instanceof VdeError) continue;
        throw error;
      }
      if (loaded.canonicalPath !== path) continue;
      totalBytes += loaded.bytes.byteLength;
      if (totalBytes > LIMITS.openSourceBytes) {
        throw new VdeError(
          'E_LIMIT_EXCEEDED',
          'The total size of open documents would exceed the limit.',
          {
            limit: 'openSourceBytes',
            max: LIMITS.openSourceBytes,
          },
        );
      }
      try {
        discovered.push(
          await this.#withAssets(
            {
              sourceKind: 'file',
              canonicalPath: loaded.canonicalPath,
              // Documents found by watch are displayed relative to the rule's root.
              displayPath: displayPathOf(rule.root, loaded.canonicalPath),
              pathSegments: loaded.canonicalPath.split(sep).filter((segment) => segment !== ''),
              format,
              bytes: loaded.bytes,
              text: loaded.text,
              fallbackTitle: basename(loaded.canonicalPath),
              signature: loaded.signature,
            },
            this.#existingFile(loaded.canonicalPath),
            // The assets-root given when the rule was registered also applies to documents found later.
            rule.assetsRoot === null
              ? INHERITED_ASSETS
              : { ...INHERITED_ASSETS, root: rule.assetsRoot },
          ),
        );
      } catch (error) {
        if (error instanceof VdeError) continue;
        throw error;
      }
    }
    if (discovered.length === 0) return [];
    await this.#repositories.wait(batch);

    const appliedItems: Incoming[] = [];
    let repositories: StagedRepositories | null = null;
    const registered = await this.#store.transaction((tx) => {
      const state = tx.state;
      const current = state.watchRules.find((candidate) => candidate.watchId === watchId);
      // If the rule was removed during the scan, register nothing.
      if (!current) return [];
      const added: string[] = [];
      for (const item of discovered) {
        const path = item.canonicalPath as string;
        if (current.suppressedPaths.includes(path)) continue;
        // Only newly registered documents are handled here. Open documents are not touched.
        if (isOpenPath(state, path)) continue;
        const outcome = this.#upsert(tx, item, { reopen: true });
        appliedItems.push(item);
        if (outcome.openSetChanged) added.push(outcome.documentId);
      }
      if (added.length === 0) return [];
      assertOpenLimits(state);
      repositories = this.#repositories.stage(batch, this.#trackedFiles(state, added), {
        pendingWhenUnfinished: true,
      });
      state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      return added;
    });
    const staged = repositories as StagedRepositories | null;
    if (staged !== null) {
      this.#repositories.apply(staged);
      this.#applyWhenDone(batch, staged.unfinished);
    }
    for (const item of appliedItems) this.#record(item);
    if (registered.length > 0) this.#emit({ type: 'catalog-changed' });
    return registered;
  }

  listWatchRules(): ServiceResult<WatchListResult> {
    const state = this.#store.payload;
    return {
      data: { watchRules: structuredClone(state.watchRules) },
      catalogVersion: state.catalogVersion,
      warnings: [],
    };
  }

  // Removes only the rule. Documents opened by it are not closed (spec 5.3).
  async removeWatchRule(rawParams: unknown): Promise<ServiceResult<WatchListResult>> {
    const watchId = (rawParams as { watchId?: unknown }).watchId;
    await this.#store.transaction((tx) => {
      const index = tx.state.watchRules.findIndex((rule) => rule.watchId === watchId);
      if (index === -1) {
        throw new VdeError('E_WATCH_NOT_FOUND', 'The watch rule was not found.', {
          watchId: typeof watchId === 'string' ? watchId : null,
        });
      }
      tx.state.watchRules.splice(index, 1);
    });
    return this.listWatchRules();
  }
}
