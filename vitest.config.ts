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
    // Integration tests start real CLI processes and the daemon.
    testTimeout: 30_000,
    // Cleanup stops the daemon, which can take longer than the 10-second default on slow CI runners.
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
