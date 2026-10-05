import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

const listWidth = (page: Page) =>
  page.locator('#document-list').evaluate((element) => element.getBoundingClientRect().width);

const drag = async (page: Page, by: number) => {
  const box = await page.getByRole('separator', { name: 'Resize document list' }).boundingBox();
  if (!box) throw new Error('The resize handle is not shown.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 10 });
  await page.mouse.up();
};

// Widening moves the pointer over the view. An HTML view is an iframe, which must not stop the drag.
for (const file of ['a.md', 'a.html']) {
  test(`the document list can be widened and narrowed by dragging (${file})`, async ({ page }) => {
    t.write(file, file.endsWith('.md') ? '# A\n\nbody\n' : '<h1>A</h1><p>body</p>');
    await t.json(['open', file]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(await t.bootstrapUrl());
    await expect(page.getByRole('region', { name: 'Document view' })).toBeVisible();
    if (file.endsWith('.html')) await expect(page.getByTestId('document-frame')).toBeVisible();
    const initial = await listWidth(page);
    await drag(page, 150);
    expect(await listWidth(page)).toBeCloseTo(initial + 150, -1);
    await drag(page, -100);
    expect(await listWidth(page)).toBeCloseTo(initial + 50, -1);
  });
}
