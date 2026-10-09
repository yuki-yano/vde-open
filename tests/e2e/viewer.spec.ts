import { expect, firefox, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

test('Markdown width expands, persists across documents and reloads, and applies only to previews', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  t.write('first.md', '# Width settings\n\nDocument content\n');
  t.write('second.md', '# Another Markdown\n\nMore content\n');
  t.write('page.html', '<!doctype html><title>HTML document</title><h1>HTML document</h1>');
  await t.json(['open', 'first.md', 'second.md', 'page.html']);
  await page.goto(await t.uiUrl());
  const article = page.locator('article');
  const wide = page.getByRole('button', { name: 'Wide view', exact: true });
  await expect(article).toHaveCSS('max-width', '960px');
  await expect(wide).toHaveAttribute('aria-pressed', 'false');
  const standardWidth = (await article.boundingBox())!.width;
  await wide.click();
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  expect((await article.boundingBox())!.width).toBeGreaterThan(standardWidth + 200);
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', {
      name: 'Another Markdown',
      exact: true,
    })
    .click();
  await expect(article).toContainText('More content');
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(wide).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  await wide.focus();
  await wide.press('Space');
  await expect(wide).toHaveAttribute('aria-pressed', 'false');
  await expect(article).toHaveCSS('max-width', '960px');
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', {
      name: 'HTML document',
      exact: true,
    })
    .click();
  await expect(page.getByTestId('document-frame')).toBeVisible();
  await expect(wide).toHaveCount(0);
});

test('Markdown tables keep readable columns and scroll by keyboard without widening the page', async ({
  page,
}) => {
  const description = '表示領域が狭い場合でも説明文を読める列幅で表示します。'.repeat(8);
  const token = 'very_long_identifier_'.repeat(30);
  t.write(
    'table.md',
    [
      '# 表の表示',
      '',
      '| 項目 | 内容 | 実装箇所 | 担当者 | 状態 | 確認方法 |',
      '| --- | --- | --- | --- | --- | --- |',
      `| Markdownの幅 | ${description} | \`${token}\` | 開発担当 | 対応済み | ブラウザで表示を確認 |`,
      '',
      '| 少ない列 | 数値 |',
      '| ---: | :---: |',
      '| 右揃え | 123 |',
      '',
    ].join('\n'),
  );
  await t.json(['open', 'table.md']);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(await t.uiUrl());
  const viewport = page.getByRole('region', { name: 'Scrollable table' }).first();
  await expect(viewport).toBeVisible();
  const table = viewport.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveCount(6);
  const widths = await table
    .locator('th')
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(128);
  const cells = table.locator('td');
  expect((await cells.nth(1).boundingBox())!.width).toBeLessThanOrEqual(449);
  expect((await cells.nth(2).boundingBox())!.width).toBeLessThanOrEqual(449);
  expect(await viewport.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
    await viewport.evaluate((element) => element.clientWidth),
  );
  await viewport.focus();
  await viewport.press('ArrowRight');
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await viewport.press('ArrowLeft');
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
  for (const width of [480, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(
      await page
        .getByTestId('document-body')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBe(0);
  }
  await page.getByRole('button', { name: 'Wide view', exact: true }).click();
  expect(
    await page
      .getByTestId('document-body')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBe(0);
  const alignedTable = page.getByRole('table').last();
  expect((await alignedTable.boundingBox())!.width).toBeLessThan(
    (await page.locator('article').boundingBox())!.width,
  );
  await expect(alignedTable.locator('td').first()).toHaveCSS('text-align', 'right');
  await expect(alignedTable.locator('td').last()).toHaveCSS('text-align', 'center');
});

test('outline resizing captures drags across the HTML iframe, stops on release, and persists after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  t.write(
    'outline.html',
    '<!doctype html><html><head><title>Resizable outline</title></head><body><h1>Resizable outline</h1><p>Document content</p></body></html>',
  );
  await t.json(['open', 'outline.html']);
  await page.goto(await t.uiUrl());
  const outline = page.getByRole('complementary', { name: 'Outline', exact: true });
  const handle = page.getByRole('separator', { name: 'Resize outline', exact: true });
  await expect(handle).toBeVisible();
  await expect(outline).toHaveCSS('width', '240px');
  const frame = page.getByTestId('document-frame');
  await expect(
    page.frameLocator('[data-testid="document-frame"]').getByText('Document content'),
  ).toBeVisible();
  const frameUrl = await frame.getAttribute('src');
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 5 });
  await expect(outline).toHaveCSS('width', '340px');
  await page.mouse.up();
  await page.mouse.move(x - 180, y);
  await expect(outline).toHaveCSS('width', '340px');
  await expect(frame).toHaveAttribute('src', frameUrl!);
  await page.reload();
  await expect(outline).toHaveCSS('width', '340px');
});

