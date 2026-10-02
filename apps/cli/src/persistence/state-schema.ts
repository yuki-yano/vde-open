import {
  assetRecordSchema,
  documentFormatSchema,
  documentIdSchema,
  htmlModeSchema,
  revisionSchema,
  sha256Schema,
  sourceKindSchema,
  sourceStateSchema,
  STATE_FORMAT_VERSION,
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

export const statePayloadSchema = z.strictObject({
  catalogVersion: z.number().int().nonnegative(),
  documents: z.record(documentIdSchema, documentRecordSchema),
  openOrder: z.array(documentIdSchema),
  activeDocumentId: documentIdSchema.nullable(),
  watchRules: z.array(watchRuleSchema),
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
  return null;
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
