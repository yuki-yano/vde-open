import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

test('P2 gate: CLIで開いた文書がUIに表示され、追加と保存がそのまま反映される', async ({ page }) => {
  t.write('a.md', '# 最初の文書\n\n本文です。\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());

  const sidebar = page.getByRole('navigation', { name: '開いている文書' });
  await expect(sidebar.getByRole('button', { name: '最初の文書', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '最初の文書' }).last()).toBeVisible();

  // CLIで文書を追加すると、UIを操作しなくても一覧に現れる。
  t.write('b.md', '# 二つ目の文書\n');
  await t.json(['open', 'b.md']);
  await expect(sidebar.getByRole('button', { name: '二つ目の文書', exact: true })).toBeVisible();
  // 追加しても、読んでいる文書は切り替わらない（DOC-014）。
  await expect(page.locator('article')).toContainText('本文です。');

  // DOC-009: 一時fileへ書いてrenameする保存でも、最終的な内容が反映される。
  t.atomicWrite('a.md', '# 最初の文書\n\n保存し直した本文です。\n');
  await expect(page.locator('article')).toContainText('保存し直した本文です。');
});

test('SEC-003: ticketのfragmentは履歴に残らず、同じURLは2度使えない', async ({ page, context }) => {
  t.write('a.md', '# a\n');
  await t.json(['open', 'a.md']);
  const url = await t.bootstrapUrl();
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: '開いている文書' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.location.href)).not.toContain('bootstrap');
  // 管理UIは、遷移先へ参照元を渡さない。
  const response = await page.request.get(await t.uiUrl());
  expect(response.headers()['referrer-policy']).toBe('no-referrer');

  // 同じURLを別のtabで開いても、sessionは得られない。
  const second = await context.newPage();
  await second.goto(url);
  await expect(second.getByRole('heading', { name: 'CLIから開き直してください' })).toBeVisible();
});

test('SEC-001: ticketなしで開いたUIは文書を表示せず、APIも応答しない', async ({ page }) => {
  t.write('secret.md', '# 秘密の見出し\n');
  await t.json(['open', 'secret.md']);
  const uiUrl = await t.uiUrl();
  await page.goto(uiUrl);
  await expect(page.getByRole('heading', { name: 'CLIから開き直してください' })).toBeVisible();
  await expect(page.getByText('秘密の見出し')).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch('/_/api/v1/documents')).status);
  expect(status).toBe(401);
});

test('MD-003: Markdown中の生HTMLとscriptは、管理画面で実行されない', async ({ page }) => {
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
