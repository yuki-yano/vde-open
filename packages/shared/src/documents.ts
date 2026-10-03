import { z } from 'zod';

import { LIMITS } from './limits.ts';

export const documentIdSchema = z.string().regex(/^doc_[0-9a-f-]{36}$/);
export const revisionSchema = z.string().regex(/^rev_[0-9a-f]{64}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const documentFormatSchema = z.enum(['markdown', 'html']);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;

export const sourceKindSchema = z.enum(['file', 'stdin', 'generated']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceStateSchema = z.enum(['ready', 'missing', 'unreadable', 'updating', 'error']);
export type SourceState = z.infer<typeof sourceStateSchema>;

export const searchStateSchema = z.enum(['ready', 'indexing', 'excluded']);

// HTMLの表示方法。interactive（scriptを許可する表示）はP6で足す。
export const htmlModeSchema = z.enum(['static']);
export type HtmlMode = z.infer<typeof htmlModeSchema>;

// 文書が参照するlocal fileの種別。配信時のheaderと、使える文脈を決める。
export const assetRoleSchema = z.enum(['image', 'svg', 'style', 'font', 'script', 'data']);
export type AssetRole = z.infer<typeof assetRoleSchema>;

// 版に含まれるasset。logicalPathは、assets-rootからの相対path（区切りは`/`）。
export const assetRecordSchema = z.strictObject({
  logicalPath: z.string().min(1),
  mime: z.string().min(1),
  role: assetRoleSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;

// 仕様4.2。本文や回答は含めない。
export const documentSummarySchema = z.strictObject({
  documentId: documentIdSchema,
  key: z.string().nullable(),
  format: documentFormatSchema,
  sourceKind: sourceKindSchema,
  title: z.string(),
  displayPath: z.string().nullable(),
  pathSegments: z.array(z.string()),
  revision: revisionSchema.nullable(),
  sourceState: sourceStateSchema,
  searchState: searchStateSchema,
  openedAt: z.string(),
  updatedAt: z.string(),
  order: z.number().int().nonnegative(),
  pendingRequestIds: z.array(z.string()),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const sourceRangeSchema = z.strictObject({
  startByte: z.number().int().nonnegative(),
  endByteExclusive: z.number().int().nonnegative(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
});
export type SourceRange = z.infer<typeof sourceRangeSchema>;

const titleSchema = z.string().min(1).max(LIMITS.titleLength);
const keySchema = z.string().min(1).max(LIMITS.keyLength);

export const openParamsSchema = z.strictObject({
  cwd: z.string().min(1),
  paths: z.array(z.string().min(1)),
  stdin: z.strictObject({ content: z.string() }).optional(),
  format: z.enum(['auto', 'markdown', 'html']).default('auto'),
  title: titleSchema.optional(),
  key: keySchema.optional(),
  recursive: z.boolean().default(false),
  // directory／globに新しく現れた文書も登録する。
  watch: z.boolean().default(false),
  htmlMode: htmlModeSchema.optional(),
  // local assetを解決できる範囲の上限。指定がなければ、fileの親directory。
  assetsRoot: z.string().min(1).optional(),
  // 文書の解析では見つからないlocal assetの個別指定（assets-rootからの相対path）。
  assets: z.array(z.string().min(1)).max(LIMITS.documentAssets).default([]),
});
export type OpenParams = z.input<typeof openParamsSchema>;

export const watchRuleSchema = z.strictObject({
  watchId: z.string().regex(/^watch_[0-9a-f-]{36}$/),
  kind: z.enum(['directory', 'glob']),
  // 監視の起点になるdirectory（絶対path）。
  root: z.string(),
  // globのときの指定。directoryのときはnull。
  pattern: z.string().nullable(),
  recursive: z.boolean(),
  suppressedPaths: z.array(z.string()),
  createdAt: z.string(),
  // ruleを登録したときに指定されたassets-root（symlinkを解決済み）。後から見つけた文書にも使う。
  // 指定がなければnull（文書のあるdirectoryを使う）。
  assetsRoot: z.string().nullable(),
});
export type WatchRule = z.infer<typeof watchRuleSchema>;

export const openResultSchema = z.strictObject({
  documents: z.array(documentSummarySchema),
  watchRules: z.array(watchRuleSchema),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type OpenResult = z.infer<typeof openResultSchema>;

export const listParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(LIMITS.listLimitMax).default(LIMITS.listLimitDefault),
  cursor: z.string().min(1).optional(),
});
export type ListParams = z.input<typeof listParamsSchema>;

export const listResultSchema = z.strictObject({
  documents: z.array(documentSummarySchema),
  totalDocuments: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type ListResult = z.infer<typeof listResultSchema>;

export const readParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema.optional(),
  lines: z
    .strictObject({ start: z.number().int().positive(), end: z.number().int().positive() })
    .optional(),
  maxBytes: z
    .number()
    .int()
    .min(LIMITS.readMaxBytesMin)
    .max(LIMITS.readMaxBytesMax)
    .default(LIMITS.readMaxBytesDefault),
  cursor: z.string().min(1).optional(),
  outline: z.boolean().default(false),
  // 抽出した節の本文を取得する。outline・linesとは同時に指定できない。
  section: z
    .string()
    .regex(/^sec_\d{4,}$/)
    .optional(),
});
export type ReadParams = z.input<typeof readParamsSchema>;

export const outlineItemSchema = z.strictObject({
  sectionId: z.string().regex(/^sec_\d{4,}$/),
  level: z.number().int().min(1).max(6),
  title: z.string(),
  headingPath: z.array(z.string()),
  anchor: z.string(),
});
export type OutlineItem = z.infer<typeof outlineItemSchema>;

// 仕様9.5。
export const readResultSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  mode: z.enum(['source', 'section', 'outline']),
  content: z.string().optional(),
  outline: z.array(outlineItemSchema).optional(),
  sectionId: z.string().optional(),
  sourceRange: sourceRangeSchema.nullable(),
  extraction: z.enum(['source', 'markdown', 'static-html']),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type ReadResult = z.infer<typeof readResultSchema>;

export const closeParamsSchema = z.strictObject({
  cwd: z.string().min(1),
  targets: z.array(z.string().min(1)),
  all: z.boolean().default(false),
});
export type CloseParams = z.input<typeof closeParamsSchema>;

export const closeResultSchema = z.strictObject({
  closed: z.array(documentIdSchema),
  alreadyClosed: z.array(documentIdSchema),
});
export type CloseResult = z.infer<typeof closeResultSchema>;

export const daemonStatusSchema = z.strictObject({
  state: z.enum(['running', 'stopped']),
  daemonId: z.string().nullable(),
  pid: z.number().int().nullable(),
  version: z.string().nullable(),
  protocolVersion: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  stateRoot: z.string(),
  openDocuments: z.number().int().nonnegative().nullable(),
  catalogVersion: z.number().int().nonnegative().nullable(),
  // 管理UIのURL。認証の秘密は含まない。
  uiUrl: z.string().nullable(),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const reorderParamsSchema = z.strictObject({
  // 開いている全文書のID。重複なし。
  order: z.array(documentIdSchema),
  expectedCatalogVersion: z.number().int().nonnegative(),
});
export type ReorderParams = z.infer<typeof reorderParamsSchema>;

export const refreshResultSchema = z.strictObject({
  documents: z.array(documentSummarySchema),
  changed: z.array(documentIdSchema),
});
export type RefreshResult = z.infer<typeof refreshResultSchema>;

export const watchListResultSchema = z.strictObject({ watchRules: z.array(watchRuleSchema) });
export type WatchListResult = z.infer<typeof watchListResultSchema>;

// 更新通知（仕様6.5）。IDと版だけを運び、本文は含めない。
export const serverEventSchema = z.strictObject({
  type: z.enum([
    'hello',
    'catalog-changed',
    'document-changed',
    'document-status',
    'focus-requested',
    'daemon-stopping',
    'resync-required',
  ]),
  daemonId: z.string(),
  sequence: z.number().int().nonnegative(),
  catalogVersion: z.number().int().nonnegative(),
  documentId: documentIdSchema.optional(),
  revision: revisionSchema.nullable().optional(),
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const uiStatusSchema = z.strictObject({
  version: z.string(),
  daemonId: z.string(),
  catalogVersion: z.number().int().nonnegative(),
  activeDocumentId: documentIdSchema.nullable(),
  openDocuments: z.number().int().nonnegative(),
  // 文書を表示するlistenerのorigin。秘密は含まない。
  previewOrigin: z.string(),
});
export type UiStatus = z.infer<typeof uiStatusSchema>;

export const bootstrapResultSchema = z.strictObject({
  // 一回限りのticketをfragmentに含むURL。秘密として扱う。
  bootstrapUrl: z.string(),
  uiUrl: z.string(),
});
export type BootstrapResult = z.infer<typeof bootstrapResultSchema>;

export const sessionResultSchema = z.strictObject({
  token: z.string(),
  idleTimeoutSeconds: z.number().int().positive(),
});
export type SessionResult = z.infer<typeof sessionResultSchema>;

export const renderGrantParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  // 表示する版。指定がなければ現在の版。
  revision: revisionSchema.optional(),
  mode: htmlModeSchema.default('static'),
});
export type RenderGrantParams = z.input<typeof renderGrantParamsSchema>;

// 文書中のlink。hrefは表示用で、開く操作にはlinkIdだけを使う。
export const renderLinkSchema = z.strictObject({
  linkId: z.string().regex(/^lnk_\d{4,}$/),
  href: z.string(),
  text: z.string(),
  // external: http(s)・mailto。document: localの文書への相対link。other: 開けないlink。
  kind: z.enum(['external', 'document', 'other']),
});
export type RenderLink = z.infer<typeof renderLinkSchema>;

// 元の文書と表示が異なる理由。codeが種類、targetが対象（URLやpath）。
export const renderDiagnosticSchema = z.strictObject({
  code: z.string(),
  target: z.string().nullable(),
  count: z.number().int().positive(),
});
export type RenderDiagnostic = z.infer<typeof renderDiagnosticSchema>;

export const renderGrantResultSchema = z.strictObject({
  // 表示用URLに含まれる秘密。この文書・この版の閲覧だけに使える。
  grant: z.string(),
  documentId: documentIdSchema,
  revision: revisionSchema,
  format: documentFormatSchema,
  mode: htmlModeSchema,
  // iframeで開くURL。Markdownはnull（本体で描画し、画像だけをfilesBaseUrlから読む）。
  documentUrl: z.string().nullable(),
  // 登録済みassetの配信元。末尾は`/`。
  filesBaseUrl: z.string(),
  // 文書の位置（assets-rootからの相対path）。相対参照を解決する基準になる。
  documentLogicalPath: z.string(),
  // 配信できるassetと、その種別。
  assets: z.array(z.strictObject({ logicalPath: z.string(), role: assetRoleSchema })),
  links: z.array(renderLinkSchema),
  diagnostics: z.array(renderDiagnosticSchema),
});
export type RenderGrantResult = z.infer<typeof renderGrantResultSchema>;

export const linkOpenParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  linkId: z.string().regex(/^lnk_\d{4,}$/),
  // 未登録の文書を開く確認の識別子。確認を求める応答で受け取ったものを、そのまま送る。
  // 確認した文書・版・link・行き先に結び付いていて、1回だけ使える。
  confirmation: z.string().min(1).max(64).optional(),
});
export type LinkOpenParams = z.input<typeof linkOpenParamsSchema>;

export const linkOpenResultSchema = z.strictObject({
  // focused: すでに開いていた文書へ切り替えた。opened: 確認を経て新しく開いた。
  status: z.enum(['focused', 'opened']),
  documentId: documentIdSchema,
});
export type LinkOpenResult = z.infer<typeof linkOpenResultSchema>;

export const searchModeSchema = z.enum(['text', 'exact', 'path']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchParamsSchema = z.strictObject({
  query: z.string().min(1),
  // text: 語の一致。exact: 連続した文字列の一致だけ。path: file名とpathだけ。
  mode: searchModeSchema.default('text'),
  limit: z.number().int().min(1).max(LIMITS.searchLimitMax).default(LIMITS.searchLimitDefault),
  // 対象を絞る文書ID。指定がなければ、開いている文書のすべて。
  documents: z.array(documentIdSchema).max(LIMITS.openDocuments).default([]),
  maxBytes: z
    .number()
    .int()
    .min(LIMITS.readMaxBytesMin)
    .max(LIMITS.readMaxBytesMax)
    .default(LIMITS.readMaxBytesDefault),
  cursor: z.string().min(1).optional(),
});
export type SearchParams = z.input<typeof searchParamsSchema>;

export const searchHitSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  title: z.string(),
  displayPath: z.string().nullable(),
  sectionId: z.string(),
  headingPath: z.array(z.string()),
  // 抽出した本文の実際の抜粋。要約や言い換えではない。
  excerpt: z.string(),
  matchKind: z.enum(['path-exact', 'phrase', 'text', 'prefix', 'fuzzy']),
  // 検索engineの中での相対的な値。確率や、意味の近さの精度ではない。
  score: z.number(),
  sourceRange: sourceRangeSchema.nullable(),
  extraction: z.enum(['markdown', 'static-html']),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

// 仕様9.4。検索は、公開済みの内容に対するもの。
export const searchResultSchema = z.strictObject({
  query: z.string(),
  mode: searchModeSchema,
  catalogVersion: z.number().int().nonnegative(),
  // 開いている文書の数と、そのうち検索できた文書の数。
  registeredDocuments: z.number().int().nonnegative(),
  searchedDocuments: z.number().int().nonnegative(),
  indexedAt: z.string(),
  // 検索できなかった文書がある。全件を検索した結果ではない。
  incomplete: z.boolean(),
  failedDocuments: z.array(z.strictObject({ documentId: documentIdSchema, code: z.string() })),
  indexingDocuments: z.array(documentIdSchema),
  hits: z.array(searchHitSchema),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
