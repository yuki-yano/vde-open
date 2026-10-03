import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { VdeError } from '@vde-open/shared';

export interface SecureDirOptions {
  uid: number | null;
  platform: NodeJS.Platform;
  // Replaced in tests to reproduce a different owner.
  lstat?: (path: string) => Promise<Stats>;
}

function insecure(path: string, reason: string): VdeError {
  return new VdeError('E_INSECURE_PATH', `${path} is not a secure directory (${reason}).`, {
    path,
    reason,
  });
}

// Prepare an owner-only directory. For an existing one, check that it is not a symlink, and check the owner and permissions.
// On Windows, POSIX mode bits do not represent the DACL, so only the kind is checked (spec 6.1).
export async function ensurePrivateDirectory(
  path: string,
  options: SecureDirOptions,
): Promise<void> {
  const readStats = options.lstat ?? lstat;
  let stats: Stats;
  try {
    stats = await readStats(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      // If another process started at the same time created it first, inspect what was created.
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    if (options.platform !== 'win32') await chmod(path, 0o700);
    stats = await readStats(path);
  }
  if (stats.isSymbolicLink()) throw insecure(path, 'symlink');
  if (!stats.isDirectory()) throw insecure(path, 'not-a-directory');
  if (options.platform === 'win32') return;
  if (options.uid !== null && stats.uid !== options.uid) throw insecure(path, 'owner');
  if ((stats.mode & 0o077) !== 0) throw insecure(path, 'permissions');
}

export type DirectoryInspection =
  | 'ok'
  | 'missing'
  | 'symlink'
  | 'not-a-directory'
  | 'owner'
  | 'permissions';

// Inspect only, without creating. Used before connecting to an existing daemon and in diagnostics.
export async function inspectPrivateDirectory(
  path: string,
  options: SecureDirOptions,
): Promise<DirectoryInspection> {
  let stats: Stats;
  try {
    stats = await (options.lstat ?? lstat)(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stats.isSymbolicLink()) return 'symlink';
  if (!stats.isDirectory()) return 'not-a-directory';
  if (options.platform === 'win32') return 'ok';
  if (options.uid !== null && stats.uid !== options.uid) return 'owner';
  if ((stats.mode & 0o077) !== 0) return 'permissions';
  return 'ok';
}

// Reject if an existing directory is not secure. Returns false if it does not exist.
export async function requirePrivateDirectoryIfExists(
  path: string,
  options: SecureDirOptions,
): Promise<boolean> {
  const inspection = await inspectPrivateDirectory(path, options);
  if (inspection === 'missing') return false;
  if (inspection !== 'ok') throw insecure(path, inspection);
  return true;
}
