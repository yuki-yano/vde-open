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
  // The document's location (a path relative to the assets-root).
  documentLogicalPath: string;
  // A directory with symlinks resolved. When null, local assets are unavailable.
  assetsRoot: string | null;
  // Assets the user specified explicitly (logical paths).
  explicit: string[];
  // When true, an explicitly specified asset that cannot be read is an error. When false, only readable ones are used.
  strictExplicit: boolean;
  scan: (kind: ScanKind, text: string) => Promise<ScannedReference[]>;
}

export interface Manifest {
  // In logical path order.
  assets: LoadedAsset[];
  // Files to track for changes (absolute paths) and their state at read time. Includes referenced files that do not exist.
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

// Collects only the local files the document actually references (spec 10.3).
// The assets-root is the outer bound for resolution; it does not expose every file inside it.
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
        throw new VdeError('E_ASSET_REJECTED', `${logicalPath} cannot be registered as an asset.`, {
          asset: logicalPath,
          reason,
        });
      }
    };
    // Never inspect the same file twice in the same context. Stops here even when CSS files import each other.
    const key = `${context}\n${logicalPath}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const type = assetTypeOf(logicalPath);
    if (type === null) {
      reject('unsupported-type');
      continue;
    }
    // Files under `.env` or `.git` are never registered, even when referenced.
    if (hasHiddenSegment(logicalPath)) {
      reject('hidden');
      continue;
    }
    if (!roleAllowed(context, type.role)) continue;
    if (logicalPath === input.documentLogicalPath || loaded.has(logicalPath)) continue;

    const result = await readAssetFile(root, logicalPath);
    const path = assetCandidatePath(root, logicalPath);
    if (!result.ok) {
      // An asset over the limit fails the document registration instead of being truncated.
      if (result.reason === 'too-large') {
        throw new VdeError('E_LIMIT_EXCEEDED', `${logicalPath} exceeds the asset size limit.`, {
          asset: logicalPath,
          limit: 'assetBytes',
          max: LIMITS.assetBytes,
        });
      }
      reject(result.reason);
      // Track missing targets too, so they can be read once created later.
      if (result.reason === 'missing' && tracked.size < MAX_TRACKED) tracked.set(path, 'missing');
      continue;
    }
    totalBytes += result.bytes.byteLength;
    if (loaded.size + 1 > LIMITS.documentAssets) {
      throw new VdeError(
        'E_LIMIT_EXCEEDED',
        'The number of assets per document exceeds the limit.',
        {
          limit: 'documentAssets',
          max: LIMITS.documentAssets,
        },
      );
    }
    if (totalBytes > LIMITS.documentAssetBytes) {
      throw new VdeError(
        'E_LIMIT_EXCEEDED',
        'The total asset size per document exceeds the limit.',
        {
          limit: 'documentAssetBytes',
          max: LIMITS.documentAssetBytes,
        },
      );
    }
    loaded.set(logicalPath, { logicalPath, mime: type.mime, role: type.role, bytes: result.bytes });
    tracked.set(path, result.signature);

    // Also collect files referenced by CSS. Nothing beyond the depth limit is read.
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
