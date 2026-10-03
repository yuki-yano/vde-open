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

// How HTML is shown. static: scripts never run (default). interactive: scripts run only when explicitly allowed.
export const htmlModeSchema = z.enum(['static', 'interactive']);
export type HtmlMode = z.infer<typeof htmlModeSchema>;

// Kind of a local file the document references. Decides the headers when served and the contexts it can be used in.
export const assetRoleSchema = z.enum(['image', 'svg', 'style', 'font', 'script', 'data']);
export type AssetRole = z.infer<typeof assetRoleSchema>;

// An asset included in a revision. logicalPath is relative to the assets-root (separated by `/`).
export const assetRecordSchema = z.strictObject({
  logicalPath: z.string().min(1),
  mime: z.string().min(1),
  role: assetRoleSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;

// Spec 4.2. Contains neither document content nor answers.
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
  // Requested HTML mode. null for Markdown.
  htmlMode: htmlModeSchema.nullable(),
  // Whether interactive was requested and this daemon has allowed scripts to run. false once the permission is lost, e.g. after a restart.
  interactiveAllowed: z.boolean(),
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
  // Also register documents that newly appear in the directory or glob.
  watch: z.boolean().default(false),
  htmlMode: htmlModeSchema.optional(),
  // Upper bound of where local assets may be resolved. Defaults to the file's parent directory.
  assetsRoot: z.string().min(1).optional(),
  // Local assets that document analysis cannot find, given individually (relative to the assets-root).
  assets: z.array(z.string().min(1)).max(LIMITS.documentAssets).default([]),
});
export type OpenParams = z.input<typeof openParamsSchema>;

