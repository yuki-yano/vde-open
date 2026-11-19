import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Management UI parts refer to src with `@/` (same as apps/web/vite.config.ts).
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL('apps/web/src/', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    // The default (one worker per core but one) briefly takes about half of a large machine's cores.
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
    // Some daemon tests wait for its 5-second shutdown limit, past the 5-second default.
    testTimeout: 30_000,
    // Stopping a daemon in cleanup can take longer than the 10-second default on slow CI runners.
    hookTimeout: 30_000,
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/tests/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
