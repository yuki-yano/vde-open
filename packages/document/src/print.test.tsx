import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseMarkdownDocument } from './analysis.ts';
import { cssString, headerTitle, renderPrintDocument, type PrintInput } from './print.ts';
import { MarkdownView } from './react.tsx';

const SLOT = '0123456789abcdef0123456789abcdef';

const render = (source: string, overrides: Partial<PrintInput> = {}) =>
  renderPrintDocument({
    source,
    title: '設計メモ',
    documentLogicalPath: 'docs/design.md',
    images: [],
    imageSlot: SLOT,
    ...overrides,
  });

const bodyOf = (html: string) => html.slice(html.indexOf('<body>'));

describe('print document for the PDF export', () => {
  it('is one HTML document that loads nothing and carries the page header and footer', () => {
    const html = render('# 設計メモ\n\n本文です。\n');
    expect(html.startsWith('<!doctype html>\n<html lang="ja">')).toBe(true);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`,
    );
    expect(html).toContain('<title>設計メモ</title>');
    expect(html).toContain('size: A4;');
    expect(html).toContain('content: counter(page) " / " counter(pages);');
    expect(html).toContain(`content: ${cssString('設計メモ')};`);
    expect(html).toMatch(/<h1 id="h1">設計メモ<\/h1>/);
    expect(html).not.toMatch(/<script|<link|@import/i);
  });

  it('escapes the title so it can close neither the title, the CSS string nor the style element', () => {
    const title = '"; } </style><script>alert(1)</script> \\ <b>';
    const html = render('本文\n', { title });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</style><');
    expect(html).toContain(
      '<title>&#34;; } &#60;/style&#62;&#60;script&#62;alert(1)&#60;/script&#62; \\ &#60;b&#62;</title>',
    );
    expect(cssString(title)).toMatch(/^"[A-Za-z0-9 \\]*"$/);
    expect(cssString('A b')).toBe('"A b"');
    expect(cssString('"\n')).toBe('"\\22 \\a "');
  });

  it('shortens a long title in the page header and keeps it whole as the PDF title', () => {
    const title = 'あ'.repeat(160);
    expect(headerTitle(title)).toBe(`${'あ'.repeat(59)}…`);
    expect(headerTitle('短い題名')).toBe('短い題名');
    const html = render('本文\n', { title });
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`content: ${cssString(`${'あ'.repeat(59)}…`)};`);
  });

  it('puts only registered local images in image slots; others show their alt text', () => {
    const html = render(
      [
        '![図](images/flow.png)',
        '![同じ図](./images/flow.png "題")',
        '![未登録](images/missing.png)',
        '![外部](https://example.com/a.png)',
        '![上](../secret.png)',
        '',
      ].join('\n'),
      { images: ['docs/other.png', 'docs/images/flow.png'] },
    );
    expect(html).toContain(`<img src="${SLOT}-1" alt="図">`);
    expect(html).toContain(`<img src="${SLOT}-1" alt="同じ図" title="題">`);
    expect(html).toContain('<span class="blocked-image">[image: 未登録]</span>');
    expect(html).toContain('<span class="blocked-image">[image: 上]</span>');
    // External images are dropped at parse time (as in the management UI) and leave only their alt text.
    expect(html).not.toContain('example.com/a.png');
    expect(html.match(/<img /g)).toHaveLength(2);
  });

  it('keeps links within the document, http(s) and mailto; local documents and other schemes keep only their text', () => {
    const html = render(
      [
        '[節](#h2) [外部](https://example.com/doc "説明") [mail](mailto:a@example.com)',
        '[別の文書](other.md) [危険](javascript:alert(1)) [file](file:///etc/passwd) [空]()',
        '',
      ].join('\n'),
    );
    expect(html).toContain('<a href="#h2">節</a>');
    expect(html).toContain('<a href="https://example.com/doc" title="説明">外部</a>');
    expect(html).toContain('<a href="mailto:a@example.com">mail</a>');
    expect(html).toContain('別の文書');
    expect(html).not.toContain('other.md');
  });

  it('never emits an image source other than a slot or a link other than a heading, http(s) or mailto', () => {
    const hostile = [
      '![a](javascript:alert(1)) ![b](data:image/svg+xml,<svg onload=alert(1)>) ![c](//evil.example/x.png)',
      '![d](file:///etc/passwd) ![e](%2e%2e/x.png) ![f](images\\x.png)',
      '[a](javascript:alert(1)) [b](data:text/html,x) [c](//evil.example) [d](vbscript:x) [e](JAVASCRIPT:x)',
      '<img src="https://evil.example/x.png"> <a href="javascript:x">raw</a>',
      '',
    ].join('\n');
    const body = bodyOf(render(hostile, { images: ['docs/images/x.png'] }));
    for (const [, src] of body.matchAll(/<img [^>]*src="([^"]*)"/g)) {
      expect(src).toMatch(new RegExp(`^${SLOT}-\\d+$`));
    }
    for (const [, href] of body.matchAll(/<a [^>]*href="([^"]*)"/g)) {
      expect(href).toMatch(/^(#|https?:|mailto:)/i);
    }
    expect(body).not.toMatch(/<a [^>]*href="(?!#)/);
  });

  it('shows the same links and images as the management UI', () => {
    const source = [
      '[節](#h1) [外部](https://example.com/) [文書](other.md) [危険](javascript:x)',
      '![図](images/flow.png) ![未登録](images/missing.png)',
      '',
    ].join('\n');
    const ui = renderToStaticMarkup(
      <MarkdownView
        document={parseMarkdownDocument(source)}
        resolveImage={(src) => (src === 'images/flow.png' ? 'registered' : null)}
      />,
    );
    const print = bodyOf(render(source, { images: ['docs/images/flow.png'] }));
    const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs(print)).toEqual(hrefs(ui));
    expect(print.match(/<img /g)).toHaveLength(ui.match(/<img /g)?.length ?? 0);
    expect(print).toContain('[image: 未登録]');
    expect(ui).toContain('[image: 未登録]');
  });

  it('keeps a short code block on one page and lets a long one continue', () => {
    const short = '```ts\nconst a = 1;\n```\n';
    const long = `\`\`\`\n${Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n')}\n\`\`\`\n`;
    expect(render(short)).toMatch(
      /<div class="keep-together"><pre class="tm-code" data-lang="ts">/,
    );
    expect(render(short)).toContain('<span class="th-token th-keyword">const</span>');
    expect(render(long)).not.toContain('class="keep-together"');
    expect(render(long)).toContain('line 39');
  });

  it('escapes raw HTML', () => {
    const html = render('<script>alert(1)</script>\n');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('takes the language from kana or Hangul in the document, and leaves it out otherwise', () => {
    expect(render('# 設計メモ\n\nひらがなを含む本文\n')).toContain('<html lang="ja">');
    expect(render('# 설계\n\n한국어 본문\n')).toContain('<html lang="ko">');
    expect(render('# 设计\n\n中文正文\n')).toContain('<html>\n');
    // The middle dot and the prolonged sound mark are used outside Japanese too.
    expect(render('# 设计・说明\n\n中文正文ー\n')).toContain('<html>\n');
    expect(render('# Design\n\nEnglish text\n')).toContain('<html>\n');
  });

  it('refuses an image slot that is not random hexadecimal', () => {
    expect(() => render('本文\n', { imageSlot: '" onerror="x' })).toThrow();
  });
});
