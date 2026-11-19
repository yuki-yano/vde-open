import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

test('DOC-013: Source and Preview can be switched, and the view does not change while updates are paused', async ({
  page,
}) => {
  t.write('a.md', '# 見出し\n\n**最初**の本文\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.uiUrl());
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
  await expect(page.getByRole('button', { name: 'Update available' })).toBeVisible();
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
  await page.goto(await t.uiUrl());
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
  await page.goto(await t.uiUrl());
  await expect(page.getByText('nested deeper than 64 levels')).toBeVisible();
  await expect(page.getByTestId('document-body').locator('pre')).toContainText('底');

  // Other documents are shown as usual.
  await sidebarOf(page).getByRole('button', { name: '普通の文書', exact: true }).click();
  await expect(page.getByTestId('document-body').locator('h1')).toHaveText('普通の文書');
});

test('closing the displayed document returns to the last document opened, regardless of sidebar order', async ({
  page,
}) => {
  for (const title of ['A', 'B', 'C', 'D']) t.write(`${title}.md`, `# ${title}\n`);
  const { documents } = await t.json<{ documents: Array<{ documentId: string }> }>([
    'open',
    'A.md',
    'B.md',
    'C.md',
    'D.md',
  ]);
  const [a, , c, d] = documents.map(({ documentId }) => documentId);
  await page.goto(await t.uiUrl());
  const sidebar = sidebarOf(page);
  const row = (title: string) => sidebar.getByRole('button', { name: title, exact: true });
  const shown = page.getByTestId('document-body').getByRole('heading', { level: 1 });
  const closeFromSidebar = async (title: string) => {
    await row(title).hover();
    await sidebar.getByRole('button', { name: `Remove ${title} from the list` }).click();
    await expect(row(title)).toHaveCount(0);
  };
  const daemonSelection = async () => {
    const status = await page.request.get(new URL('/_/api/v1/status', page.url()).href);
    expect(status.ok()).toBe(true);
    return ((await status.json()) as { data: { activeDocumentId: string | null } }).data
      .activeDocumentId;
  };

  const reordered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/documents/order') && response.request().method() === 'PUT',
  );
  await row('C').press('Alt+ArrowUp');
  expect((await reordered).ok()).toBe(true);
  await expect(sidebar.locator('button[data-document-id]')).toHaveText([/^A/, /^C/, /^B/, /^D/]);
  await row('D').press('Enter');
  await expect(shown).toHaveText('D');
  await closeFromSidebar('D');
  // Removing from the list keeps the file.
  expect(existsSync(join(t.work, 'D.md'))).toBe(true);
  await expect(shown).toHaveText('C');
  await expect(page).toHaveURL(new RegExp(`[?&]document=${c}`));
  expect(await daemonSelection()).toBe(a);

  await closeFromSidebar('B');
  await expect(shown).toHaveText('C');
  await t.json(['open', 'D.md']);
  await expect(shown).toHaveText('C');
  await t.json(['focus', a!]);
  await t.json(['focus', c!]);
  await t.json(['close', c!]);
  await expect(shown).toHaveText('D');
  expect(await daemonSelection()).toBe(d);

  await closeFromSidebar('D');
  await expect(shown).toHaveText('A');
});

test('shows every heading even when the outline does not fit in one response', async ({ page }) => {
  // A document whose outline JSON exceeds the per-response limit (1MiB).
  const headings = Array.from(
    { length: 1500 },
    (_, index) => `## 見出し${String(index).padStart(4, '0')} ${'x'.repeat(380)}\n\n本文。\n`,
  );
  t.write('many.md', `# 多くの見出し\n\n${headings.join('\n')}`);
  await t.json(['open', 'many.md']);
  await page.goto(await t.uiUrl());
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
  await page.goto(await t.uiUrl());
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
  await page.goto(await t.uiUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  const middle = page.locator('article').getByRole('heading', { name: '中間の見出し' });
  await expect(middle).toBeAttached();
  await expect(middle).not.toBeInViewport();
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
  await page.goto(await t.uiUrl());
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
