import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { VdeError } from '@vde-open/shared';

export interface SecureDirOptions {
  uid: number | null;
  platform: NodeJS.Platform;
  // testでowner違いを再現するために差し替える。
  lstat?: (path: string) => Promise<Stats>;
}

function insecure(path: string, reason: string): VdeError {
  return new VdeError('E_INSECURE_PATH', `${path} は安全なdirectoryではありません（${reason}）。`, {
    path,
    reason,
  });
}

// 所有者専用のdirectoryを用意する。既存のものは、symlinkでないこと、所有者、権限を確認する。
// WindowsではPOSIXのmode bitsがDACLを表さないので、種別だけを確認する（仕様6.1）。
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
      // 同時に起動した別processが先に作った場合は、作られたものを検査する。
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

// 作成せずに検査だけ行う。既存のdaemonへ接続する前や、診断で使う。
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

// 既存のdirectoryが安全でなければ拒否する。無い場合はfalseを返す。
export async function requirePrivateDirectoryIfExists(
  path: string,
  options: SecureDirOptions,
): Promise<boolean> {
  const inspection = await inspectPrivateDirectory(path, options);
  if (inspection === 'missing') return false;
  if (inspection !== 'ok') throw insecure(path, inspection);
  return true;
}
