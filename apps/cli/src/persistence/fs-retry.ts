import { rename, rm } from 'node:fs/promises';

// On Windows, renaming onto a file or deleting it fails with EPERM, EACCES, or EBUSY while another
// process has it open (another vde-open process reading it, or antivirus scanning a file that was
// just written). Retry for a short time there. Other platforms fail right away.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_LIMIT_MS = 2000;
const MAX_WAIT_MS = 200;

export interface RetryOptions {
  platform?: NodeJS.Platform;
  limitMs?: number;
}

export async function retryOnWindows(
  operation: () => Promise<void>,
  options: RetryOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') return operation();
  const deadline = Date.now() + (options.limitMs ?? RETRY_LIMIT_MS);
  let wait = 10;
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRY_CODES.has(code) || Date.now() + wait > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
  }
}

export function renameWithRetry(from: string, to: string): Promise<void> {
  return retryOnWindows(() => rename(from, to));
}

export function removeWithRetry(path: string): Promise<void> {
  return retryOnWindows(() => rm(path, { force: true }));
}
