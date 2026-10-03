const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// 仕様7.4の初期上限。変更はADRに記録する。
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
  watchDebounceMs: 200,
  bootstrapTicketTtlMs: 60 * 1000,
  sessionIdleMs: 12 * 60 * 60 * 1000,
  sseHeartbeatMs: 15 * 1000,
  assetBytes: 20 * MiB,
  documentAssetBytes: 100 * MiB,
  documentAssets: 500,
  cssReferenceDepth: 8,
  renderGrantsPerSession: 64,
  searchLimitDefault: 5,
  searchLimitMax: 50,
  // queryの長さ（Unicode code points）と、検索語の数。
  searchQueryCodePoints: 512,
  searchTerms: 32,
  // 検索結果の抜粋の長さ（Unicode code points）。
  searchExcerptCodePoints: 240,
  // 1文書から返すhitの数。大きい文書が候補を占めないようにする。
  searchHitsPerDocument: 2,
  // 検索が、indexへの反映を待つ上限。
  searchIndexWaitMs: 2000,
  // 質問定義と回答（JSONのUTF-8の大きさ）。
  questionnaireBytes: 64 * KiB,
  answerBytes: 64 * KiB,
  // 1つの質問のfield数と、文字列の回答の長さ（Unicode code points）。
  questionFields: 32,
  answerStringLength: 4000,
  // 回答を待つ時間（秒）。
  feedbackWaitDefaultSeconds: 120,
  feedbackWaitMaxSeconds: 3600,
  // HTMLと本体の間の通信（MessagePort）の1件の大きさ（JSONのUTF-8）と、件数（仕様11.7）。
  bridgeInboundFrameBytes: 128 * KiB,
  bridgeOutboundFrameBytes: 256 * KiB,
  bridgeMessagesPerSecond: 20,
  // 1つの表示で記録する、登録されていないfileの読み込みの数。
  renderMissingPerGrant: 32,
} as const;
