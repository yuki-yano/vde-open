import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

const questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  fieldOrder: ['layout', 'comment'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      comment: { type: 'string', title: '修正したい点', maxLength: 4000 },
    },
    required: ['layout'],
    additionalProperties: false,
  },
};

// The title of the shown document (the viewer heading, which comes before the body's h1).
const heading = (page: Page) =>
  page.getByRole('region', { name: 'Document view' }).getByRole('heading', { level: 1 }).first();

test('UX-002: Cmd/Ctrl+K opens search, searches only open documents, and jumps; Escape closes and restores focus', async ({
  page,
}) => {
  t.write('alpha.md', '# 認証の設計\n\nsessionの期限は12時間。\n');
  t.write('beta.md', '# 検索の設計\n\n## 日本語の分割\n\n形態素ではなくIntl.Segmenterで分ける。\n');
  t.write('closed.md', '# 閉じた文書\n\nIntl.Segmenterの説明。\n');
  await t.json(['open', 'alpha.md', 'beta.md', 'closed.md']);
  await t.json(['close', 'closed.md']);
  await page.goto(await t.uiUrl());
  await expect(heading(page)).toHaveText('認証の設計');

  const opener = page.getByRole('button', { name: /Search open documents/ });
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Search open documents' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Only documents that are currently open are searched');
  const input = dialog.getByRole('textbox', { name: 'Search query' });
  await expect(input).toBeFocused();
  await input.fill('Segmenter');
  const results = dialog.getByRole('option');
  // Closed documents are not searched.
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('検索の設計');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(heading(page)).toHaveText('検索の設計');

  // Escape closes the dialog and returns focus to where it was before opening.
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("UX-002: jumps to the section of a search result, and while the revision to show cannot be loaded, does not jump to the previous revision's section", async ({
  page,
}) => {
  const filler = Array.from({ length: 150 }, (_, index) => `前置きの行${String(index)}`).join(
    '\n\n',
  );
  t.write('a.md', `# 文書\n\n${filler}\n\n## Old heading\n\n古い本文\n`);
  await t.json(['open', 'a.md']);
  await page.goto(await t.uiUrl());
  const oldHeading = page.getByRole('heading', { name: 'Old heading' });
  await expect(oldHeading).toBeAttached();
  await expect(oldHeading).not.toBeInViewport();

  const search = async (query: string) => {
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Search open documents' });
    await dialog.getByRole('textbox', { name: 'Search query' }).fill(query);
    await expect(dialog.getByRole('option')).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
  };
  // A result in the shown revision jumps to its section.
  await search('古い本文');
  await expect(oldHeading).toBeInViewport();
  await page
    .getByRole('region', { name: 'Document view' })
    .getByText('前置きの行0', { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(oldHeading).not.toBeInViewport();

  // Make the new revision's body unfetchable, then update the document. The view stays on the previous revision.
  await page.route(/\/_\/api\/v1\/documents\/[^/]+\/content/, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'E_INTERNAL', message: 'Failure for testing' },
      }),
    }),
  );
  t.write('a.md', `# 文書\n\n${filler}\n\n## NewHit heading\n\n新しい本文\n`);
  await page
    .getByRole('button', { name: 'Could not load document', exact: true })
    .click({ timeout: 10_000 });
  await expect(page.getByText('Failure for testing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();

  // Choosing a result from the new revision does not jump to the previous revision's section with the same number (Old heading).
  await search('NewHit');
  await page.getByTestId('section-target-notice').click();
  await expect(page.getByRole('dialog')).toContainText(
    'The revision to show could not be loaded, so the view did not jump to the section',
  );
  await expect(oldHeading).not.toBeInViewport();
});

