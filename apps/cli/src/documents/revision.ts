import { createHash } from 'node:crypto';

import { canonicalJson, type DocumentFormat } from '@vde-open/shared';

export interface RevisionAsset {
  logicalPath: string;
  mime: string;
  role: string;
  sha256: string;
}

export interface RevisionInput {
  format: DocumentFormat;
  sourceSha256: string;
  parserProfileVersion: string;
  assets: RevisionAsset[];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// 仕様4.1。同じ内容を同じprofileで解析すれば、必ず同じrevisionになる。
export function computeRevision(input: RevisionInput): string {
  const assets = input.assets.toSorted((a, b) =>
    a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0,
  );
  return `rev_${sha256Hex(
    canonicalJson({
      format: input.format,
      sourceSha256: input.sourceSha256,
      parserProfileVersion: input.parserProfileVersion,
      assets,
    }),
  )}`;
}
