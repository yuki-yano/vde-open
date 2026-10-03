import { randomBytes, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
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

// 変更の通知。IDと版・状態だけを運ぶ（仕様6.5）。回答の内容は含めない。
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
  // commitが成功した後にだけ呼ばれる。
  emit?: (event: DocumentEvent) => void;
  // 文書の構造を解析する。重い処理なので、daemonではworkerへ出す。
  analyze?: (format: DocumentFormat, text: string) => Promise<DocumentAnalysis>;
  // fileを読む処理を差し替える（testで、読み込みの完了順を制御するために使う）。
  readSource?: (path: string) => Promise<LoadedSource>;
  // 文書やCSSが参照するlocal fileの候補を集める。daemonではworkerへ出す。
  scan?: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
  // 一覧に出す、文書ごとの検索の状態。指定がなければ、検索の対象外として扱う。
  searchStateOf?: (documentId: string) => DocumentSummary['searchState'];
}

// fileを読み直した結果。signatureは、読み取った内容に対応するfileの状態。読めなかったらnull。
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
  // 読み取った時点の、文書と参照先のfileの状態。stdinはnull。
  signature: string | null;
  assetsRoot: string | null;
  extraAssets: string[];
  // 文書の位置（assets-rootからの相対path）。
  documentLogicalPath: string;
  assets: LoadedAsset[];
  // 文書のほかに変更を追うfile（参照しているasset、参照されているが存在しないfile）。
  trackedFiles: string[];
  // 参照の走査が、時間切れや構造の上限で終わらなかった。assetは集められていない。
  assetScanFailed: boolean;
}

// 読み込んだ文書の、assetを集める前の内容。
type IncomingSource = Omit<
  Incoming,
  | 'assetsRoot'
  | 'extraAssets'
  | 'documentLogicalPath'
  | 'assets'
  | 'trackedFiles'
  | 'assetScanFailed'
>;

// 未登録の文書を開く確認。確認した文書・版・link・行き先に結び付ける。
interface LinkConfirmation {
  documentId: string;
  revision: string;
  linkId: string;
  canonicalPath: string;
  expiresAt: number;
}

const LINK_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_LINK_CONFIRMATIONS = 256;

// assetの集め方。rootとexplicitは、利用者の指定がなければundefined（登録済みの値、または既定を使う）。
interface AssetSettings {
  root: string | undefined;
  explicit: string[] | undefined;
  // 個別に指定したassetを読めないときに、errorにするか。
  strict: boolean;
}

const INHERITED_ASSETS: AssetSettings = { root: undefined, explicit: undefined, strict: false };

interface ResolvedCandidates {
  // canonical pathごとの候補。symlink経由や重複指定は1件にまとめてある。
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
  // HTMLの表示方法の希望。指定がなければ、新しい文書はstatic、既存の文書は変えない。
  htmlMode?: HtmlMode | undefined;
  // falseなら、閉じている文書を開き直さない（監視による更新で使う）。
  reopen: boolean;
}

interface UpsertOutcome {
  documentId: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped';
  openSetChanged: boolean;
  revisionChanged: boolean;
}

// 解析結果を保持する上限。
const ANALYSIS_CACHE_ENTRIES = 32;
const ANALYSIS_CACHE_BYTES = 32 * 1024 * 1024;

// 一時的に消えているfileを待つ上限（仕様8.5）。
const MISSING_RETRY_MS = 1000;
const MISSING_RETRY_INTERVAL_MS = 100;

function profileOf(format: DocumentFormat): string {
  return format === 'markdown' ? MARKDOWN_PARSER_PROFILE : HTML_STATIC_PARSER_PROFILE;
}