test('UX-001 / UX-002: search, document switching, answering, and submitting work with the keyboard alone, and typed characters are not stolen', async ({
  page,
}) => {
  t.write('q.json', JSON.stringify(questionnaire));
  t.write('other.md', '# 別の文書\n\n本文\n');
  await t.json(['open', 'other.md']);
  const { request } = await t.json<{ request: { requestId: string } }>([
    'ask',
    'q.json',
    '--view',
    'other.md',
  ]);
  await page.goto(await t.uiUrl());
  const panel = page.getByRole('complementary', { name: 'Answer the question' });
  await expect(panel.getByRole('heading', { name: 'ログイン画面の確認' })).toBeVisible();

  // Options are chosen with arrow keys and Space inside the radio group.
  const radio = panel.getByRole('radio', { name: 'A', exact: true });
  await radio.focus();
  await page.keyboard.press('Space');
  await expect(radio).toBeChecked();
  // In text fields, characters such as k, j, and digits can be typed as they are (not stolen by single-key shortcuts).
  const comment = panel.getByRole('textbox', { name: '修正したい点' });
  await comment.focus();
  await page.keyboard.type('jk[]/ 123');
  await expect(comment).toHaveValue('jk[]/ 123');
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  // The submit button is reachable with Tab and pressed with Enter (Enter in a text field does not submit).
  const send = panel.getByRole('button', { name: 'Send answers to the agent' });
  await send.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    'Submitted. Waiting for the agent to retrieve it',
  );
  expect((await t.json<{ status: string }>(['feedback', 'get', request.requestId])).status).toBe(
    'submitted',
  );

  // Documents in the list are buttons selectable with the keyboard. The remove action has a name too.
  const list = page.getByRole('navigation', { name: 'Open documents' });
  await expect(list.getByRole('button', { name: /from the list/ }).first()).toBeVisible();
});

test('UX-003: on a narrow screen the list becomes a drawer, and a huge HTML does not cover the submit button', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  t.write('q.json', JSON.stringify(questionnaire));
  const tall = Array.from({ length: 3000 }, (_, index) => `<p>行${String(index)}</p>`).join('');
  t.write(
    'huge.html',
    `<!doctype html><html><body style="margin:0"><div style="position:fixed;inset:0;background:red;z-index:2147483647"></div>${tall}</body></html>`,
  );
  await t.json(['ask', 'q.json', '--view', 'huge.html']);
  await page.goto(await t.uiUrl());
  // The page does not overflow horizontally, and all header controls (list, search, color scheme) are on screen.
  await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const name of [
    'Document list',
    'Search open documents',
    'Light',
    'Dark',
    'Match OS setting',
  ]) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box, name).not.toBeNull();
    if (box) expect(box.x + box.width, name).toBeLessThanOrEqual(375);
  }
  // The list is a closed drawer. The button opens and closes it.
  const list = page.getByRole('navigation', { name: 'Open documents' });
  await expect(list).toBeHidden();
  await page.getByRole('button', { name: 'Document list' }).click();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: 'Document list' }).click();
  await expect(list).toBeHidden();

  const panel = page.getByRole('complementary', { name: 'Answer the question' });
  await panel.getByRole('radio', { name: 'B', exact: true }).click();
  const send = panel.getByRole('button', { name: 'Send answers to the agent' });
  await expect(send).toBeEnabled();
  // The submit button is outside the document view (iframe), so the HTML cannot cover it.
  const frame = await page.getByTestId('document-frame').boundingBox();
  const button = await send.boundingBox();
  expect(frame).not.toBeNull();
  expect(button).not.toBeNull();
  if (frame && button) expect(button.y).toBeGreaterThanOrEqual(frame.y + frame.height);
  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    'Submitted. Waiting for the agent to retrieve it',
  );
});

test("UX-004: view settings such as the color scheme stay in the browser, and open documents follow the daemon's state", async ({
  page,
}) => {
  t.write('a.md', '# A\n');
  t.write('b.md', '# B\n');
  await t.json(['open', 'a.md', 'b.md']);
  await page.goto(await t.uiUrl());
  const titles = page
    .getByRole('navigation', { name: 'Open documents' })
    .locator('[data-part="title"]');
  await expect(titles).toHaveText(['A', 'B']);
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  // A document closed from the CLI is gone from the list after reloading. The view setting remains.
  await t.json(['close', 'b.md']);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(titles).toHaveText(['A']);
});

