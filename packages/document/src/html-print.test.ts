import { describe, expect, it } from 'vitest';

import { renderHtmlPrintDocument, type HtmlPrintInput } from './html-print.ts';

const SLOT = '0123456789abcdef0123456789abcdef';
const input: HtmlPrintInput = {
  source: '',
  title: '資料',
  documentLogicalPath: 'docs/page.html',
  assetSlot: SLOT,
  assets: [
    { logicalPath: 'docs/css/main.css', role: 'style' },
    { logicalPath: 'docs/css/print.css', role: 'style' },
    { logicalPath: 'docs/images/chart.svg', role: 'svg' },
    { logicalPath: 'docs/fonts/text.woff2', role: 'font' },
  ],
  stylesheets: [
    {
      logicalPath: 'docs/css/main.css',
      text: '@import "print.css" print; @font-face { font-family: text; src: url(../fonts/text.woff2); } .chart { background: url(../images/chart.svg?v=1#chart); }',
    },
    {
      logicalPath: 'docs/css/print.css',
      text: '@import "main.css"; @page { size: A5 landscape; margin: 4mm; }',
    },
  ],
};

describe('static HTML print document', () => {
  it('preserves author CSS, imports, print media, language and a title while mapping only registered assets', () => {
    const output = renderHtmlPrintDocument({
      ...input,
      source:
        '<html lang="ja"><head class="original"><link rel="stylesheet" href="css/main.css"><style>@media print { p { color: red; } }</style></head><body><h1>資料</h1><img src="images/chart.svg?v=1#chart" srcset="images/chart.svg 2x, missing.png 1x"><p style="background:url(images/chart.svg)">本文</p></body></html>',
    });
    expect(output.html).toContain('<html lang="ja">');
    expect(output.html).toContain('<head class="original"><meta charset="utf-8">');
    expect(output.html).toContain('<title>資料</title>');
    expect(output.html).toContain('href="asset-0.css"');
    expect(output.html).toContain(`src="${SLOT}-2#chart"`);
    expect(output.html).toContain(`srcset="${SLOT}-2 2x"`);
    expect(output.html).toContain('@media print');
    expect(output.stylesheets[0]?.css).toMatch(/@import "asset-1\.css"\s*print/);
    expect(output.stylesheets[0]?.css).toContain(`url(${SLOT}-3)`);
    expect(output.stylesheets[0]?.css).toContain(`url(${SLOT}-2#chart)`);
    expect(output.stylesheets[1]?.css).toContain('@import "asset-0.css"');
    expect(output.stylesheets[1]?.css).toContain('@page{size:A5 landscape;margin:4mm}');
    expect(output.html).not.toContain('missing.png');
    expect(output.html).not.toContain('?v=1');
  });

  it('removes executable content, local files, external fetches, base and navigation using the static view rules', () => {
    const output = renderHtmlPrintDocument({
      ...input,
      source:
        '<base href="file:///etc/"><meta http-equiv="refresh" content="0;url=https://example.com"><meta http-equiv="Content-Security-Policy" content="default-src *"><script>alert(1)</script><iframe srcdoc="secret"></iframe><h1 onclick="alert(1)">本文</h1><img src="file:///etc/passwd"><img src="https://example.com/a.png"><link rel="stylesheet" href="https://example.com/a.css"><style>@import "file:///etc/passwd"; p { background:url(https://example.com/); }</style><a href="file:///secret.html">秘密</a>',
    });
    expect(output.html).not.toMatch(
      /<script|<iframe|<base|onclick|refresh|example\.com|file:\/\/\/|secret\.html|default-src \*/,
    );
    expect(output.html).toContain(
      "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' file:",
    );
    expect(output.html).toContain('本文');
  });

  it('escapes a missing title and places default page rules before author rules', () => {
    const output = renderHtmlPrintDocument({
      ...input,
      title: '</title><script>x</script>',
      source: '<style>@page { size: A6; }</style><p>本文</p>',
    });
    expect(output.html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(output.html.indexOf('size: A4')).toBeLessThan(output.html.indexOf('size:A6'));
    expect(output.html).not.toContain('<script>');
    expect(() => renderHtmlPrintDocument({ ...input, assetSlot: '" onerror="x' })).toThrow();
  });
});
