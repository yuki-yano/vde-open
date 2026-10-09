import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';

export interface LoadedSource {
  // Absolute path with symlinks resolved. Used as the document's identity.
  canonicalPath: string;
  bytes: Buffer;
  text: string;
  // File state at read time. Watch uses it to decide whether the file changed after this content was read.
  signature: string;
}

const READ_ATTEMPTS = 3;

export function statSignature(stats: Stats): string {
  return `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`;
}

function invalid(path: string, reason: string): VdeError {
  return new VdeError('E_INVALID_SOURCE', `${path} cannot be opened (${reason}).`, {
    path,
    reason,
  });
}

function tooLarge(path: string, actual: number): VdeError {
  return new VdeError('E_LIMIT_EXCEEDED', `${path} exceeds the size limit for a single document.`, {
    path,
    limit: 'documentBytes',
    max: LIMITS.documentBytes,
    actual,
  });
}

// Reads up to the limit. Returns null if there is content beyond the limit.
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

// Resolves the existing prefix with realpath and appends the rest.
// Even a path to a deleted file can be compared with the canonical path from registration.
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

// Checks that the document is valid UTF-8. The source bytes are not modified.
export function decodeSource(bytes: Buffer, label: string): string {
  if (bytes.byteLength > LIMITS.documentBytes) {
    throw new VdeError(
      'E_LIMIT_EXCEEDED',
      `${label} exceeds the size limit for a single document.`,
      {
        path: label,
        limit: 'documentBytes',
        max: LIMITS.documentBytes,
        actual: bytes.byteLength,
      },
    );
  }
  if (bytes.includes(0)) throw invalid(label, 'contains-nul');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid(label, 'invalid-utf8');
  }
}

// Reads regular files only. Checks the type first so it never blocks on opening a FIFO or device.
export async function readSourceFile(
  path: string,
  format: DocumentFormat = 'markdown',
): Promise<LoadedSource> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new VdeError('E_PATH_NOT_FOUND', `${path} was not found.`, { path });
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
      // Even if replaced by another type after lstat, this does not block and does not follow symlinks.
      handle = await open(
        canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw invalid(path, 'permission-denied');
      if (code === 'ENOENT')
        throw new VdeError('E_PATH_NOT_FOUND', `${path} was not found.`, { path });
      if (code === 'ELOOP') throw invalid(path, 'not-a-regular-file');
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw invalid(path, 'not-a-regular-file');
      // Even if the file grows after the check, never read beyond the limit.
      const bytes = await readBounded(handle, LIMITS.documentBytes);
      if (bytes === null) throw tooLarge(path, LIMITS.documentBytes + 1);
      const after = await handle.stat();
      // If the file changed between before and after the read, discard the partial content and read again.
      const stable =
        opened.ino === after.ino &&
        opened.size === after.size &&
        opened.mtimeMs === after.mtimeMs &&
        bytes.byteLength === after.size;
      if (!stable) continue;
      return {
        canonicalPath,
        bytes,
        text: format === 'image' ? '' : decodeSource(bytes, path),
        signature: statSignature(after),
      };
    } finally {
      await handle.close();
    }
  }
  throw new VdeError(
    'E_IO',
    `${path} keeps changing while being read.`,
    { path },
    { retryable: true },
  );
}
