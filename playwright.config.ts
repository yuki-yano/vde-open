import { defineConfig, devices } from '@playwright/test';

// ビルド済みの配布物（apps/cli/dist）を、実際のbrowserで検証する。先に pnpm build が必要。
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  forbidOnly: true,
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
