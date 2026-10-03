import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// sourceから実行しているか。配布物ではfalse。
export const isSourceRun = import.meta.url.endsWith('.ts');

// 利用者のcwdやPATHではなく、このmoduleの位置から解決する。

// daemonのentry。配布物ではdist/daemon.js、sourceから実行するときはsrc/daemon.ts。
export function daemonEntryPath(): string {
  return fileURLToPath(new URL(isSourceRun ? './daemon.ts' : './daemon.js', import.meta.url));
}

export function parseWorkerPath(): string {
  return fileURLToPath(
    new URL(
      isSourceRun ? './workers/parse-worker.ts' : './workers/parse-worker.js',
      import.meta.url,
    ),
  );
}

export function searchWorkerPath(): string {
  return fileURLToPath(
    new URL(
      isSourceRun ? './workers/search-worker.ts' : './workers/search-worker.js',
      import.meta.url,
    ),
  );
}

// ビルド済みのWeb UI。配布物ではdist/web。sourceから実行するときは、ビルド済みのdist/webがあれば使う。
export function webRootPath(): string | null {
  const candidate = fileURLToPath(new URL(isSourceRun ? '../dist/web' : './web', import.meta.url));
  return existsSync(candidate) ? candidate : null;
}
