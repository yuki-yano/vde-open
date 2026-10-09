import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;
test.beforeEach(() => {
  t = createE2eHome();
});
test.afterEach(async () => {
  await t.cleanup();
});

test('a copy failure stays at its button, can be read and retried with the keyboard, and never moves the document', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('Clipboard permission denied'))
            : Promise.resolve();
        },
      },
    });
  });
  t.write('note.md', '# Note\n\nContent\n');
  await t.json(['open', 'note.md']);
  await page.goto(await t.uiUrl());
  const body = page.getByTestId('document-body');
  await expect(page.locator('article h1')).toHaveText('Note');
  const before = (await body.boundingBox())!;
  const copy = page.getByRole('button', { name: 'Copy document ID', exact: true });
  await expect(copy).toHaveAttribute('aria-haspopup', 'false');
  await copy.press('Enter');
  await expect(copy).toHaveAttribute('data-copy-state', 'failed');
  await expect(copy).toHaveAttribute('aria-haspopup', 'dialog');
  expect((await body.boundingBox())!.y).toBe(before.y);
  await copy.press('Space');
  const details = page.getByRole('dialog', { name: 'Copy failed' });
  await expect(details).toContainText('Clipboard permission denied');
  await details.getByRole('button', { name: 'Try again' }).press('Enter');
  await expect(copy).toHaveAttribute('data-copy-state', 'copied');
  await expect(details).toHaveCount(0);
  await expect(copy).toBeFocused();
  expect((await body.boundingBox())!.y).toBe(before.y);
});

test('a PDF export failure uses the export button for details and dismissal without adding a banner', async ({
  page,
}) => {
  t.write('note.md', '# Note\n\nContent\n');
  await t.json(['open', 'note.md']);
  await page.goto(await t.uiUrl());
  await expect(page.locator('article h1')).toHaveText('Note');
  const body = page.getByTestId('document-body');
  const top = (await body.boundingBox())!.y;
  await page.route(/\/_\/api\/v1\/documents\/[^/]+\/pdf/, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'E_EXPORT_FAILED', message: 'failed', details: { reason: 'timeout' } },
      }),
    }),
  );
  const exporting = page.getByRole('button', { name: 'Export PDF', exact: true });
  await exporting.click();
  await expect(page.getByRole('alert')).toContainText('did not finish printing');
  expect((await body.boundingBox())!.y).toBe(top);
  await exporting.press('Enter');
  const details = page.getByRole('dialog', { name: 'PDF export failed' });
  await expect(details).toContainText('did not finish printing');
  await details.getByRole('button', { name: 'Dismiss' }).click();
  await expect(details).toHaveCount(0);
  await expect(exporting).toBeFocused();
  expect((await body.boundingBox())!.y).toBe(top);
});
