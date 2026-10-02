import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

const sidebarOf = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: '開いている文書' });

test('DOC-007 / DOC-008: 階層表示で同名のfileを見分けられ、並べ替えは保存される', async ({
  page,
}) => {
  t.write('alpha/docs/a.md', '# alphaの文書\n');
  t.write('beta/docs/a.md', '# betaの文書\n');
  t.write('readme.md', '# 説明\n');
  await t.json(['open', 'alpha/docs/a.md', 'beta/docs/a.md', 'readme.md']);
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);

  // 順番の表示で、上へ移動する。
  await expect(sidebar.getByRole('listitem')).toHaveText([/alphaの文書/, /betaの文書/, /説明/]);
  await sidebar.getByRole('button', { name: '説明 を上へ移動' }).click();
  await expect(sidebar.getByRole('listitem')).toHaveText([/alphaの文書/, /説明/, /betaの文書/]);

  // 階層の表示では、rootの違いが残る。fileは動かない。
  await sidebar.getByRole('button', { name: '階層' }).click();
  const tree = sidebar.getByRole('tree');
  await expect(tree).toContainText('alpha/docs');
  await expect(tree).toContainText('beta/docs');
  await expect(tree.getByRole('button', { name: 'a.md' })).toHaveCount(2);

  // 並べ替えと表示方法は、読み込み直しても保たれる。
  await page.reload();
  await expect(sidebarOf(page).getByRole('tree')).toBeVisible();
  await sidebarOf(page).getByRole('button', { name: '順番' }).click();
  await expect(sidebarOf(page).getByRole('listitem')).toHaveText([
    /alphaの文書/,
    /説明/,
    /betaの文書/,
  ]);
  const listed = await t.json<{ documents: Array<{ title: string }> }>(['list']);
  expect(listed.documents.map((document) => document.title)).toEqual([
    'alphaの文書',
    '説明',
    'betaの文書',
  ]);
});

test('DOC-013: 原文とプレビューを切り替えられ、更新を止めている間は表示が変わらない', async ({
  page,
}) => {
  t.write('a.md', '# 見出し\n\n**最初**の本文\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  const body = page.getByTestId('document-body');
  await expect(body.locator('strong')).toHaveText('最初');

  // 原文へ切り替えても、内容は同じ。
  await page.getByRole('button', { name: '原文' }).click();
  await expect(body.locator('pre')).toHaveText('# 見出し\n\n**最初**の本文\n');
  await page.getByRole('button', { name: 'プレビュー' }).click();
  await expect(body.locator('strong')).toHaveText('最初');

  // 更新を止めると、停止中であることを示し、保存しても表示は変わらない。
  await page.getByRole('button', { name: '更新を止める' }).click();
  await expect(page.getByText('更新停止中')).toBeVisible();
  t.atomicWrite('a.md', '# 見出し\n\n**更新後**の本文\n');
  await expect(page.getByText('新しい版があります')).toBeVisible();
  await expect(body.locator('strong')).toHaveText('最初');

  // 再開すると、最新の内容になる。
  await page.getByRole('button', { name: '更新を再開' }).click();
  await expect(body.locator('strong')).toHaveText('更新後');
  await expect(page.getByText('更新停止中')).toHaveCount(0);
});

test('DOC-014: 表示していない文書が更新されても、読んでいる文書と位置を奪わない', async ({
  page,
}) => {
  const long = Array.from({ length: 200 }, (_, index) => `段落 ${String(index + 1)}`).join('\n\n');
  t.write('reading.md', `# 読んでいる文書\n\n${long}\n`);
  t.write('other.md', '# 別の文書\n');
  await t.json(['open', 'reading.md', 'other.md']);
  await page.goto(await t.bootstrapUrl());
  const body = page.getByTestId('document-body');
  await expect(body).toContainText('段落 200');
  await body.evaluate((element) => {
    element.scrollTop = 1500;
  });

  t.atomicWrite('other.md', '# 別の文書（更新済み）\n');
  await expect(
    sidebarOf(page).getByRole('button', { name: '別の文書（更新済み）', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: '読んでいる文書' }).first(),
  ).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(1500);

  // 読んでいる文書そのものが更新されても、位置を保つ。
  t.atomicWrite('reading.md', `# 読んでいる文書\n\n${long}\n\n追記\n`);
  await expect(body).toContainText('追記');
  expect(await body.evaluate((element) => element.scrollTop)).toBe(1500);

  // 明示的なfocusの指示のときだけ、表示する文書が切り替わる。
  const listed = await t.json<{ documents: Array<{ documentId: string; title: string }> }>([
    'list',
  ]);
  const other = listed.documents.find((document) => document.title.startsWith('別の文書'));
  await t.json(['focus', other?.documentId ?? '']);
  await expect(
    page.getByRole('heading', { level: 1, name: '別の文書（更新済み）' }).first(),
  ).toBeVisible();
});

test('MD-006: 構造の上限を超える文書は、原文の表示へ切り替えて理由を示す', async ({ page }) => {
  t.write('deep.md', `# 深い文書\n\n${'> '.repeat(70)}底\n`);
  t.write('normal.md', '# 普通の文書\n');
  await t.json(['open', 'deep.md', 'normal.md']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.getByText('入れ子が上限（64段）を超えている')).toBeVisible();
  await expect(page.getByTestId('document-body').locator('pre')).toContainText('底');

  // 他の文書は、そのまま表示できる。
  await sidebarOf(page).getByRole('button', { name: '普通の文書', exact: true }).click();
  await expect(page.getByTestId('document-body').locator('h1')).toHaveText('普通の文書');
});

test('一覧から外しても、fileは残る', async ({ page }) => {
  t.write('a.md', '# 残すfile\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  await sidebarOf(page).getByRole('button', { name: '残すfile を一覧から外す' }).click();
  await expect(sidebarOf(page)).toContainText('開いている文書はありません');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  expect(existsSync(join(t.work, 'a.md'))).toBe(true);
});
