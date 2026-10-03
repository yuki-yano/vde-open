import {
  answersSchema,
  assetRecordSchema,
  cancellationSchema,
  documentFormatSchema,
  documentIdSchema,
  feedbackStatusSchema,
  htmlModeSchema,
  questionnaireSchema,
  requestIdSchema,
  revisionSchema,
  sha256Schema,
  sourceKindSchema,
  sourceStateSchema,
  STATE_FORMAT_VERSION,
  submissionSchema,
  watchRuleSchema,
} from '@vde-open/shared';
import { z } from 'zod';

export const revisionRecordSchema = z.strictObject({
  revision: revisionSchema,
  // この版を解析した形式。文書の形式が後から変わっても、版ごとの解析条件は変えない。
  format: documentFormatSchema,
  sourceSha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
  parserProfileVersion: z.string().min(1),
  createdAt: z.string(),
  // この版の文書の位置（assets-rootからの相対path）と、参照しているlocal file。
  documentLogicalPath: z.string().min(1),
  assets: z.array(assetRecordSchema),
  // 文書が参照するfileを調べ終えたか。failedなら、assetは集められていない（参照がないのとは違う）。
  assetScan: z.enum(['complete', 'failed']),
});
export type RevisionRecord = z.infer<typeof revisionRecordSchema>;

// 文書のidentity。閉じた後も残し、同じpath／keyで開き直したときにIDを再利用する。
export const documentRecordSchema = z.strictObject({
  documentId: documentIdSchema,
  sourceKind: sourceKindSchema,
  canonicalPath: z.string().nullable(),
  key: z.string().nullable(),
  format: documentFormatSchema,
  title: z.string(),
  titleExplicit: z.boolean(),
  displayPath: z.string().nullable(),
  pathSegments: z.array(z.string()),
  isOpen: z.boolean(),
  openedAt: z.string(),
  updatedAt: z.string(),
  sourceState: sourceStateSchema,
  currentRevision: revisionSchema.nullable(),
  revisions: z.array(revisionRecordSchema),
  // local assetを解決できる範囲の上限（symlinkを解決済みのdirectory）。nullなら、local assetは使えない。
  assetsRoot: z.string().nullable(),
  // 利用者が個別に指定したasset（assets-rootからの相対path）。
  extraAssets: z.array(z.string()),
  htmlMode: htmlModeSchema,
});
export type DocumentRecord = z.infer<typeof documentRecordSchema>;

// 質問と回答（仕様11.3）。質問は、作ったときの文書の版に固定する。
export const feedbackRecordSchema = z.strictObject({
  requestId: requestIdSchema,
  documentId: documentIdSchema,
  revision: revisionSchema,
  renderMode: htmlModeSchema,
  questionnaireHash: sha256Schema,
  questionnaire: questionnaireSchema,
  status: feedbackStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  // 再試行で同じ質問を重ねて作らないための識別子と、そのときの依頼内容のhash。
  operationId: z.string().nullable(),
  operationDigest: sha256Schema.nullable(),
  draftVersion: z.number().int().nonnegative(),
  draftAnswers: answersSchema,
  submission: submissionSchema.nullable(),
  // 送信の条件のhash。同じ送信IDの再送が、同じ条件かを確かめる。
  submissionDigest: sha256Schema.nullable(),
  cancellation: cancellationSchema.nullable(),
  acknowledgedAt: z.string().nullable(),
});
export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;

export const statePayloadSchema = z.strictObject({
  catalogVersion: z.number().int().nonnegative(),
  documents: z.record(documentIdSchema, documentRecordSchema),
  openOrder: z.array(documentIdSchema),
  activeDocumentId: documentIdSchema.nullable(),
  watchRules: z.array(watchRuleSchema),
  feedbackRequests: z.record(requestIdSchema, feedbackRecordSchema),
});
export type StatePayload = z.infer<typeof statePayloadSchema>;

export const stateFileSchema = z.strictObject({
  formatVersion: z.literal(STATE_FORMAT_VERSION),
  storeVersion: z.number().int().nonnegative(),
  checksum: sha256Schema,
  payload: statePayloadSchema,
});

