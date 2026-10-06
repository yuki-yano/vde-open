const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// Initial limits from spec 7.4. Changes are recorded in an ADR.
export const LIMITS = {
  openDocuments: 2000,
  documentBytes: 10 * MiB,
  openSourceBytes: 128 * MiB,
  metadataStateBytes: 32 * MiB,
  blobStoreBytes: 1 * GiB,
  titleLength: 160,
  keyLength: 128,
  ipcFrameBytes: 64 * MiB,
  ipcPreAuthFrameBytes: 4 * KiB,
  listLimitDefault: 100,
  listLimitMax: 500,
  readMaxBytesDefault: 16 * KiB,
  readMaxBytesMin: 256,
  readMaxBytesMax: 1 * MiB,
  cursorTtlMs: 5 * 60 * 1000,
  retainedRevisions: 2,
  revisionGraceMs: 5 * 60 * 1000,
  parseTimeoutMs: 2000,
  // Rendering the print document for a PDF export (parse and HTML), and the whole run of the browser that prints it.
  printRenderTimeoutMs: 10_000,
  pdfExportTimeoutMs: 60_000,
  watchDebounceMs: 200,
  bootstrapTicketTtlMs: 60 * 1000,
  sessionIdleMs: 12 * 60 * 60 * 1000,
  sseHeartbeatMs: 15 * 1000,
  // Number of events not yet written on one notification connection. Events beyond it are dropped and replaced by a resync signal.
  ssePendingEvents: 256,
  // A notification connection whose writes make no progress for this long is closed.
  sseStallMs: 60 * 1000,
  assetBytes: 20 * MiB,
  documentAssetBytes: 100 * MiB,
  documentAssets: 500,
  cssReferenceDepth: 8,
  renderGrantsPerSession: 64,
  searchLimitDefault: 5,
  searchLimitMax: 50,
  // Query length (Unicode code points) and number of search terms.
  searchQueryCodePoints: 512,
  searchTerms: 32,
  // Length of a search result excerpt (Unicode code points).
  searchExcerptCodePoints: 240,
  // Hits returned per document. Keeps a large document from filling the candidates.
  searchHitsPerDocument: 2,
  // Maximum time a search waits for the index to catch up.
  searchIndexWaitMs: 2000,
  // Question definition and answer (UTF-8 size of the JSON).
  questionnaireBytes: 64 * KiB,
  answerBytes: 64 * KiB,
  // Fields per question and length of a string answer (Unicode code points).
  questionFields: 32,
  answerStringLength: 4000,
  // Time to wait for an answer (seconds).
  feedbackWaitDefaultSeconds: 120,
  feedbackWaitMaxSeconds: 3600,
  // Size of one message (UTF-8 of the JSON) and message rate for the communication between the HTML and the host (MessagePort) (spec 11.7).
  bridgeInboundFrameBytes: 128 * KiB,
  bridgeOutboundFrameBytes: 256 * KiB,
  bridgeMessagesPerSecond: 20,
  // Number of unregistered file loads recorded per view.
  renderMissingPerGrant: 32,
} as const;
