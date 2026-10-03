import { defineConfig, devices } from '@playwright/test';

// ビルド済みの配布物（apps/cli/dist）を、実際のbrowserで検証する。先に pnpm build が必要。
// Firefox・WebKitでも実行する試験（表示の隔離、CSP、HTMLとの通信）。
const CROSS_BROWSER = ['html.spec.ts', 'interactive.spec.ts', 'release.spec.ts', 'viewer.spec.ts'];

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  forbidOnly: true,
  reporter: [['list']],
  // Chromiumは全件。Firefox・WebKitは、表示の隔離（security）とHTMLとの通信（bridge）の試験を実行する（仕様14.3）。
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: CROSS_BROWSER },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: CROSS_BROWSER },
  ],
});
