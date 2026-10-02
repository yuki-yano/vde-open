import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { LIMITS, VdeError } from '@vde-open/shared';

export interface LoadedSource {
  // symlinkを解決した絶対path。文書のidentityに使う。
  canonicalPath: string;
  bytes: Buffer;
  text: string;
  // 読み取った時点のfileの状態。監視が「この内容を読んだ後に変わったか」を判定するのに使う。
  signature: string;
}

const READ_ATTEMPTS = 3;

export function statSignature(stats: Stats): string {
  return `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`;
}

function invalid(path: string, reason: string): VdeError {
  return new VdeError('E_INVALID_SOURCE', `${path} は開けません（${reason}）。`, { path, reason });
}

function tooLarge(path: string, actual: number): VdeError {
  return new VdeError('E_LIMIT_EXCEEDED', `${path} は1文書の大きさの上限を超えています。`, {
    path,
    limit: 'documentBytes',
    max: LIMITS.documentBytes,
    actual,
  });
}

// 上限まで読む。上限を超える内容があればnull。
export async function readBounded(handle: FileHandle, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

// まだ存在するところまでをrealpathで解決し、残りをつなぐ。
// 削除済みのfileを指すpathでも、登録時のcanonical pathと比べられる。
export async function canonicalizePath(path: string): Promise<string> {
  const pending: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...pending.toReversed());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) return path;
      pending.push(basename(current));
      current = parent;
    }
  }
}

// UTF-8の文書として妥当かを確かめる。原文のbytesは変更しない。
export function decodeSource(bytes: Buffer, label: string): string {
  if (bytes.byteLength > LIMITS.documentBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', `${label} は1文書の大きさの上限を超えています。`, {
      path: label,
      limit: 'documentBytes',
      max: LIMITS.documentBytes,
      actual: bytes.byteLength,
    });
  }
  if (bytes.includes(0)) throw invalid(label, 'contains-nul');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid(label, 'invalid-utf8');
  }
}

// 通常のfileだけを読む。FIFOやdeviceを開いて待ち続けないよう、種別を確かめてから読む。
export async function readSourceFile(path: string): Promise<LoadedSource> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new VdeError('E_PATH_NOT_FOUND', `${path} が見つかりません。`, { path });
    }
    if (code === 'EACCES' || code === 'EPERM') throw invalid(path, 'permission-denied');
    throw error;
  }
  const before = await lstat(canonicalPath);
  if (!before.isFile()) throw invalid(path, 'not-a-regular-file');
  if (before.size > LIMITS.documentBytes) throw tooLarge(path, before.size);

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      // lstatの後に別の種別へ差し替えられても、待たされず、symlinkも辿らない。
      handle = await open(
        canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw invalid(path, 'permission-denied');
      if (code === 'ENOENT')
        throw new VdeError('E_PATH_NOT_FOUND', `${path} が見つかりません。`, { path });
      if (code === 'ELOOP') throw invalid(path, 'not-a-regular-file');
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw invalid(path, 'not-a-regular-file');
      // 検査後にfileが大きくなっても、上限を超えて読み込まない。
      const bytes = await readBounded(handle, LIMITS.documentBytes);
      if (bytes === null) throw tooLarge(path, LIMITS.documentBytes + 1);
      const after = await handle.stat();
      // 読み取りの前後でfileが変わっていたら、途中の内容を採用せずに読み直す。
      const stable =
        opened.ino === after.ino &&
        opened.size === after.size &&
        opened.mtimeMs === after.mtimeMs &&
        bytes.byteLength === after.size;
      if (!stable) continue;
      return {
        canonicalPath,
        bytes,
        text: decodeSource(bytes, path),
        signature: statSignature(after),
      };
    } finally {
      await handle.close();
    }
  }
  throw new VdeError(
    'E_IO',
    `${path} は読み取り中に変更され続けています。`,
    { path },
    { retryable: true },
  );
}