export function emptyStatePayload(): StatePayload {
  return {
    catalogVersion: 0,
    documents: {},
    openOrder: [],
    activeDocumentId: null,
    watchRules: [],
    feedbackRequests: {},
  };
}

// schemaでは表せない参照の整合性。違反はstate破損として扱う。
export function findIntegrityProblem(payload: StatePayload): string | null {
  const seen = new Set<string>();
  for (const documentId of payload.openOrder) {
    if (seen.has(documentId)) return `openOrderに重複があります: ${documentId}`;
    seen.add(documentId);
    const record = payload.documents[documentId];
    if (!record) return `openOrderが未知の文書を指しています: ${documentId}`;
    if (!record.isOpen) return `openOrderに閉じた文書があります: ${documentId}`;
  }
  for (const [documentId, record] of Object.entries(payload.documents)) {
    if (record.documentId !== documentId) return `文書IDがkeyと一致しません: ${documentId}`;
    if (record.isOpen && !seen.has(documentId)) {
      return `open中の文書がopenOrderにありません: ${documentId}`;
    }
    if (
      record.currentRevision !== null &&
      !record.revisions.some((entry) => entry.revision === record.currentRevision)
    ) {
      return `currentRevisionが保持中の版にありません: ${documentId}`;
    }
  }
  if (payload.activeDocumentId !== null && !seen.has(payload.activeDocumentId)) {
    return `activeDocumentIdがopen中の文書を指していません: ${payload.activeDocumentId}`;
  }
  const pendingDocuments = new Set<string>();
  const operations = new Set<string>();
  for (const [requestId, request] of Object.entries(payload.feedbackRequests)) {
    if (request.requestId !== requestId) return `質問IDがkeyと一致しません: ${requestId}`;
    const record = payload.documents[request.documentId];
    if (!record) return `質問が未知の文書を指しています: ${requestId}`;
    // 質問に固定した版は、質問を消すまで保持する。
    if (!record.revisions.some((entry) => entry.revision === request.revision)) {
      return `質問に固定した版が保持されていません: ${requestId}`;
    }
    if ((request.status === 'submitted') !== (request.submission !== null)) {
      return `質問の状態と回答が一致しません: ${requestId}`;
    }
    if ((request.status === 'cancelled') !== (request.cancellation !== null)) {
      return `質問の状態と中止の記録が一致しません: ${requestId}`;
    }
    if (request.acknowledgedAt !== null && request.status !== 'submitted') {
      return `回答のない質問に取得済みの記録があります: ${requestId}`;
    }
    if (request.status === 'pending') {
      if (!record.isOpen) return `閉じた文書に回答待ちの質問があります: ${requestId}`;
      if (pendingDocuments.has(request.documentId)) {
        return `1つの文書に回答待ちの質問が複数あります: ${request.documentId}`;
      }
      pendingDocuments.add(request.documentId);
    }
    if (request.operationId !== null) {
      if (operations.has(request.operationId)) {
        return `同じoperation IDの質問が複数あります: ${requestId}`;
      }
      operations.add(request.operationId);
    }
  }
  return null;
}

// 質問が固定している版。文書の版を整理するときに残す。
export function pinnedRevisions(payload: StatePayload, documentId: string): Set<string> {
  const pinned = new Set<string>();
  for (const request of Object.values(payload.feedbackRequests)) {
    if (request.documentId === documentId) pinned.add(request.revision);
  }
  return pinned;
}

// 文書の回答待ちの質問（1件まで）。
export function pendingRequestIdsOf(payload: StatePayload, documentId: string): string[] {
  return Object.values(payload.feedbackRequests)
    .filter((request) => request.documentId === documentId && request.status === 'pending')
    .map((request) => request.requestId);
}

export function referencedBlobs(payload: StatePayload): Set<string> {
  const blobs = new Set<string>();
  for (const record of Object.values(payload.documents)) {
    for (const entry of record.revisions) {
      blobs.add(entry.sourceSha256);
      for (const asset of entry.assets) blobs.add(asset.sha256);
    }
  }
  return blobs;
}
