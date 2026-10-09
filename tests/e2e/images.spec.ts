import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;
test.beforeEach(() => {
  t = createE2eHome();
});
test.afterEach(async () => {
  await t.cleanup();
});

test('opens native image formats directly and restores the selected image after reload', async ({
  page,
}) => {
  const formats = ['png', 'apng', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];
  for (const ext of formats)
    t.write(
      `sample.${ext}`,
      readFileSync(new URL(`../fixtures/images/sample.${ext}`, import.meta.url)),
    );
  await t.json(['open', ...formats.map((ext) => `sample.${ext}`)]);
  await page.goto(await t.uiUrl());
  for (const ext of formats) {
    await page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: `sample.${ext}`, exact: true })
      .click();
    const image = page.getByRole('img', { name: `sample.${ext}`, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'sample.svg', exact: true })).toBeVisible();
  await expect(page.getByTestId('document-image')).toBeVisible();
});

test('fits large images, shows original dimensions, and respects paused and automatic updates', async ({
  page,
}) => {
  t.write(
    'drawing.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="tomato"/></svg>',
  );
  await t.json(['drawing.svg']);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(await t.uiUrl());
  const image = page.getByTestId('document-image');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2400);
  const viewport = page.getByTestId('image-viewport');
  const viewportBox = (await viewport.boundingBox())!;
  const fitBox = (await image.boundingBox())!;
  expect(fitBox.width).toBeLessThanOrEqual(viewportBox.width);
  expect(fitBox.height).toBeLessThanOrEqual(viewportBox.height);
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())?.width).toBe(2400);
  expect(await viewport.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await page.getByRole('button', { name: 'Pause updates', exact: true }).click();
  const pinned = await image.getAttribute('src');
  t.atomicWrite(
    'drawing.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/></svg>',
  );
  await expect(page.getByText('Update available', { exact: true })).toBeVisible();
  await expect(image).toHaveAttribute('src', pinned!);
  await page.getByRole('button', { name: 'Resume updates', exact: true }).click();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(400);
  t.atomicWrite(
    'drawing.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"/>',
  );
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(200);
});

test('reports an undecodable image and allows switching to another document', async ({ page }) => {
  t.write('broken.png', 'not an image');
  t.write('notes.md', '# Notes\n\nReadable document\n');
  await t.json(['open', 'broken.png', 'notes.md']);
  await page.goto(await t.uiUrl());
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', { name: 'broken.png', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('This browser could not display the image');
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', { name: 'Notes', exact: true })
    .click();
  await expect(page.getByTestId('document-body')).toContainText('Readable document');
});

test('keeps scripts and external references in SVG images from running or loading', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://image.invalid/')) external.push(request.url());
  });
  t.write(
    'hostile.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><script>fetch("https://image.invalid/script")</script><image href="https://image.invalid/tracker.png" width="32" height="24"/><rect width="32" height="24" fill="green"/></svg>',
  );
  await t.json(['hostile.svg']);
  await page.goto(await t.uiUrl());
  const image = page.getByTestId('document-image');
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 32))
    .toBe(true);
  await page.reload();
  await expect(image).toBeVisible();
  expect(external).toEqual([]);
});
