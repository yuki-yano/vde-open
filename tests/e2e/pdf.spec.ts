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
  await page.goto(await t.uiUrl());
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

test('Export PDF prints static HTML with its CSS, images, registered font and page rules', async ({
  page,
}) => {
  test.setTimeout(60_000);
  t.write('docs/images/chart.png', PNG);
  t.write(
    'docs/fonts/text.woff2',
    readFileSync(
      new URL(
        '../../apps/web/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
        import.meta.url,
      ),
    ),
  );
  t.write(
    'docs/css/main.css',
    '@import "print.css" print; @media screen { .print-only { display: none; } }',
  );
  t.write(
    'docs/css/print.css',
    '@font-face { font-family: saved; src: url(../fonts/text.woff2); } @page { size: 120mm 100mm; margin: 8mm; } @media print { .screen-only { display: none; } .print-only { display: block; font-family: saved; } .second { break-before: page; } }',
  );
  t.write(
    'docs/page.html',
    '<!doctype html><html lang="ja"><title>HTML資料</title><link rel="stylesheet" href="css/main.css"><h1>HTML文書</h1><p class="screen-only">SCREENONLY</p><p class="print-only">PRINTONLY</p><img src="images/chart.png"><p class="second">2ページ目の本文</p><script>document.body.innerHTML="SCRIPTCONTENT";</script></html>',
  );
  await t.json(['open', 'docs/page.html']);
  await page.goto(await t.uiUrl());
  await expect(page.getByTestId('html-mode')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('page.pdf');
  const pdf = readFileSync(await download.path());
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  expect(text).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+340\.\d+\s+282\.\d+\s*\]/);
  expect(text).toMatch(/\/Subtype\s*\/Image/);
  const fontNames = [...text.matchAll(/\/FontName\s*\/([^\s]+)/g)].map((match) => match[1]);
  expect(fontNames).toContainEqual(expect.stringMatching(/Geist/));
  const pages = pdfPageTexts(pdf);
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain('PRINTONLY');
  expect(pages[1]?.replace(/\s/g, '')).toContain('2ページ目の本文');
  expect(pages.join('')).not.toMatch(/SCREENONLY|SCRIPTCONTENT/);
  await expect(page.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
});

test('an interactive HTML document exports its saved source as static HTML', async ({ page }) => {
  test.setTimeout(60_000);
  t.write(
    'interactive.html',
    '<title>Interactive</title><h1>STATICCONTENT</h1><script>document.querySelector("h1").textContent="DYNAMICCONTENT";</script>',
  );
  await t.json(['open', 'interactive.html', '--html-mode', 'interactive']);
  await page.goto(await t.uiUrl());
  await expect(page.frameLocator('[data-testid="document-frame"]').locator('h1')).toHaveText(
    'DYNAMICCONTENT',
  );
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download = await downloading;
  const text = pdfPageTexts(readFileSync(await download.path())).join('');
  expect(text).toContain('STATICCONTENT');
  expect(text).not.toContain('DYNAMICCONTENT');
});