export function toSummary(
  record: DocumentRecord,
  order: number,
  searchState: DocumentSummary['searchState'] = 'excluded',
  pendingRequestIds: string[] = [],
  interactiveAllowed = false,
): DocumentSummary {
  return {
    documentId: record.documentId,
    key: record.key,
    format: record.format,
    sourceKind: record.sourceKind,
    title: record.title,
    displayPath: record.displayPath,
    pathSegments: record.pathSegments,
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

// 直近2版と、5分以内に作られた版と、質問が固定している版を残す（仕様4.4、11.4）。
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

// 文書がruleの監視範囲に入るか。globは、監視の起点より下にあるかで判定する。
function ruleCovers(rule: WatchRule, canonicalPath: string): boolean {
  const base = watchBaseOf(rule);
  if (!isInside(base.directory, canonicalPath)) return false;
  return base.recursive || resolve(canonicalPath, '..') === base.directory;
}

function assetScanWarning(path: string): Warning {
  return {
    code: 'W_ASSET_SCAN_FAILED',
    message: `${path} が参照するfileを調べられませんでした。画像やCSSは登録していません。refreshで調べ直せます。`,
    details: { path },
  };
}

function assetScanError(): VdeError {
  return new VdeError(
    'E_PARSE_FAILED',
    '文書が参照するfileを調べられなかったため、更新していません。',
    { reason: 'asset-scan-failed' },
  );
}

function assertOpenLimits(state: StatePayload): void {
  if (state.openOrder.length > LIMITS.openDocuments) {
    throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
      limit: 'openDocuments',
      max: LIMITS.openDocuments,
      actual: state.openOrder.length,
    });
  }
  const sourceBytes = openSourceBytes(state);
  if (sourceBytes > LIMITS.openSourceBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
      limit: 'openSourceBytes',
      max: LIMITS.openSourceBytes,
      actual: sourceBytes,
    });
  }
}

export class DocumentService {
  readonly #store: StateStore;
  readonly #cursors: CursorCodec;
  readonly #now: () => Date;
  readonly #emit: (event: DocumentEvent) => void;
  readonly #analyze: ((format: DocumentFormat, text: string) => Promise<DocumentAnalysis>) | null;
  readonly #readSource: (path: string) => Promise<LoadedSource>;
  // revisionごとの解析結果。古い版の遅い結果を、新しい版の結果として使わないためにrevisionで引く。
  // 節の本文を含むので、件数と、元の文書の大きさの合計の両方で上限を設ける。
  readonly #analysisCache = new Map<string, { analysis: DocumentAnalysis; bytes: number }>();
  #analysisCacheBytes = 0;
  readonly #scan: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
  readonly #searchStateOf: (documentId: string) => DocumentSummary['searchState'];
  // canonical pathごとの、公開済みの内容に対応するfileの状態と、文書のほかに変更を追うfile。
  // 読めなかったときのsignatureはnull。
  readonly #signatures = new Map<string, { signature: string | null; files: string[] }>();
  // canonical pathごとの待ち行列。同じfileの「読む→公開する」を1件ずつ行う。
  readonly #pathQueues = new Map<string, Promise<void>>();
  // 文書を閉じた回数。閉じる前に始めた処理の結果を、開き直した後の文書へ結び付けないために使う。
  readonly #openEpochs = new Map<string, number>();
  // scriptを動かす表示（interactive）の実行の許可。文書IDと、許可したときの閉じた回数と、許可の世代。
  // daemonのmemoryだけに持つ（再起動・閉じる・別sourceへの置き換えで、自動では引き継がない。仕様10.2）。
  // 世代は許可するたびに新しくする。外した後に許可し直しても、前の許可で発行した表示は戻らない。
  readonly #interactive = new Map<string, { epoch: number; generation: number }>();
  #interactiveGenerations = 0;
  readonly #linkConfirmations = new Map<string, LinkConfirmation>();

  constructor(options: DocumentServiceOptions) {
    this.#store = options.store;
    this.#cursors = options.cursors;
    this.#now = options.now ?? (() => new Date());
    this.#emit = options.emit ?? (() => undefined);
    this.#analyze = options.analyze ?? null;
    this.#readSource = options.readSource ?? readSourceFile;
    this.#scan = options.scan ?? ((kind, text) => Promise.resolve(scanReferences(kind, text)));
    this.#searchStateOf = options.searchStateOf ?? (() => 'excluded');
  }

  // fileを読んでから公開するまでを、同じfileについては1件ずつ行う。
  // 並行させると、先に読んだ古い内容が後から公開され、新しい内容を上書きする。
  // 読み込みを始めた順番では新旧を決められない（先に始めた読み込みが、後から新しい内容を読むことがある）。
  // 複数のfileを扱うときは、決まった順に取得して、互いに待ち合う状態を作らない。
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

