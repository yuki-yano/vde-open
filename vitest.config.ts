import { defineConfig } from 'vitest/config';

export default defineConfig({
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
