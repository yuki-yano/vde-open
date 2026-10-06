import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';
import { pdfPageTexts } from './pdf-text.ts';

// Prints with the Google Chrome or Microsoft Edge installed on the machine (the CI runners have Chrome).
// A machine without either fails here rather than skipping.

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

// The title as Chrome writes it in the document information: UTF-16BE with a byte order mark, in hexadecimal.
function pdfTextHex(text: string): string {
  const units = Buffer.from(text, 'utf16le').swap16();
  return `FEFF${units.toString('hex').toUpperCase()}`;
}

test('Export PDF saves the shown Markdown as a PDF without a print dialog', async ({ page }) => {
  test.setTimeout(60_000);
  const title = '四半期レポート';
  const sections = Array.from(
    { length: 12 },
    (_, index) =>
      `## 節 ${String(index + 1)}\n\n${'本文の段落です。読みやすい資料として印刷されることを確かめます。'.repeat(8)}\n`,
  ).join('\n');
  t.write('docs/images/chart.png', PNG);
  t.write('docs/report.md', `# ${title}\n\n![グラフ](images/chart.png)\n\n${sections}`);
  await t.json(['open', 'docs/report.md']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.locator('article h1')).toHaveText(title);

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('report.pdf');
  const pdf = readFileSync(await download.path());
  const text = pdf.toString('latin1');

  expect(text.startsWith('%PDF-')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  // A4 pages, more than one, with an outline (bookmarks) from the headings, the title, and the registered image.
  expect(text).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+594\.9\d*\s+841\.9\d*\s*\]/);
  expect(text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(text).toContain('/Outlines');
  expect(text).toContain(`/Title <${pdfTextHex(title)}>`);
  expect(text).toMatch(/\/Subtype\s*\/Image/);
  // Every page has the document title in its header and "n / N" in its footer, and the body is text.
  const pages = pdfPageTexts(pdf).map((pageText) => pageText.replace(/\s/g, ''));
  pages.forEach((pageText, index) => {
    expect(pageText).toContain(title);
    expect(pageText).toContain(`${String(index + 1)}/${String(pages.length)}`);
  });
  expect(pages.join('')).toContain('読みやすい資料として印刷されることを確かめます。');
  await expect(page.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
});

test('Export PDF is offered only for Markdown documents', async ({ page }) => {
  t.write('page.html', '<!doctype html><title>HTML</title><h1>HTML文書</h1>');
  await t.json(['open', 'page.html']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.getByTestId('html-mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export PDF' })).toHaveCount(0);
});
