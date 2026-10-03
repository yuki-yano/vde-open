import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 管理UIの部品は`@/`でsrcを指す（apps/web/vite.config.tsと同じ）。
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL('apps/web/src/', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    // 結合テストは実際のCLI processとdaemonを起動する。
    testTimeout: 30_000,
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/tests/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
