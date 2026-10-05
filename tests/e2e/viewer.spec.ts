import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
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
  await page.goto(await t.bootstrapUrl());
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
  await page.goto(await t.bootstrapUrl());
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
