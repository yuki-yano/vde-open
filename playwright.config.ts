import { defineConfig, devices } from '@playwright/test';

// Verify the built distribution (apps/cli/dist) in real browsers. Requires pnpm build first.
// Tests that also run on Firefox and WebKit (view isolation, CSP, communication with the HTML).
const CROSS_BROWSER = [
  'html.spec.ts',
  'interactive.spec.ts',
  'release.spec.ts',
  'viewer.spec.ts',
  'images.spec.ts',
  'themes.spec.ts',
  'sidebar-drag.spec.ts',
];

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  forbidOnly: true,
  reporter: [['list']],
  // Chromium runs everything. Firefox and WebKit run the view isolation (security) and HTML communication (bridge) tests (spec 14.3).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: CROSS_BROWSER },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: CROSS_BROWSER },
  ],
});