export const watchRuleSchema = z.strictObject({
  watchId: z.string().regex(/^watch_[0-9a-f-]{36}$/),
  kind: z.enum(['directory', 'glob']),
  // Directory the watch starts from (absolute path).
  root: z.string(),
  // The pattern for glob. null for directory.
  pattern: z.string().nullable(),
  recursive: z.boolean(),
  suppressedPaths: z.array(z.string()),
  createdAt: z.string(),
  // The assets-root given when the rule was registered (symlinks resolved). Also used for documents found later.
  // null when not given (the document's directory is used).
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
  // Read the extracted text of a section. Cannot be combined with outline or lines.
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

// Spec 9.5.
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
  // URL of the management UI. Contains no authentication secret.
  uiUrl: z.string().nullable(),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const reorderParamsSchema = z.strictObject({
  // IDs of all open documents. No duplicates.
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

// Change notifications (spec 6.5). Carry only IDs and revisions, never document content.
export const serverEventSchema = z.strictObject({
  type: z.enum([
    'hello',
    'catalog-changed',
    'document-changed',
    'document-status',
    'focus-requested',
    'daemon-stopping',
    'resync-required',
    'feedback-changed',
    'render-diagnostics',
  ]),
  daemonId: z.string(),
  sequence: z.number().int().nonnegative(),
  catalogVersion: z.number().int().nonnegative(),
  documentId: documentIdSchema.optional(),
  revision: revisionSchema.nullable().optional(),
  // A question change notification carries only the question ID and status (never the answer content).
  requestId: z.string().optional(),
  status: z.enum(['pending', 'submitted', 'cancelled']).optional(),
  draftVersion: z.number().int().nonnegative().optional(),
  acknowledged: z.boolean().optional(),
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const uiStatusSchema = z.strictObject({
  version: z.string(),
  daemonId: z.string(),
  catalogVersion: z.number().int().nonnegative(),
  activeDocumentId: documentIdSchema.nullable(),
  openDocuments: z.number().int().nonnegative(),
  // Origin of the listener that shows documents. Contains no secret.
  previewOrigin: z.string(),
});
export type UiStatus = z.infer<typeof uiStatusSchema>;

export const bootstrapResultSchema = z.strictObject({
  // URL whose fragment holds a one-time ticket. Treated as a secret.
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
  // Revision to show. Defaults to the current revision.
  revision: revisionSchema.optional(),
  mode: htmlModeSchema.default('static'),
});
export type RenderGrantParams = z.input<typeof renderGrantParamsSchema>;

// A link in the document. href is for display; opening uses only linkId.
export const renderLinkSchema = z.strictObject({
  linkId: z.string().regex(/^lnk_\d{4,}$/),
  href: z.string(),
  text: z.string(),
  // external: http(s) and mailto. document: relative link to a local document. other: a link that cannot be opened.
  kind: z.enum(['external', 'document', 'other']),
});
export type RenderLink = z.infer<typeof renderLinkSchema>;

// Why the view differs from the original document. code is the kind, target is the subject (URL or path).
export const renderDiagnosticSchema = z.strictObject({
  code: z.string(),
  target: z.string().nullable(),
  count: z.number().int().positive(),
});
export type RenderDiagnostic = z.infer<typeof renderDiagnosticSchema>;

export const renderGrantResultSchema = z.strictObject({
  // Secret included in the view URL. Usable only to view this document at this revision.
  grant: z.string(),
  documentId: documentIdSchema,
  revision: revisionSchema,
  format: documentFormatSchema,
  mode: htmlModeSchema,
  // URL to open in the iframe. null for Markdown (rendered by the host; only images are read from filesBaseUrl).
  documentUrl: z.string().nullable(),
  // Base URL that serves registered assets. Ends with `/`.
  filesBaseUrl: z.string(),
  // Location of the document (relative to the assets-root). Base for resolving relative references.
  documentLogicalPath: z.string(),
  // Assets that can be served, with their roles.
  assets: z.array(z.strictObject({ logicalPath: z.string(), role: assetRoleSchema })),
  links: z.array(renderLinkSchema),
  diagnostics: z.array(renderDiagnosticSchema),
  // Communication between the HTML and the host. Present only for views that embed the bundled SDK into the HTML. instanceId identifies this view.
  bridge: z.strictObject({ instanceId: z.string(), requestId: z.string() }).nullable(),
});
export type RenderGrantResult = z.infer<typeof renderGrantResultSchema>;

// Unregistered files the view tried to load (spec 10.3).
export const renderMissingResultSchema = z.strictObject({
  missing: z.array(z.string()),
});
export type RenderMissingResult = z.infer<typeof renderMissingResultSchema>;

// Change the HTML mode by an explicit action in the management UI. Switching to interactive requires confirmation.
export const htmlModeChangeParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  mode: htmlModeSchema,
  confirmed: z.boolean().default(false),
});
export type HtmlModeChangeParams = z.input<typeof htmlModeChangeParamsSchema>;

export const linkOpenParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  linkId: z.string().regex(/^lnk_\d{4,}$/),
  // Identifier of the confirmation to open an unregistered document. Send back what the confirmation-required response returned, unchanged.
  // Bound to the confirmed document, revision, link and target, and usable only once.
  confirmation: z.string().min(1).max(64).optional(),
});
export type LinkOpenParams = z.input<typeof linkOpenParamsSchema>;

export const linkOpenResultSchema = z.strictObject({
  // focused: switched to a document that was already open. opened: newly opened after confirmation.
  status: z.enum(['focused', 'opened']),
  documentId: documentIdSchema,
});
export type LinkOpenResult = z.infer<typeof linkOpenResultSchema>;

export const searchModeSchema = z.enum(['text', 'exact', 'path']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchParamsSchema = z.strictObject({
  query: z.string().min(1),
  // text: word matches. exact: only matches of the contiguous string. path: file names and paths only.
  mode: searchModeSchema.default('text'),
  limit: z.number().int().min(1).max(LIMITS.searchLimitMax).default(LIMITS.searchLimitDefault),
  // Document IDs to narrow the search. Defaults to all open documents.
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
  // An actual excerpt of the extracted text. Not a summary or paraphrase.
  excerpt: z.string(),
  matchKind: z.enum(['path-exact', 'phrase', 'text', 'prefix', 'fuzzy']),
  // A relative value inside the search engine. Not a probability or a measure of semantic similarity.
  score: z.number(),
  sourceRange: sourceRangeSchema.nullable(),
  extraction: z.enum(['markdown', 'static-html']),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

// Spec 9.4. Search runs over published content.
export const searchResultSchema = z.strictObject({
  query: z.string(),
  mode: searchModeSchema,
  catalogVersion: z.number().int().nonnegative(),
  // Number of open documents, and how many of them could be searched.
  registeredDocuments: z.number().int().nonnegative(),
  searchedDocuments: z.number().int().nonnegative(),
  indexedAt: z.string(),
  // Some documents could not be searched. The result does not cover every document.
  incomplete: z.boolean(),
  failedDocuments: z.array(z.strictObject({ documentId: documentIdSchema, code: z.string() })),
  indexingDocuments: z.array(documentIdSchema),
  hits: z.array(searchHitSchema),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
