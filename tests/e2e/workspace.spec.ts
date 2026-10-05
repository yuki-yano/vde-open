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
  page.getByRole('navigation', { name: 'Open documents' });

test('DOC-007 / DOC-008: the tree view tells same-named files apart, and reordering is saved', async ({
  page,
}) => {
  t.write('alpha/docs/a.md', '# alphaの文書\n');
  t.write('beta/docs/a.md', '# betaの文書\n');
  t.write('readme.md', '# 説明\n');
  await t.json(['open', 'alpha/docs/a.md', 'beta/docs/a.md', 'readme.md']);
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);

  // In the flat view, move an item up.
  await expect(sidebar.getByRole('listitem')).toHaveText([/alphaの文書/, /betaの文書/, /説明/]);
  // The row buttons take clicks only while the row is hovered or has focus.
  await sidebar.getByRole('listitem').filter({ hasText: '説明' }).hover();
  await sidebar.getByRole('button', { name: 'Move 説明 up' }).click();
  await expect(sidebar.getByRole('listitem')).toHaveText([/alphaの文書/, /説明/, /betaの文書/]);

  // In the tree view, the difference in roots remains. Files are not moved.
  await sidebar.getByRole('button', { name: 'Tree' }).click();
  const tree = sidebar.getByRole('tree');
  await expect(tree).toContainText('alpha/docs');
  await expect(tree).toContainText('beta/docs');
  await expect(tree.getByRole('button', { name: 'a.md' })).toHaveCount(2);

  // The order and the layout survive a reload.
  await page.reload();
  await expect(sidebarOf(page).getByRole('tree')).toBeVisible();
  await sidebarOf(page).getByRole('button', { name: 'Flat' }).click();
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

test('DOC-013: Source and Preview can be switched, and the view does not change while updates are paused', async ({
  page,
}) => {
  t.write('a.md', '# 見出し\n\n**最初**の本文\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  const body = page.getByTestId('document-body');
  await expect(body.locator('strong')).toHaveText('最初');

  // Switching to Source shows the same content.
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(body.locator('pre')).toHaveText('# 見出し\n\n**最初**の本文\n');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(body.locator('strong')).toHaveText('最初');

  // Pausing updates shows that they are paused, and a save does not change the view.
  await page.getByRole('button', { name: 'Pause updates' }).click();
  await expect(page.getByText('Updates paused')).toBeVisible();
  t.atomicWrite('a.md', '# 見出し\n\n**更新後**の本文\n');
  await expect(page.getByText('A newer revision is available')).toBeVisible();
  await expect(body.locator('strong')).toHaveText('最初');

  // Resuming shows the latest content.
  await page.getByRole('button', { name: 'Resume updates' }).click();
  await expect(body.locator('strong')).toHaveText('更新後');
  await expect(page.getByText('Updates paused')).toHaveCount(0);
});

test('DOC-014: an update to a document not being shown does not steal the document being read or its position', async ({
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

  // Even when the document being read is updated, the position is kept.
  t.atomicWrite('reading.md', `# 読んでいる文書\n\n${long}\n\n追記\n`);
  await expect(body).toContainText('追記');
  expect(await body.evaluate((element) => element.scrollTop)).toBe(1500);

  // Only an explicit focus request switches the shown document.
  const listed = await t.json<{ documents: Array<{ documentId: string; title: string }> }>([
    'list',
  ]);
  const other = listed.documents.find((document) => document.title.startsWith('別の文書'));
  await t.json(['focus', other?.documentId ?? '']);
  await expect(
    page.getByRole('heading', { level: 1, name: '別の文書（更新済み）' }).first(),
  ).toBeVisible();
});

test('MD-006: a document over the structure limits switches to the Source view and explains why', async ({
  page,
}) => {
  t.write('deep.md', `# 深い文書\n\n${'> '.repeat(70)}底\n`);
  t.write('normal.md', '# 普通の文書\n');
  await t.json(['open', 'deep.md', 'normal.md']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.getByText('nested deeper than 64 levels')).toBeVisible();
  await expect(page.getByTestId('document-body').locator('pre')).toContainText('底');

  // Other documents are shown as usual.
  await sidebarOf(page).getByRole('button', { name: '普通の文書', exact: true }).click();
  await expect(page.getByTestId('document-body').locator('h1')).toHaveText('普通の文書');
});

test('removing from the list keeps the file', async ({ page }) => {
  t.write('a.md', '# 残すfile\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  await sidebarOf(page).getByRole('listitem').filter({ hasText: '残すfile' }).hover();
  await sidebarOf(page).getByRole('button', { name: 'Remove 残すfile from the list' }).click();
  await expect(sidebarOf(page)).toContainText('No documents are open');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  expect(existsSync(join(t.work, 'a.md'))).toBe(true);
});

test('shows every heading even when the outline does not fit in one response', async ({ page }) => {
  // A document whose outline JSON exceeds the per-response limit (1MiB).
  const headings = Array.from(
    { length: 1500 },
    (_, index) => `## 見出し${String(index).padStart(4, '0')} ${'x'.repeat(380)}\n\n本文。\n`,
  );
  t.write('many.md', `# 多くの見出し\n\n${headings.join('\n')}`);
  await t.json(['open', 'many.md']);
  await page.goto(await t.bootstrapUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  await expect(outline.getByRole('listitem')).toHaveCount(1501);
  await expect(outline.getByRole('listitem').last()).toContainText('見出し1499');
  await expect(outline.getByRole('alert')).toHaveCount(0);
});

test('the shown document is kept in the URL: a reload shows it again, and back and forward move between documents', async ({
  page,
}) => {
  t.write('a.md', '# 一つ目\n\n本文A\n');
  t.write('b.md', '# 二つ目\n\n本文B\n');
  await t.json(['open', 'a.md', 'b.md']);
  await page.goto(await t.bootstrapUrl());
  const shown = page
    .getByRole('region', { name: 'Document view' })
    .getByRole('heading', { level: 1 })
    .first();
  await expect(shown).toHaveText('一つ目');
  await expect(page).toHaveURL(/\?document=doc_/);
  const first = page.url();

  await sidebarOf(page).getByRole('button', { name: '二つ目', exact: true }).click();
  await expect(shown).toHaveText('二つ目');
  expect(page.url()).not.toBe(first);
  await page.reload();
  await expect(shown).toHaveText('二つ目');

  await page.goBack();
  await expect(shown).toHaveText('一つ目');
  expect(page.url()).toBe(first);
  await page.goForward();
  await expect(shown).toHaveText('二つ目');
});

test('jumping from the outline moves the Markdown preview to the heading', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, index) => `段落${String(index)}`).join('\n\n');
  t.write(
    'a.md',
    `# 文書\n\n${filler}\n\n## 中間の見出し\n\n${filler}\n\n## 最後の見出し\n\n${filler}\n`,
  );
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  const middle = page.locator('article').getByRole('heading', { name: '中間の見出し' });
  await expect(middle).toBeAttached();
  await expect(middle).not.toBeInViewport();

  await outline.getByRole('button', { name: '中間の見出し' }).click();
  await expect(middle).toBeInViewport();
  await outline.getByRole('button', { name: '最後の見出し' }).click();
  await expect(
    page.locator('article').getByRole('heading', { name: '最後の見出し' }),
  ).toBeInViewport();
  await expect(middle).not.toBeInViewport();
});

test('the heading jumped to is kept in the URL: a reload, and going back to the document, jump to it again', async ({
  page,
}) => {
  const filler = Array.from({ length: 60 }, (_, index) => `段落${String(index)}`).join('\n\n');
  t.write(
    'a.md',
    `# 文書\n\n${filler}\n\n## 中間の見出し\n\n${filler}\n\n## 最後の見出し\n\n${filler}\n`,
  );
  t.write('b.md', '# 別の文書\n');
  await t.json(['open', 'a.md', 'b.md']);
  await page.goto(await t.bootstrapUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  const middle = page.locator('article').getByRole('heading', { name: '中間の見出し' });
  await expect(middle).toBeAttached();
  const length = await page.evaluate(() => window.history.length);

  await outline.getByRole('button', { name: '中間の見出し' }).click();
  await expect(middle).toBeInViewport();
  await expect(page).toHaveURL(/[?&]heading=/);
  const url = new URL(page.url());
  expect(url.searchParams.get('section')).toBe('sec_0002');
  expect(url.searchParams.get('heading')).toBe('中間の見出し');
  expect(await page.evaluate(() => window.history.length)).toBe(length);

  await page.reload();
  await expect(middle).toBeInViewport();

  await sidebarOf(page).getByRole('button', { name: '別の文書', exact: true }).click();
  await expect(page.locator('article')).toContainText('別の文書');
  expect(new URL(page.url()).searchParams.get('heading')).toBeNull();
  await page.goBack();
  await expect(middle).toBeInViewport();
});

test('back within the document jumps to the heading its entry keeps, and a search result chosen while that heading waits wins', async ({
  page,
}) => {
  const filler = Array.from({ length: 60 }, (_, index) => `段落${String(index)}`).join('\n\n');
  t.write(
    'a.md',
    `# 文書\n\n${filler}\n\n## 中間の見出し\n\n${filler}\n\n## 最後の見出し\n\nquokka\n\n${filler}\n`,
  );
  t.write('b.md', '# 別の文書\n');
  await t.json(['open', 'a.md', 'b.md']);
  await page.goto(await t.bootstrapUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  const middle = page.locator('article').getByRole('heading', { name: '中間の見出し' });
  const last = page.locator('article').getByRole('heading', { name: '最後の見出し' });
  await outline.getByRole('button', { name: '中間の見出し' }).click();
  await expect(middle).toBeInViewport();

  // The other document is shown and then closed, so the view returns to this document without its heading.
  await sidebarOf(page).getByRole('button', { name: '別の文書', exact: true }).click();
  await expect(page.locator('article')).toContainText('別の文書');
  await t.json(['close', 'b.md']);
  await expect(middle).toBeAttached();
  await expect(middle).not.toBeInViewport();
  expect(new URL(page.url()).searchParams.get('heading')).toBeNull();
  await page.goBack();
  await expect(middle).toBeInViewport();
  expect(new URL(page.url()).searchParams.get('heading')).toBe('中間の見出し');

  // Reloaded in the Source view, the heading of the URL waits for the preview. A search result chosen meanwhile wins.
  await page.getByRole('button', { name: 'Source' }).click();
  await page.reload();
  await expect(page.getByTestId('document-body').locator('pre')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Search open documents' });
  await dialog.getByRole('textbox', { name: 'Search query' }).fill('quokka');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(last).toBeInViewport();
  await expect(middle).not.toBeInViewport();
  await expect(page).toHaveURL(/heading=/);
  expect(new URL(page.url()).searchParams.get('heading')).toBe('最後の見出し');
});
