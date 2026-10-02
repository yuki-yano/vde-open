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

// 仕様9.5。sectionの取得はP4で足す。
export const readResultSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  mode: z.enum(['source', 'outline']),
  content: z.string().optional(),
  outline: z.array(outlineItemSchema).optional(),
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