  // stateの内容に対応するfileの状態。daemonの起動後にまだ読んでいなければnull。
  readSignature(documentId: string): string | null {
    const path = this.#store.payload.documents[documentId]?.canonicalPath;
    return path ? (this.#signatures.get(path)?.signature ?? null) : null;
  }

  // 文書のほかに変更を追うfile。監視は、文書とこれらの状態を並べて、readSignatureと比べる。
  trackedFiles(documentId: string): string[] {
    const path = this.#store.payload.documents[documentId]?.canonicalPath;
    return path ? (this.#signatures.get(path)?.files ?? []) : [];
  }

  // 読み込んだ文書が参照するlocal fileを集める。
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
    // local assetを使えない文書に、個別の指定があっても登録できない。黙って無視しない。
    if (assetsRoot === null && settings.explicit !== undefined) {
      throw new VdeError('E_INVALID_ARGUMENT', '--assetには、--assets-rootの指定が必要です。', {
        assets: settings.explicit,
      });
    }
    let documentLogicalPath = source.format === 'html' ? 'index.html' : 'index.md';
    if (canonicalPath !== null && assetsRoot !== null) {
      const fromRoot = relative(assetsRoot, canonicalPath);
      if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        throw new VdeError('E_INVALID_ARGUMENT', '文書がassets-rootの中にありません。', {
          path: source.displayPath ?? canonicalPath,
          assetsRoot,
        });
      }
      documentLogicalPath = fromRoot.split(sep).join('/');
    }
    // 走査が終わらなかったことを、参照がなかったことと区別する。
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
    // 一部だけ集めたassetは使わない。集められなかった文書として扱う。
    // 追うfileと、照合に使う状態は、同じ結果から作る。食い違うと、変更がなくても読み直しが続く。
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

  // 開いている文書の現在の版が、参照を調べ終えたassetを持っているか。
  // 持っているなら、走査に失敗した結果で置き換えない（assetと、変更を追うfileを失うため）。
  #hasCompleteAssets(existing: DocumentRecord | undefined): boolean {
    if (!existing?.isOpen) return false;
    const current = existing.revisions.find((entry) => entry.revision === existing.currentRevision);
    return current?.assetScan === 'complete';
  }

  // 文書を閉じた回数。閉じる前に始めた処理が、開き直した後の文書に対して成立しないようにする。
  openEpoch(documentId: string): number {
    return this.#openEpochs.get(documentId) ?? 0;
  }

  // HTMLの文書で、scriptを動かす表示（interactive）を、このdaemonで明示的に許可済みなら、その許可の世代。
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

  // 許可を変える。許可済みのまま許可しても、世代は変えない。変わったらtrue。
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

