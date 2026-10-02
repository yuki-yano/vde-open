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

// assets-rootの中の、logical pathが指すfileの実際の位置。存在しなくても決まる。
export function assetCandidatePath(root: string, logicalPath: string): string {
  return join(root, ...logicalPath.split('/'));
}

// assets-rootの中の通常のfileだけを読む（仕様10.3）。
// rootは、symlinkを解決済みのdirectory。symlinkを辿った先がrootの外なら読まない。
// 解決の前後と、読み取りの前後で、同じfileを指していることを確かめる。
// 別のprocessが同時にpathを差し替える攻撃を、完全に防ぐものではない。
export async function readAssetFile(root: string, logicalPath: string): Promise<AssetReadResult> {
  if (!isValidLogicalPath(logicalPath)) return { ok: false, reason: 'invalid-path' };
  const candidate = assetCandidatePath(root, logicalPath);

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    let real: string;
    try {
      // rootそのものが別の場所へ差し替えられていたら、何も読まない。
      if ((await realpath(root)) !== root) return { ok: false, reason: 'outside-root' };
      real = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }
    if (!isInside(root, real)) return { ok: false, reason: 'outside-root' };
    // 登録できるかの検査は、symlinkを解決した後の実体にも適用する。
    // 画像の名前を付けたsymlinkで、`.env`や別の種類のfileを読ませない。
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
      // 検査の後に別の種別へ差し替えられても、待たされず、symlinkも辿らない。
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
      // 読んでいる間にpathの指す先が変わっていたら、読み直す。
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