test('UX-005: what cannot be shown is reported with the target, reason, and fix, and there is no button that widens permissions', async ({
  page,
}) => {
  t.write(
    'page.html',
    '<h1>表示の確認</h1><img src="https://example.com/a.png"><script>alert(1)</script><img src="missing.png">',
  );
  await t.json(['open', 'page.html']);
  await page.goto(await t.uiUrl());
  const diagnostics = page.getByTestId('render-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics).toContainText('https://example.com/a.png');
  await expect(diagnostics).toContainText('External URL');
  await expect(diagnostics).toContainText('reference it with a relative path to show it');
  await expect(diagnostics).toContainText('Removed 1 script');
  await expect(diagnostics).toContainText('missing.png');
  await expect(
    page.getByRole('button', { name: /allow all|allow everything|widen|more permissions/i }),
  ).toHaveCount(0);
});

test('PERF-002: with 1,000 documents, the list shows all of them, the last document can be selected and shown, and a save is reflected in the view', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const COUNT = 1000;
  for (let index = 0; index < COUNT; index += 1) {
    const name = String(index).padStart(4, '0');
    t.write(`docs/doc-${name}.md`, `# 文書${name}\n\n本文${name}\n`);
  }
  await t.json(['open', 'docs', '--recursive']);
  await page.goto(await t.uiUrl());
  const sidebar = page.getByRole('navigation', { name: 'Open documents' });
  await expect(
    sidebar.getByRole('heading', { name: `Open documents (${String(COUNT)})` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.locator('li')).toHaveCount(COUNT);

  // Selecting the last document shows it.
  const last = sidebar.getByRole('button', { name: '文書0999', exact: true });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(heading(page)).toHaveText('文書0999');
  await expect(page.getByText('本文0999')).toBeVisible();

  // Saving changes the shown body to the new revision. The list count does not change.
  t.write('docs/doc-0999.md', '# 文書0999\n\n保存した後の本文\n');
  await expect(page.getByText('保存した後の本文')).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.locator('li')).toHaveCount(COUNT);
});

test('code and the document path and ID can be copied (spec 13.2)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // What is copied is the shown code (without the newline before the closing fence).
  const code = 'const answer = 42;\nconsole.log(`answer: ${answer}`);';
  t.write('docs/code.md', `# コードの例\n\n\`\`\`ts\n${code}\n\`\`\`\n\n本文\n`);
  const opened = await t.json<{ documents: Array<{ documentId: string; displayPath: string }> }>([
    'open',
    'docs/code.md',
  ]);
  const document = opened.documents[0];
  if (!document) throw new Error('Could not open the document');
  await page.goto(await t.uiUrl());
  await expect(heading(page)).toHaveText('コードの例');
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const result = page.getByTestId('copy-result').filter({ hasText: /.+/ });
  const bodyTop = (await page.getByTestId('document-body').boundingBox())!.y;

  await page.getByRole('button', { name: 'Copy code' }).click();
  await expect(result.filter({ hasText: 'Copied the code.' })).toHaveCount(1);
  expect(await clipboard()).toBe(code);
  expect((await page.getByTestId('document-body').boundingBox())!.y).toBe(bodyTop);
  await expect(page.getByRole('button', { name: 'Copy code' })).toHaveAttribute(
    'data-copy-state',
    'copied',
  );

  await page.getByRole('button', { name: 'Copy document path' }).click();
  await expect(result.filter({ hasText: 'Copied the document path.' })).toHaveCount(1);
  expect(await clipboard()).toBe(document.displayPath);

  await page.getByRole('button', { name: 'Copy document ID' }).click();
  await expect(result.filter({ hasText: 'Copied the document ID.' })).toHaveCount(1);
  expect(await clipboard()).toBe(document.documentId);
  expect((await page.getByTestId('document-body').boundingBox())!.y).toBe(bodyTop);
});