  // 管理UIの明示的な操作で、HTMLの表示方法を変える。interactiveにするには確認が必要（仕様10.2）。
  async setHtmlMode(rawParams: unknown): Promise<ServiceResult<DocumentSummary>> {
    const params = htmlModeChangeParamsSchema.parse(rawParams);
    if (params.mode === 'interactive' && !params.confirmed) {
      throw new VdeError(
        'E_CONFIRMATION_REQUIRED',
        'scriptを動かす表示にするには、確認が必要です。',
        { documentId: params.documentId },
      );
    }
    const result = await this.#store.transaction((tx) => {
      const record = tx.state.documents[params.documentId];
      if (!record?.isOpen) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', {
          documentId: params.documentId,
        });
      }
      if (record.format !== 'html') {
        throw new VdeError('E_INVALID_ARGUMENT', '表示方法はHTMLの文書だけで選べます。', {
          documentId: params.documentId,
        });
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

  // 利用者の指定から、assetの集め方を決める。
  async #assetSettings(params: ReturnType<typeof openParamsSchema.parse>): Promise<AssetSettings> {
    let root: string | undefined;
    if (params.assetsRoot !== undefined) {
      const requested = resolve(params.cwd, params.assetsRoot);
      try {
        root = await realpath(requested);
        if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new VdeError('E_INVALID_ARGUMENT', '--assets-rootはdirectoryを指定してください。', {
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
                `${asset} はassetとして登録できません。assets-rootからの相対pathで指定してください。`,
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

  // 全候補を先に検査し、1件でも問題があれば何も登録しない（仕様5.2）。
  async open(rawParams: unknown): Promise<ServiceResult<OpenResult>> {
    const params = openParamsSchema.parse(rawParams);
    const warnings: Warning[] = [];

    if (params.stdin) {
      if (params.paths.length > 0) {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinとpathは同時に指定できません。');
      }
      if (params.format === 'auto') {
        throw new VdeError('E_INVALID_ARGUMENT', 'stdinから開くときは--formatが必要です。');
      }
      if (params.watch) {
        throw new VdeError('E_INVALID_ARGUMENT', '--watchはdirectoryかglobに対して指定します。');
      }
      if (params.htmlMode !== undefined && params.format !== 'html') {
        throw new VdeError('E_INVALID_ARGUMENT', '--html-modeはHTMLの文書に指定します。');
      }
      const { format, key } = params;
      const bytes = Buffer.from(params.stdin.content, 'utf8');
      const text = decodeSource(bytes, 'stdin');
      const settings = await this.#assetSettings(params);
      const openStdin = async (): Promise<ServiceResult<OpenResult>> => {
        // 同じkeyの文書を更新するときは、指定がなければ、登録済みのassetの設定を使う。
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
      // 同じkeyの更新は、走査から登録までを1件ずつ行う。fileの文書と同じ理由。
      // keyのない文書は、毎回新しい文書になるので、順番を待つ相手がいない。
      return key === undefined ? openStdin() : this.#withPathLocks([`stdin-key:${key}`], openStdin);
    }

    if (params.paths.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '開く文書を指定してください。');
    }
    const expansion = await expandTargets(params.cwd, params.paths, params.recursive);
    const watchTargets = params.watch ? expansion.watchTargets : [];
    if (params.watch && watchTargets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '--watchはdirectoryかglobに対して指定します。');
    }
    for (const target of expansion.emptyTargets) {
      warnings.push({
        code: 'W_NO_DOCUMENTS',
        message: `${target} に対象の文書がありません。`,
        details: { path: target },
      });
    }
    const resolved = await this.#resolveCandidates(
      expansion.candidates,
      params.format === 'auto' ? null : params.format,
    );
    const settings = await this.#assetSettings(params);
    if (settings.explicit !== undefined && resolved.unique.size !== 1) {
      throw new VdeError('E_INVALID_ARGUMENT', '--assetは、文書を1件だけ開くときに指定できます。', {
        documents: resolved.unique.size,
      });
    }
    if (
      params.htmlMode !== undefined &&
      ![...resolved.unique.values()].some((entry) => entry.format === 'html')
    ) {
      throw new VdeError('E_INVALID_ARGUMENT', '--html-modeはHTMLの文書に指定します。');
    }
    return this.#withPathLocks(resolved.unique.keys(), async () => {
      const incoming = await this.#readCandidates(resolved, settings, warnings);
      // --watchなら、いま対象がなくても、ruleだけを登録できる。
      if (incoming.length === 0 && watchTargets.length === 0) {
        throw new VdeError('E_PATH_NOT_FOUND', '対象の文書がありません。', {
          paths: params.paths,
        });
      }
      return this.#commitOpen(params, incoming, watchTargets, settings, warnings);
    });
  }

  async #commitOpen(
    params: ReturnType<typeof openParamsSchema.parse>,
    incoming: Incoming[],
    watchTargets: Awaited<ReturnType<typeof expandTargets>>['watchTargets'],
    settings: AssetSettings,
    warnings: Warning[],
  ): Promise<ServiceResult<OpenResult>> {
    if ((params.title !== undefined || params.key !== undefined) && incoming.length !== 1) {
      throw new VdeError(
        'E_INVALID_ARGUMENT',
        '--titleと--keyは、文書を1件だけ開くときに指定できます。',
        { documents: incoming.length },
      );
    }

    const events: DocumentEvent[] = [];
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
        // titleや状態だけの変更も通知する。UIは通知を契機に一覧を取り直す。
        if (outcome.outcome === 'updated') {
          events.push({
            type: outcome.revisionChanged ? 'document-changed' : 'document-status',
            documentId: outcome.documentId,
            revision: state.documents[outcome.documentId]?.currentRevision ?? null,
          });
        }
        // 明示的に開いた文書は、監視ruleでの「閉じたので復帰させない」扱いを解除する。
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
          // 同じ対象を、assets-rootを指定して登録し直した。後から見つける文書にも、新しい指定を使う。
          rule.assetsRoot = settings.root;
        }
        rules.push(rule);
      }

      assertOpenLimits(state);
      if (created + updated > 0) state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      if (openSetChanged) events.unshift({ type: 'catalog-changed' });

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
    for (const item of incoming) this.#record(item);
    // scriptの実行の許可は、commitの後にだけ変える。明示的なinteractiveの指定で許可し、
    // staticの指定と、stdinの更新（別の内容への置き換え）では外す。同じfileの開き直しでは保つ。
    const permissionChanged: string[] = [];
    result.data.documents.forEach((summary, index) => {
      const item = incoming[index];
      if (summary.format !== 'html' || !item) return;
      let changed = false;
      // stdinの更新は、別の内容への置き換え。前の許可は外し、明示的な指定があれば許可し直す。
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

  // 形式の検査は全候補に対して行い、本文の読み込みは重複を除いてから行う。
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
      // symlink経由や重複指定は、同じcanonical fileの1件として数える。
      const canonicalPath = await canonicalizePath(candidate.absolutePath);
      const first = unique.get(canonicalPath);
      // 同じfileが直接の指定と列挙の両方に含まれるときは、直接の指定を優先する。
      if (!first || (candidate.explicit && !first.candidate.explicit)) {
        unique.set(canonicalPath, { candidate, format });
      }
    }
    if (unique.size > LIMITS.openDocuments) {
      throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
        limit: 'openDocuments',
        max: LIMITS.openDocuments,
        actual: unique.size,
      });
    }
    return { unique, problems };
  }

  // 候補の本文を読む。呼び出し側が、対象のfileの待ち行列を取得してから呼ぶ。
  async #readCandidates(
    resolved: ResolvedCandidates,
    settings: AssetSettings,
    warnings: Warning[],
  ): Promise<Incoming[]> {
    const problems = [...resolved.problems];
    // 合計の大きさは読み込みながら確かめる。上限を超える量をmemoryへ載せない。
    const incoming: Incoming[] = [];
    let loadedBytes = 0;
    for (const [canonicalPath, { candidate, format }] of resolved.unique) {
      let loaded;
      try {
        loaded = await this.#readSource(candidate.absolutePath);
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        problems.push({
          path: candidate.displayPath,
          code: error.code,
          reason: String(error.details['reason'] ?? error.details['limit'] ?? 'unreadable'),
        });
        continue;
      }
      // 待ち行列を取得した後に、指定が別のfileを指すようになった。順序を保証できないので登録しない。
      if (loaded.canonicalPath !== canonicalPath) {
        problems.push({ path: candidate.displayPath, code: 'E_IO', reason: 'changed-during-read' });
        continue;
      }
      loadedBytes += loaded.bytes.byteLength;
      if (loadedBytes > LIMITS.openSourceBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
          limit: 'openSourceBytes',
          max: LIMITS.openSourceBytes,
        });
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
          // 調べ終えたassetを持つ文書を、調べられなかった結果で置き換えない。
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
        `${String(problems.length)}件の文書を開けないため、どの文書も登録していません。`,
        { problems },
      );
    }
    return incoming;
  }

  // 読み込んだ内容をstateへ反映する。同じ内容なら版を増やさない。
  #upsert(tx: Transaction, item: Incoming, options: UpsertOptions): UpsertOutcome {
    const state = tx.state;
    const now = this.#now();
    const timestamp = now.toISOString();
    const existing = this.#findExisting(state, item, options.key);
    if (options.key !== undefined) {
      const holder = Object.values(state.documents).find((record) => record.key === options.key);
      if (holder && holder.documentId !== existing?.documentId) {
        throw new VdeError('E_KEY_CONFLICT', 'そのkeyは別の文書が使っています。', {
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
    // 登録の時点の状態で確かめる。調べ終えたassetを持つ文書を、調べられなかった結果で置き換えない。
    if (item.assetScanFailed && this.#hasCompleteAssets(existing)) throw assetScanError();

    const sourceSha256 = tx.putBlob(item.bytes);
    const assets = item.assets.map((asset) => ({
      logicalPath: asset.logicalPath,
      mime: asset.mime,
      role: asset.role,
      sha256: tx.putBlob(asset.bytes),
      byteLength: asset.bytes.byteLength,
    }));
    // 参照しているfileの内容が変われば、本文が同じでも別の版になる（仕様4.1）。
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
    const title = options.title ?? extractTitle(item.text, item.format) ?? item.fallbackTitle;
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
      // 版が同じでも、参照を調べ終えたかどうかは変わりうる（参照のない文書）。
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

  // 一覧に出す文書の情報。順番、検索の状態、回答待ちの質問を含める。
  #summary(state: StatePayload, documentId: string): DocumentSummary {
    return toSummary(
      state.documents[documentId] as DocumentRecord,
      state.openOrder.indexOf(documentId),
      this.#searchStateOf(documentId),
      pendingRequestIdsOf(state, documentId),
      this.interactiveAllowed(documentId),
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
    // keyのないstdinは、呼び出しごとに新しい文書になる。
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
        throw new VdeError('E_CURSOR_STALE', '一覧が変わりました。最初から取得し直してください。', {
          catalogVersion: state.catalogVersion,
        });
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
      throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { documentId });
    }
    // 版が残っていても、閉じた文書は通常のreadで返さない（仕様4.4）。
    if (!record.isOpen) {
      throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', { documentId });
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
        '--outline、--section、--linesは、どれか1つだけ指定できます。',
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
      // cursorは、発行したときの版と取得の種類に固定される。範囲や版を、後から変えられない。
      if (params.revision !== undefined || selectors.some(Boolean)) {
        throw new VdeError(
          'E_INVALID_ARGUMENT',
          'cursorと、--revision・--outline・--section・--linesは併用できません。',
        );
      }
      const payload = this.#cursors.decode(params.cursor, 'read');
      if (payload['documentId'] !== params.documentId) {
        throw new VdeError('E_INVALID_CURSOR', 'cursorが別の文書のものです。', {
          reason: 'document',
        });
      }
      mode = payload['mode'] as ReadResult['mode'];
      revision = payload['revision'] as string;
      offset = payload['offset'] as number;
      endByteExclusive = (payload['end'] as number | undefined) ?? null;
      sectionId = payload['sectionId'] as string | undefined;
    }

    // 保持していない版を、現在の版で代用しない。cursorでの続きでも、そのたびに確かめる。
    const entry = this.#requireRevision(record, revision);
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
          throw new VdeError('E_INVALID_ARGUMENT', '行範囲が文書の範囲外です。', {
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
      // 保持していない版を、現在の版で代用しない。
      throw new VdeError('E_REVISION_UNAVAILABLE', '指定した版は保持されていません。', {
        documentId: record.documentId,
        revision: revision ?? null,
      });
    }
    return entry;
  }

  // 見出しの一覧。要素は分割せず、配列のJSON表現が予算に収まるところまで返す（仕様5.4）。
  async #readOutline(
    record: DocumentRecord,
    entry: RevisionRecord,
    maxBytes: number,
    offset: number,
  ): Promise<ServiceResult<ReadResult>> {
    // 解析の条件は、版を作ったときの形式で決める。文書の現在の形式では決めない。
    const analysis = await this.#analysisOf(entry);
    const outline: OutlineItem[] = [];
    let bytes = 2;
    for (const item of analysis.outline.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (outline.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        if (outline.length === 0) {
          // 空の配列と続きのcursorを返すと、位置が進まない。必要な大きさを伝える。
          throw new VdeError(
            'E_MAX_BYTES_TOO_SMALL',
            '--max-bytesが小さく、1件目の見出しを返せません。',
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
        // 原文の位置を正確に得られないので、推測した行番号は返さない（仕様8.3）。
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

  // 1つの節の、抽出した本文。見出しと本文を返す。原文そのものではない。
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
      // 節のIDは、版の中でだけ決まる。別の版のIDは使えない。
      throw new VdeError('E_SECTION_NOT_FOUND', '節が見つかりません。', {
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
      throw new VdeError('E_INTERNAL', '文書の解析が利用できません。');
    }
    const source = await this.#store.readBlob(entry.sourceSha256);
    const analysis = await this.#analyze(entry.format, source.toString('utf8'));
    // 結果は解析した版にだけ結び付ける。別の版の結果として返ることはない。
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

  // 開いている文書の、表示する版の記録。指定がなければ現在の版。
  describeRevision(
    documentId: string,
    revision: string | undefined,
  ): { record: DocumentRecord; entry: RevisionRecord } {
    const record = this.#requireOpen(documentId);
    return { record, entry: this.#requireRevision(record, revision ?? record.currentRevision) };
  }

  // 文書中のlinkが指すlocalの文書を開く（仕様10.4）。hrefは、解析で取り出したものだけを受け取る。
  // すでに開いている文書なら、表示を切り替えるだけ。未登録の文書は、利用者の確認があるときだけ開く。
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
      throw new VdeError('E_INVALID_ARGUMENT', 'このlinkは、開ける文書を指していません。');
    }
    const absolute = resolve(base, ...target.segments);
    const canonical = await canonicalizePath(absolute);
    // 確認は1回だけ使える。渡された確認は、どの結果になっても、ここで使い終える。
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
    // 確認した文書・版・link・行き先のすべてが、いまの解決結果と同じときだけ有効。
    // 確認の後で文書が更新されたり、assets-rootが変わったりして行き先が変わっていたら、確認し直す。
    const confirmed =
      offered !== undefined &&
      offered.expiresAt > now &&
      offered.documentId === documentId &&
      offered.revision === link.revision &&
      offered.linkId === link.linkId &&
      offered.canonicalPath === canonical;
    if (!confirmed) {
      // 文書に書かれたlinkだけを根拠に、一覧へ文書を増やさない。開く対象を示して、確認を求める。
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
        'この文書はまだ開かれていません。開くには確認が必要です。',
        // changedは、渡された確認が成立しなかったこと（行き先が変わった、期限が切れた、使用済み）を示す。
        { path: canonical, confirmation, changed: link.confirmation !== undefined },
      );
    }
    // 開くのは、確認した行き先そのもの。
    const opened = await this.open({ cwd: dirname(canonical), paths: [canonical] });
    const openedId = opened.data.documents[0]?.documentId as string;
    await this.focus({ documentId: openedId });
    return {
      data: { status: 'opened', documentId: openedId },
      catalogVersion: this.#store.payload.catalogVersion,
      warnings: opened.warnings,
    };
  }

  // 一覧から外すだけで、原本は削除しない。全対象を先に検査する（仕様5.5）。
  async close(rawParams: unknown): Promise<ServiceResult<CloseResult>> {
    const params = closeParamsSchema.parse(rawParams);
    if (!params.all && params.targets.length === 0) {
      throw new VdeError('E_INVALID_ARGUMENT', '閉じる文書を指定してください。');
    }
    // pathの指定は、登録時と同じcanonical pathへ直して照合する。
    // 表示用の相対pathは、cwdが違うと別のfileを指すので使わない。
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
        // 監視ruleの範囲にある文書は、再走査で勝手に復帰させない（仕様5.3）。
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
      // 閉じた文書の回答待ちの質問は、同じcommitで中止にする（仕様7.3）。送信済みの回答は残す。
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
      // --allは、すべての監視ruleも解除する。
      if (params.all) state.watchRules = [];
      return {
        data: { closed, alreadyClosed },
        catalogVersion: state.catalogVersion,
        warnings: [],
      };
    });
    // 閉じる前に始まっていた処理（表示の権限の発行など）が、閉じた後の文書に対して成立しないようにする。
    for (const documentId of result.data.closed) {
      this.#openEpochs.set(documentId, this.openEpoch(documentId) + 1);
    }
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
    throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { target });
  }

  // 表示順を保存する。fileの場所は動かさない（仕様13.1）。
  async reorder(rawParams: unknown): Promise<ServiceResult<ListResult>> {
    const params = reorderParamsSchema.parse(rawParams);
    const changed = await this.#store.transaction((tx) => {
      const state = tx.state;
      if (state.catalogVersion !== params.expectedCatalogVersion) {
        throw new VdeError('E_CATALOG_CONFLICT', '一覧が変わりました。取得し直してください。', {
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
          '並び順には、開いている全文書のIDを1回ずつ指定してください。',
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

  // 質問だけを渡されたときに、質問のtitleと説明を内容とする文書を作る（仕様11.1）。
  // 呼び出し側のtransactionの中で作り、同じcommitで質問を作る。文書の通知は呼び出し側が出す。
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

  // 明示的なUI選択の通知。文書は再登録しない（仕様5.5）。
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

  // fileを読み直す。指定がなければ、開いているfile文書のすべて。
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

  // 開いているfile文書の現在の内容を読み、変わっていれば新しい版として公開する。
  // 読めなくなっていれば状態だけを更新し、古い内容を新しい内容として扱わない。
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
        loaded = await this.#readSource(canonicalPath);
        break;
      } catch (error) {
        if (!(error instanceof VdeError)) throw error;
        if (error.code === 'E_PATH_NOT_FOUND') {
          // 保存の途中で一時的に消えているだけかもしれない。少し待って読み直す。
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

    // 参照しているfileも読み直す。本文が同じでも、assetが変われば新しい版になる。
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
        // assetが上限を超えたなど。切り捨てた内容を、新しい版として公開しない。
        if (!(error instanceof VdeError)) throw error;
        failure = 'error';
      }
      // 参照を調べられなかった。調べ終えたassetを持つ版があるなら、その版・asset・追っているfileを保ち、
      // 状態だけをerrorにする。fileが変わるか、手動で読み直すと、もう一度調べる。
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
      // 読んでいる間に閉じられていたら、何もしない。
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
    // 読み取った内容を公開した（または、読めないことを記録した）。対応するfileの状態を覚える。
    // 読めなかったときは、それまで追っていたfileを引き続き追う。
    if (read) this.#record(read);
    else {
      const files = this.#signatures.get(canonicalPath)?.files ?? [];
      this.#signatures.set(canonicalPath, { signature: null, files });
    }
    for (const event of events) this.#emit(event);
    return { changed: events.length > 0, signature: read?.signature ?? null };
  }

  // 監視ruleの対象を走査し、新しく現れた文書を登録する。
  // 閉じた文書（suppressedPaths）と、すでに開いている文書は対象にしない。
  async reconcileWatchRule(watchId: string): Promise<string[]> {
    const before = this.#store.payload;
    const rule = before.watchRules.find((candidate) => candidate.watchId === watchId);
    if (!rule) return [];
    const openPaths = new Set(
      Object.values(before.documents)
        .filter((record) => record.isOpen && record.canonicalPath !== null)
        .map((record) => record.canonicalPath),
    );
    // すでに開いている文書と、閉じた文書は、本文を読まずに除く。
    const candidates = new Map<string, DocumentFormat>();
    for (const path of await scanWatchTarget(rule)) {
      const format = formatOfPath(path);
      if (!format) continue;
      const candidatePath = await canonicalizePath(path);
      if (openPaths.has(candidatePath) || rule.suppressedPaths.includes(candidatePath)) continue;
      candidates.set(candidatePath, format);
    }
    if (candidates.size === 0) return [];
    // 件数は本文を読む前に確かめる。上限を超える量をmemoryへ載せない。
    if (before.openOrder.length + candidates.size > LIMITS.openDocuments) {
      throw new VdeError('E_LIMIT_EXCEEDED', '開ける文書数の上限を超えます。', {
        limit: 'openDocuments',
        max: LIMITS.openDocuments,
        actual: before.openOrder.length + candidates.size,
      });
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
    const isOpenPath = (state: StatePayload, path: string) =>
      Object.values(state.documents).some(
        (record) => record.isOpen && record.sourceKind === 'file' && record.canonicalPath === path,
      );

    // 合計の大きさは、開いている文書の分も含めて、読み込みながら確かめる。
    let totalBytes = openSourceBytes(before);
    const discovered: Incoming[] = [];
    for (const [path, format] of candidates) {
      // 順番を待っている間に開かれた文書と、閉じられた文書は読まない。
      if (isOpenPath(before, path) || rule.suppressedPaths.includes(path)) continue;
      let loaded;
      try {
        loaded = await this.#readSource(path);
      } catch (error) {
        // 個別のerrorで監視全体を止めない。次の走査でもう一度試す。
        if (error instanceof VdeError) continue;
        throw error;
      }
      if (loaded.canonicalPath !== path) continue;
      totalBytes += loaded.bytes.byteLength;
      if (totalBytes > LIMITS.openSourceBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', '開いている文書の合計の大きさが上限を超えます。', {
          limit: 'openSourceBytes',
          max: LIMITS.openSourceBytes,
        });
      }
      try {
        discovered.push(
          await this.#withAssets(
            {
              sourceKind: 'file',
              canonicalPath: loaded.canonicalPath,
              // 監視で見つけた文書は、ruleの起点からの相対pathで表示する。
              displayPath: displayPathOf(rule.root, loaded.canonicalPath),
              pathSegments: loaded.canonicalPath.split(sep).filter((segment) => segment !== ''),
              format,
              bytes: loaded.bytes,
              text: loaded.text,
              fallbackTitle: basename(loaded.canonicalPath),
              signature: loaded.signature,
            },
            this.#existingFile(loaded.canonicalPath),
            // ruleの登録時に指定されたassets-rootを、後から見つけた文書にも使う。
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

    const appliedItems: Incoming[] = [];
    const registered = await this.#store.transaction((tx) => {
      const state = tx.state;
      const current = state.watchRules.find((candidate) => candidate.watchId === watchId);
      // 走査の間にruleが外されていたら、登録しない。
      if (!current) return [];
      const added: string[] = [];
      for (const item of discovered) {
        const path = item.canonicalPath as string;
        if (current.suppressedPaths.includes(path)) continue;
        // ここで扱うのは、新しく登録する文書だけ。開いている文書には触れない。
        if (isOpenPath(state, path)) continue;
        const outcome = this.#upsert(tx, item, { reopen: true });
        appliedItems.push(item);
        if (outcome.openSetChanged) added.push(outcome.documentId);
      }
      if (added.length === 0) return [];
      assertOpenLimits(state);
      state.catalogVersion += 1;
      if (state.activeDocumentId === null) state.activeDocumentId = state.openOrder[0] ?? null;
      return added;
    });
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

  // ruleだけを外す。そのruleで開いた文書は閉じない（仕様5.3）。
  async removeWatchRule(rawParams: unknown): Promise<ServiceResult<WatchListResult>> {
    const watchId = (rawParams as { watchId?: unknown }).watchId;
    await this.#store.transaction((tx) => {
      const index = tx.state.watchRules.findIndex((rule) => rule.watchId === watchId);
      if (index === -1) {
        throw new VdeError('E_WATCH_NOT_FOUND', '監視ruleが見つかりません。', {
          watchId: typeof watchId === 'string' ? watchId : null,
        });
      }
      tx.state.watchRules.splice(index, 1);
    });
    return this.listWatchRules();
  }
}