test('outline resizing supports keys, protects the document beside an answer panel, and hides on narrow screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  t.write('outline.md', '# Resizable outline\n\nDocument content\n');
  t.write(
    'question.json',
    JSON.stringify({
      schemaVersion: 1,
      title: 'Review',
      fieldOrder: ['answer'],
      answerSchema: {
        type: 'object',
        properties: { answer: { type: 'string', title: 'Answer', enum: ['Yes', 'No'] } },
        required: ['answer'],
        additionalProperties: false,
      },
    }),
  );
  await t.json(['ask', 'question.json', '--view', 'outline.md']);
  await page.goto(await t.uiUrl());
  const outline = page.getByRole('complementary', { name: 'Outline', exact: true });
  const handle = page.getByRole('separator', { name: 'Resize outline', exact: true });
  await expect(handle).toBeVisible();
  await handle.press('Home');
  await expect(outline).toHaveCSS('width', '160px');
  await handle.press('ArrowLeft');
  await expect(outline).toHaveCSS('width', '176px');
  await handle.press('ArrowRight');
  await expect(outline).toHaveCSS('width', '160px');
  await handle.press('End');
  await expect(outline).toHaveCSS('width', '480px');
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(async () => (await outline.boundingBox())?.width ?? 0).toBeLessThan(480);
  expect((await page.getByTestId('document-body').boundingBox())!.width).toBeGreaterThanOrEqual(
    240,
  );
  await expect(page.getByRole('complementary', { name: 'Answer the question' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1100);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(outline).toHaveCSS('width', '480px');
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(handle).toBeHidden();
  await expect(outline).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
});

test('switching Markdown keeps the current preview until the next one is ready, without showing source or loading placeholders', async ({
  page,
}) => {
  t.write('first.md', '# First\n\n**original**\n');
  t.write('second.md', '# Second\n\n**replacement**\n');
  const opened = await t.json<{ documents: Array<{ documentId: string }> }>([
    'open',
    'first.md',
    'second.md',
  ]);
  await page.goto(await t.uiUrl());
  await expect(page.locator('article strong')).toHaveText('original');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(`**/documents/${opened.documents[1]!.documentId}/content?*`, async (route) => {
    requested = true;
    await gate;
    await route.continue();
  });
  // Observe the surface at each animation frame, including the asynchronous parse after the HTTP response.
  await page.evaluate(() => {
    const observation = { stopped: false, phases: [] as string[] };
    (window as unknown as { switchObservation: typeof observation }).switchObservation =
      observation;
    const sample = () => {
      if (observation.stopped) return;
      const surface = document.querySelector(
        '[data-testid="document-workspace"][aria-hidden="false"]',
      );
      observation.phases.push(
        surface?.querySelector('article strong')?.textContent ?? 'intermediate',
      );
      requestAnimationFrame(sample);
    };
    sample();
  });
  try {
    await page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: 'Second', exact: true })
      .click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('article:visible strong')).toHaveText('original');
    await expect(page.locator('pre:visible')).toHaveCount(0);
    release();
    await expect(page.locator('article:visible strong')).toHaveText('replacement');
    const phases = await page.evaluate(() => {
      const observation = (
        window as unknown as { switchObservation: { stopped: boolean; phases: string[] } }
      ).switchObservation;
      observation.stopped = true;
      return observation.phases;
    });
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every((phase) => phase === 'original' || phase === 'replacement')).toBe(true);
    await expect(page.getByTestId('document-workspace')).toHaveCount(1);
  } finally {
    release();
  }
});

