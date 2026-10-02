import {
  assetTypeOf,
  classifyReference,
  dirnameOfLogicalPath,
  hasHiddenSegment,
  roleAllowed,
  type AssetRole,
  type ReferenceContext,
} from '@vde-open/document';
import type { ScanKind, ScannedReference } from '@vde-open/document/render';
import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';

import { assetCandidatePath, readAssetFile } from './asset-reader.ts';

export interface LoadedAsset {
  logicalPath: string;
  mime: string;
  role: AssetRole;
  bytes: Buffer;
}

export interface ManifestInput {
  format: DocumentFormat;
  text: string;
  // 文書の位置（assets-rootからの相対path）。
  documentLogicalPath: string;
  // symlinkを解決済みのdirectory。nullなら、local assetは使えない。
  assetsRoot: string | null;
  // 利用者が個別に指定したasset（logical path）。
  explicit: string[];
  // trueなら、個別に指定したassetを読めないときにerrorにする。falseなら、読めたものだけを使う。
  strictExplicit: boolean;
  scan: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
}

export interface Manifest {
  // logical pathの順。
  assets: LoadedAsset[];
  // 変更を追うfile（絶対path）と、読み取った時点の状態。参照されているが存在しないfileも含む。
  tracked: Array<{ path: string; signature: string }>;
}

interface Pending {
  logicalPath: string;
  context: ReferenceContext;
  depth: number;
}

const MAX_TRACKED = LIMITS.documentAssets * 2;

function decodeCss(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// 文書が実際に参照するlocal fileだけを集める（仕様10.3）。
// assets-rootは解決できる範囲の上限で、その中のfileをすべて公開するわけではない。
export async function buildManifest(input: ManifestInput): Promise<Manifest> {
  const root = input.assetsRoot;
  if (root === null) return { assets: [], tracked: [] };

  const loaded = new Map<string, LoadedAsset>();
  const tracked = new Map<string, string>();
  const visited = new Set<string>();
  let totalBytes = 0;

  const enqueue = (references: ScannedReference[], baseDir: string, depth: number): Pending[] => {
    const pending: Pending[] = [];
    for (const reference of references) {
      const target = classifyReference(reference.url, baseDir);
      if (target.kind !== 'local') continue;
      pending.push({ logicalPath: target.logicalPath, context: reference.context, depth });
    }
    return pending;
  };

  const queue: Pending[] = [
    ...input.explicit.map((logicalPath): Pending => ({
      logicalPath,
      context: 'explicit',
      depth: 0,
    })),
    ...enqueue(
      await input.scan(input.format, input.text),
      dirnameOfLogicalPath(input.documentLogicalPath),
      0,
    ),
  ];

  for (let index = 0; index < queue.length; index += 1) {
    const { logicalPath, context, depth } = queue[index] as Pending;
    const explicit = context === 'explicit';
    const reject = (reason: string): void => {
      if (explicit && input.strictExplicit) {
        throw new VdeError('E_ASSET_REJECTED', `${logicalPath} はassetとして登録できません。`, {
          asset: logicalPath,
          reason,
        });
      }
    };
    // 同じfileを、同じ文脈で2度調べない。CSSが互いを読み込んでいても、ここで止まる。
    const key = `${context}\n${logicalPath}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const type = assetTypeOf(logicalPath);
    if (type === null) {
      reject('unsupported-type');
      continue;
    }
    // `.env`や`.git`の下のfileは、参照されていても登録しない。
    if (hasHiddenSegment(logicalPath)) {
      reject('hidden');
      continue;
    }
    if (!roleAllowed(context, type.role)) continue;
    if (logicalPath === input.documentLogicalPath || loaded.has(logicalPath)) continue;

    const result = await readAssetFile(root, logicalPath);
    const path = assetCandidatePath(root, logicalPath);
    if (!result.ok) {
      // 上限を超えるassetは、切り捨てずに、文書の登録を失敗させる。
      if (result.reason === 'too-large') {
        throw new VdeError(
          'E_LIMIT_EXCEEDED',
          `${logicalPath} はassetの大きさの上限を超えています。`,
          {
            asset: logicalPath,
            limit: 'assetBytes',
            max: LIMITS.assetBytes,
          },
        );
      }
      reject(result.reason);
      // 後から作られたら読み直せるよう、存在しない参照先も追う。
      if (result.reason === 'missing' && tracked.size < MAX_TRACKED) tracked.set(path, 'missing');
      continue;
    }
    totalBytes += result.bytes.byteLength;
    if (loaded.size + 1 > LIMITS.documentAssets) {
      throw new VdeError('E_LIMIT_EXCEEDED', '1文書のassetの数の上限を超えます。', {
        limit: 'documentAssets',
        max: LIMITS.documentAssets,
      });
    }
    if (totalBytes > LIMITS.documentAssetBytes) {
      throw new VdeError('E_LIMIT_EXCEEDED', '1文書のassetの合計の大きさが上限を超えます。', {
        limit: 'documentAssetBytes',
        max: LIMITS.documentAssetBytes,
      });
    }
    loaded.set(logicalPath, { logicalPath, mime: type.mime, role: type.role, bytes: result.bytes });
    tracked.set(path, result.signature);

    // CSSが参照するfileも集める。深さの上限を超えた先は読まない。
    if (type.role === 'style' && depth < LIMITS.cssReferenceDepth) {
      const css = decodeCss(result.bytes);
      if (css !== null) {
        queue.push(
          ...enqueue(await input.scan('css', css), dirnameOfLogicalPath(logicalPath), depth + 1),
        );
      }
    }
  }

  const byPath = (a: { logicalPath: string }, b: { logicalPath: string }) =>
    a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0;
  return {
    assets: [...loaded.values()].toSorted(byPath),
    tracked: [...tracked]
      .map(([path, signature]) => ({ path, signature }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
