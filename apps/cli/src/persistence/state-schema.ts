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
  // The format this revision was parsed as. Even if the document format changes later, each revision's parse conditions stay fixed.
  format: documentFormatSchema,
  sourceSha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
  parserProfileVersion: z.string().min(1),
  createdAt: z.string(),
  // Location of this revision's document (path relative to assets-root) and the local files it references.
  documentLogicalPath: z.string().min(1),
  assets: z.array(assetRecordSchema),
  // Whether scanning the files referenced by the document finished. If failed, assets were not collected (which differs from having no references).
  assetScan: z.enum(['complete', 'failed']),
});
export type RevisionRecord = z.infer<typeof revisionRecordSchema>;

// Document identity. Kept after closing, so reopening by the same path/key reuses the ID.
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
  // Upper bound of where local assets can be resolved (a directory with symlinks resolved). If null, local assets are unavailable.
  assetsRoot: z.string().nullable(),
  // Assets the user registered individually (paths relative to assets-root).
  extraAssets: z.array(z.string()),
  htmlMode: htmlModeSchema,
});
export type DocumentRecord = z.infer<typeof documentRecordSchema>;

// Questions and answers (spec 11.3). A question is pinned to the document revision at creation time.
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
  // Identifier that keeps retries from creating the same question twice, and the hash of the request contents at that time.
  operationId: z.string().nullable(),
  operationDigest: sha256Schema.nullable(),
  draftVersion: z.number().int().nonnegative(),
  draftAnswers: answersSchema,
  submission: submissionSchema.nullable(),
  // Hash of the submit conditions. Verifies that a resend with the same submission ID has the same conditions.
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

// Referential integrity that the schema cannot express. A violation is treated as state corruption.
export function findIntegrityProblem(payload: StatePayload): string | null {
  const seen = new Set<string>();
  for (const documentId of payload.openOrder) {
    if (seen.has(documentId)) return `openOrder has a duplicate: ${documentId}`;
    seen.add(documentId);
    const record = payload.documents[documentId];
    if (!record) return `openOrder refers to an unknown document: ${documentId}`;
    if (!record.isOpen) return `openOrder contains a closed document: ${documentId}`;
  }
  for (const [documentId, record] of Object.entries(payload.documents)) {
    if (record.documentId !== documentId) return `documentId does not match the key: ${documentId}`;
    if (record.isOpen && !seen.has(documentId)) {
      return `An open document is missing from openOrder: ${documentId}`;
    }
    if (
      record.currentRevision !== null &&
      !record.revisions.some((entry) => entry.revision === record.currentRevision)
    ) {
      return `currentRevision is not among the retained revisions: ${documentId}`;
    }
  }
  if (payload.activeDocumentId !== null && !seen.has(payload.activeDocumentId)) {
    return `activeDocumentId does not refer to an open document: ${payload.activeDocumentId}`;
  }
  const pendingDocuments = new Set<string>();
  const operations = new Set<string>();
  for (const [requestId, request] of Object.entries(payload.feedbackRequests)) {
    if (request.requestId !== requestId) return `requestId does not match the key: ${requestId}`;
    const record = payload.documents[request.documentId];
    if (!record) return `A question refers to an unknown document: ${requestId}`;
    // The revision pinned by a question is retained until the question is deleted.
    if (!record.revisions.some((entry) => entry.revision === request.revision)) {
      return `The revision pinned by a question is not retained: ${requestId}`;
    }
    if ((request.status === 'submitted') !== (request.submission !== null)) {
      return `Question status and answer do not match: ${requestId}`;
    }
    if ((request.status === 'cancelled') !== (request.cancellation !== null)) {
      return `Question status and cancellation record do not match: ${requestId}`;
    }
    if (request.acknowledgedAt !== null && request.status !== 'submitted') {
      return `A question without an answer has an acknowledge record: ${requestId}`;
    }
    if (request.status === 'pending') {
      if (!record.isOpen) return `A closed document has a pending question: ${requestId}`;
      if (pendingDocuments.has(request.documentId)) {
        return `A document has more than one pending question: ${request.documentId}`;
      }
      pendingDocuments.add(request.documentId);
    }
    if (request.operationId !== null) {
      if (operations.has(request.operationId)) {
        return `Multiple questions share the same operation ID: ${requestId}`;
      }
      operations.add(request.operationId);
    }
  }
  return null;
}

// Revisions pinned by questions. Kept when pruning a document's revisions.
export function pinnedRevisions(payload: StatePayload, documentId: string): Set<string> {
  const pinned = new Set<string>();
  for (const request of Object.values(payload.feedbackRequests)) {
    if (request.documentId === documentId) pinned.add(request.revision);
  }
  return pinned;
}

// The document's pending questions (at most one).
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
