import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;
test.beforeEach(() => {
  t = createE2eHome();
});
test.afterEach(async () => {
  await t.cleanup();
});

async function choosePalette(page: Page, value: string) {
  await page.getByRole('button', { name: 'Color palette', exact: true }).click();
  await page.getByRole('combobox', { name: 'Palette', exact: true }).selectOption(value);
  await page.getByRole('button', { name: 'Close details' }).click();
}

const palettes = [
  { value: 'standard', label: 'Standard', light: 'rgb(255, 255, 255)', dark: 'rgb(10, 10, 10)' },
  { value: 'github', label: 'GitHub', light: 'rgb(255, 255, 255)', dark: 'rgb(13, 17, 23)' },
  { value: 'gruvbox', label: 'Gruvbox', light: 'rgb(249, 245, 215)', dark: 'rgb(29, 32, 33)' },
  {
    value: 'catppuccin',
    label: 'Catppuccin',
    light: 'rgb(239, 241, 245)',
    dark: 'rgb(30, 30, 46)',
  },
  {
    value: 'github-high-contrast',
    label: 'GitHub High Contrast',
    light: 'rgb(255, 255, 255)',
    dark: 'rgb(1, 4, 9)',
  },
];

test('all palettes style the UI and Markdown in both modes and survive reloads', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  t.write(
    'theme.md',
    '# Theme preview\n\nRead the document and [open a link](https://example.com).\n\n> Supporting text\n\n| Item | Value |\n| --- | --- |\n| Palette | Preview |\n\n```ts\n// Code comment\nconst count: number = 42;\nfunction greet(name: string) { return "Hello " + name; }\n```\n',
  );
  await t.json(['open', 'theme.md']);
  await page.goto(await t.bootstrapUrl());
  const html = page.locator('html');
  const keyword = page.locator('pre .th-keyword').first();
  await expect(html).toHaveAttribute('data-color-palette', 'standard');
  await expect(keyword).toBeVisible();
  const keywordColors = new Set<string>();
  for (const palette of palettes) {
    await choosePalette(page, palette.value);
    await expect(html).toHaveAttribute('data-color-palette', palette.value);
    for (const mode of ['light', 'dark'] as const) {
      await page
        .getByRole('button', { name: mode === 'light' ? 'Light' : 'Dark', exact: true })
        .click();
      await expect(page.locator('body')).toHaveCSS('background-color', palette[mode]);
      await expect(page.locator('article')).toHaveCSS(
        'color',
        await page.locator('body').evaluate((element) => getComputedStyle(element).color),
      );
      keywordColors.add(await keyword.evaluate((element) => getComputedStyle(element).color));
      await page.reload();
      await expect(html).toHaveAttribute('data-color-palette', palette.value);
      await expect(page.locator('body')).toHaveCSS('background-color', palette[mode]);
      await expect(keyword).toBeVisible();
      for (const name of ['Search open documents', 'Color palette']) {
        await expect(page.getByRole('button', { name })).toHaveCSS(
          'color',
          await page.locator('body').evaluate((element) => getComputedStyle(element).color),
        );
      }
      if (testInfo.project.name === 'chromium') {
        await page.screenshot({ path: testInfo.outputPath(`${palette.value}-${mode}.png`) });
      }
    }
  }
  expect(keywordColors.size).toBeGreaterThanOrEqual(8);
});

test('palette and explicit mode are independent, while System follows OS changes', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  t.write('one.md', '# One\n');
  t.write('two.md', '# Two\n');
  t.write(
    'author.html',
    '<!doctype html><title>Author colors</title><body style="background:#123456;color:#ffffff"><h1>Author colors</h1></body>',
  );
  await t.json(['open', 'one.md', 'two.md', 'author.html']);
  await page.goto(await t.bootstrapUrl());
  const html = page.locator('html');
  await choosePalette(page, 'gruvbox');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/dark/);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(29, 32, 33)');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(html).not.toHaveClass(/dark/);
  await choosePalette(page, 'catppuccin');
  await expect(html).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Match OS setting' }).click();
  await expect(html).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).not.toHaveClass(/dark/);
  const documents = page.getByRole('navigation', { name: 'Open documents' });
  await documents.getByRole('button', { name: 'Two', exact: true }).click();
  await expect(page.locator('article')).toHaveText('Two');
  await expect(html).toHaveAttribute('data-color-palette', 'catppuccin');
  await documents.getByRole('button', { name: 'Author colors', exact: true }).click();
  const body = page.getByTestId('document-frame').contentFrame().locator('body');
  await expect(body).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await choosePalette(page, 'github-high-contrast');
  await expect(body).toHaveCSS('background-color', 'rgb(18, 52, 86)');
});

test('palette controls fit narrow screens and restore keyboard focus', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 700 });
  t.write('mobile.md', '# Narrow screen\n');
  await t.json(['open', 'mobile.md']);
  await page.goto(await t.bootstrapUrl());
  const trigger = page.getByRole('button', { name: 'Color palette', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  const select = page.getByRole('combobox', { name: 'Palette', exact: true });
  await select.focus();
  await select.selectOption('github-high-contrast');
  await expect(page.locator('html')).toHaveAttribute('data-color-palette', 'github-high-contrast');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const box = await select.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  if (testInfo.project.name === 'chromium') {
    await page.screenshot({ path: testInfo.outputPath('narrow-palette.png') });
  }
  await select.press('Escape');
  await expect(select).toBeHidden();
  await expect(trigger).toBeFocused();
  for (const name of [
    'Document list',
    'Search open documents',
    'Color palette',
    'Light',
    'Dark',
    'Match OS setting',
  ]) {
    const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  }
});