test('switching to HTML keeps the previous document until its iframe response loads, then reveals the prepared iframe', async ({
  page,
}) => {
  t.write('first.md', '# First\n\noriginal\n');
  t.write(
    'second.html',
    '<!doctype html><html><head><title>Second</title></head><body><p>replacement</p></body></html>',
  );
  await t.json(['open', 'first.md', 'second.html']);
  await page.goto(await t.uiUrl());
  await expect(page.locator('article')).toContainText('original');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/r/*/files/second.html', async (route) => {
    requests += 1;
    await gate;
    await route.continue();
  });
  try {
    await page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: 'Second', exact: true })
      .click();
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator('article:visible')).toContainText('original');
    const frame = page.getByTestId('document-frame');
    await expect(frame).toBeHidden();
    await frame.evaluate((element) => {
      element.setAttribute('data-prepared', 'yes');
    });
    release();
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('data-prepared', 'yes');
    await expect(page.frameLocator('[data-testid="document-frame"]').locator('p')).toHaveText(
      'replacement',
    );
    await expect(page.locator('article')).toHaveCount(0);
    expect(requests).toBe(1);
  } finally {
    release();
  }
});

test('P2 gate: a document opened from the CLI is shown in the UI, and additions and saves are reflected as they happen', async ({
  page,
}) => {
  t.write('a.md', '# 最初の文書\n\n本文です。\n');
  await t.json(['open', 'a.md']);
  await page.goto(await t.uiUrl());

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

test('the same document URL opens in another browser without authentication', async ({
  page,
  browser,
  browserName,
}) => {
  const filler = Array.from({ length: 100 }, (_, index) => `Paragraph ${String(index)}\n\n`).join(
    '',
  );
  t.write('a.md', `# a\n\n${filler}## Details\nShared content\n`);
  await t.json(['open', 'a.md']);
  const url = await t.uiUrl();
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Open documents' })).toBeVisible();
  await expect(page.locator('article')).toContainText('Shared content');
  await page
    .getByRole('complementary', { name: 'Outline' })
    .getByRole('button', { name: 'Details' })
    .click();
  await expect(page).toHaveURL(/[?&]heading=Details/);
  const documentUrl = new URL(page.url());
  // Chromium hands the very same URL to Firefox; other projects use a fresh isolated context.
  const secondBrowser = browserName === 'chromium' ? await firefox.launch() : null;
  const secondContext = await (secondBrowser ?? browser).newContext();
  try {
    const second = await secondContext.newPage();
    const apiRequests: Array<{ path: string; authorization: string | undefined }> = [];
    second.on('request', (request) => {
      if (request.url().includes('/_/api/v1/'))
        apiRequests.push({
          path: new URL(request.url()).pathname,
          authorization: request.headers()['authorization'],
        });
    });
    await second.goto(documentUrl.href);
    await expect(second.locator('article')).toContainText('Shared content');
    expect(new URL(second.url()).searchParams.get('document')).toBe(
      documentUrl.searchParams.get('document'),
    );
    await expect(second.getByRole('heading', { name: 'Details', exact: true })).toBeInViewport();
    expect(new URL(second.url()).searchParams.get('heading')).toBe('Details');
    await second.reload();
    await expect(second.locator('article')).toContainText('Shared content');
    await expect(second.getByRole('heading', { name: 'Details', exact: true })).toBeInViewport();
    expect(await second.evaluate(() => sessionStorage.getItem('vde-open.session'))).toBeNull();
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(apiRequests.every((request) => request.authorization === undefined)).toBe(true);
    expect(apiRequests.some((request) => request.path.includes('/sessions'))).toBe(false);
  } finally {
    await secondContext.close();
    await secondBrowser?.close();
  }
  const response = await page.request.get(url);
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
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
  await page.goto(await t.uiUrl());
  await expect(page.locator('article')).toContainText('window.vdeExecuted');
  expect(
    await page.evaluate(() => (window as unknown as { vdeExecuted?: string }).vdeExecuted),
  ).toBeUndefined();
  await expect(page.locator('article script')).toHaveCount(0);
  await expect(page.locator('article img')).toHaveCount(0);
  await expect(page.locator('article a[href^="javascript:"]')).toHaveCount(0);
});
