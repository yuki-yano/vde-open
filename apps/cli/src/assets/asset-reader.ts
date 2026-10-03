import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { assetTypeOf, hasHiddenSegment, isValidLogicalPath } from '@vde-open/document';
import { LIMITS } from '@vde-open/shared';

import { readBounded, statSignature } from '../documents/source-reader.ts';

export type AssetReadFailure =
  | 'invalid-path'
  | 'missing'
  | 'outside-root'
  | 'hidden-target'
  | 'type-mismatch'
  | 'not-a-regular-file'
  | 'too-large'
  | 'unreadable'
  | 'unstable';

export type AssetReadResult =
  | { ok: true; bytes: Buffer; signature: string }
  | { ok: false; reason: AssetReadFailure };

const READ_ATTEMPTS = 3;

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !fromRoot.startsWith(sep);
}

// The actual location of the file a logical path points to inside the assets-root. Determined even if it does not exist.
export function assetCandidatePath(root: string, logicalPath: string): string {
  return join(root, ...logicalPath.split('/'));
}

// Reads only regular files inside the assets-root (spec 10.3).
// The root is a directory with symlinks resolved. A symlink that leads outside the root is not read.
// Confirms the same file is pointed to before and after resolution, and before and after reading.
// This does not fully prevent an attack where another process swaps the path concurrently.
export async function readAssetFile(root: string, logicalPath: string): Promise<AssetReadResult> {
  if (!isValidLogicalPath(logicalPath)) return { ok: false, reason: 'invalid-path' };
  const candidate = assetCandidatePath(root, logicalPath);

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    let real: string;
    try {
      // If the root itself has been swapped to another location, read nothing.
      if ((await realpath(root)) !== root) return { ok: false, reason: 'outside-root' };
      real = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }
    if (!isInside(root, real)) return { ok: false, reason: 'outside-root' };
    // The registration checks also apply to the real file after symlink resolution.
    // A symlink named like an image must not let `.env` or a file of another type be read.
    const target = relative(root, real).split(sep).join('/');
    if (hasHiddenSegment(target)) return { ok: false, reason: 'hidden-target' };
    if (assetTypeOf(target)?.mime !== assetTypeOf(logicalPath)?.mime) {
      return { ok: false, reason: 'type-mismatch' };
    }

    let handle;
    try {
      const before = await lstat(real);
      if (!before.isFile()) return { ok: false, reason: 'not-a-regular-file' };
      if (before.size > LIMITS.assetBytes) return { ok: false, reason: 'too-large' };
      // Even if swapped to another kind after the check, this neither blocks nor follows symlinks.
      handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: 'missing' };
      if (code === 'ELOOP') return { ok: false, reason: 'not-a-regular-file' };
      return { ok: false, reason: 'unreadable' };
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { ok: false, reason: 'not-a-regular-file' };
      const bytes = await readBounded(handle, LIMITS.assetBytes);
      if (bytes === null) return { ok: false, reason: 'too-large' };
      const after = await handle.stat();
      const stable =
        opened.ino === after.ino &&
        opened.size === after.size &&
        opened.mtimeMs === after.mtimeMs &&
        bytes.byteLength === after.size;
      // If the path's target changed while reading, read again.
      const still = await realpath(candidate).catch(() => null);
      if (!stable || still !== real) continue;
      return { ok: true, bytes, signature: statSignature(after) };
    } catch {
      return { ok: false, reason: 'unreadable' };
    } finally {
      await handle.close();
    }
  }
  return { ok: false, reason: 'unstable' };
}
