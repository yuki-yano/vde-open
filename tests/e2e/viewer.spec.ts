import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

test('P2 gate: a document opened from the CLI is shown in the UI, and additions and saves are reflected as they happen', async ({
  page,
}) => {
  t.write('a.md', '# 最初の文書\n\n本文です。\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());

  const sidebar = page.getByRole('navigation', { name: 'Open documents' });
  await expect(sidebar.getByRole('button', { name: '最初の文書', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '最初の文書' }).last()).toBeVisible();

  // Opening a document from the CLI makes it appear in the list without touching the UI.
  t.write('b.md', '# 二つ目の文書\n');
  await t.json(['open', 'b.md']);
  await expect(sidebar.getByRole('button', { name: '二つ目の文書', exact: true })).toBeVisible();
  // Adding a document does not switch the document being read (DOC-014).
  await expect(page.locator('article')).toContainText('本文です。');

  // DOC-009: a save that writes a temporary file and renames it still shows the final content.
  t.atomicWrite('a.md', '# 最初の文書\n\n保存し直した本文です。\n');
  await expect(page.locator('article')).toContainText('保存し直した本文です。');
});

test('SEC-003: the ticket fragment is not kept in history, and the same URL cannot be used twice', async ({
  page,
  context,
}) => {
  t.write('a.md', '# a\n');
  await t.json(['open', 'a.md']);
  const url = await t.bootstrapUrl();
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Open documents' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.location.href)).not.toContain('bootstrap');
  // The management UI sends no referrer to navigation targets.
  const response = await page.request.get(await t.uiUrl());
  expect(response.headers()['referrer-policy']).toBe('no-referrer');

  // Opening the same URL in another tab does not yield a session.
  const second = await context.newPage();
  await second.goto(url);
  await expect(second.getByRole('heading', { name: 'Open again from the CLI' })).toBeVisible();
});

test('SEC-001: the UI opened without a ticket shows no documents, and the API does not respond', async ({
  page,
}) => {
  t.write('secret.md', '# 秘密の見出し\n');
  await t.json(['open', 'secret.md']);
  const uiUrl = await t.uiUrl();
  await page.goto(uiUrl);
  await expect(page.getByRole('heading', { name: 'Open again from the CLI' })).toBeVisible();
  await expect(page.getByText('秘密の見出し')).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch('/_/api/v1/documents')).status);
  expect(status).toBe(401);
});

test('MD-003: raw HTML and scripts in Markdown do not run in the management UI', async ({
  page,
}) => {
  t.write(
    'attack.md',
    [
      '# 攻撃用の文書',
      '',
      '<script>window.vdeExecuted = "script"</script>',
      '',
      '<img src=x onerror="window.vdeExecuted = \'onerror\'">',
      '',
      '[link](javascript:window.vdeExecuted="link")',
      '',
      '```html',
      '<script>window.vdeExecuted = "code"</script>',
      '```',
      '',
    ].join('\n'),
  );
  await t.json(['open', 'attack.md']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.locator('article')).toContainText('window.vdeExecuted');
  expect(
    await page.evaluate(() => (window as unknown as { vdeExecuted?: string }).vdeExecuted),
  ).toBeUndefined();
  await expect(page.locator('article script')).toHaveCount(0);
  await expect(page.locator('article img')).toHaveCount(0);
  await expect(page.locator('article a[href^="javascript:"]')).toHaveCount(0);
});
