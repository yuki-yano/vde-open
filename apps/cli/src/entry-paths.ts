import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Whether running from source. false in the distributed package.
export const isSourceRun = import.meta.url.endsWith('.ts');

// Resolve from this module's location, not from the user's cwd or PATH.

// Daemon entry. dist/daemon.js in the distributed package, src/daemon.ts when running from source.
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

// The built Web UI. dist/web in the distributed package. When running from source, use a built dist/web if present.
export function webRootPath(): string | null {
  const candidate = fileURLToPath(new URL(isSourceRun ? '../dist/web' : './web', import.meta.url));
  return existsSync(candidate) ? candidate : null;
}
