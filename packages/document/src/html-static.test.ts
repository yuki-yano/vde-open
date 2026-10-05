import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';

import { analyzeHtml, ParseLimitError } from './analysis.ts';
import { scanHtmlReferences, transformStaticHtml } from './html-static.ts';
import type { AssetRole } from './references.ts';

type HtmlNode = DefaultTreeAdapterMap['node'];

interface Found {
  tags: string[];
  attributes: string[];
  foreign: number;
}

// Re-parse the output with the browser's rules and collect the remaining elements and attributes.
function inspect(html: string): Found {
  const found: Found = { tags: [], attributes: [], foreign: 0 };
  const stack: HtmlNode[] = [parse(html, { scriptingEnabled: false })];
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if ('tagName' in node) {
      found.tags.push(node.tagName);
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') found.foreign += 1;
      for (const attribute of node.attrs) found.attributes.push(attribute.name);
      if ('content' in node) stack.push(node.content);
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  return found;
}

function render(source: string, assets: Record<string, AssetRole> = {}, path = 'index.html') {
  return transformStaticHtml({
    source,
    documentLogicalPath: path,
    assets: new Map(Object.entries(assets)),
  });
}

const codes = (result: ReturnType<typeof render>) =>
  result.diagnostics.map((diagnostic) => diagnostic.code).toSorted();

function assertInert(html: string): void {
  const found = inspect(html);
  for (const tag of [
    'script',
    'iframe',
    'object',
    'embed',
    'base',
    'frame',
    'portal',
    'svg',
    'math',
  ]) {
    expect(found.tags, tag).not.toContain(tag);
  }
  expect(found.foreign).toBe(0);
  expect(found.attributes.filter((name) => name.startsWith('on'))).toEqual([]);
  for (const name of [
    'srcdoc',
    'ping',
    'target',
    'action',
    'formaction',
    'download',
    'http-equiv',
  ]) {
    expect(found.attributes, name).not.toContain(name);
  }
}

describe('SEC-005 removal of executed content', () => {
  it('removes scripts, event attributes, embeds, and inline SVG and MathML, and records the reasons', () => {
    const result = render(`<!doctype html><html><head><title>t</title>
      <script>window.pwned = 1</script><script src="app.js"></script></head>
      <body onload="pwn()"><h1 id="t" onclick="pwn()">見出し</h1>
      <img src="x.png" onerror="pwn()">
      <svg><script>pwn()</script><circle onload="pwn()"/></svg>
      <math><mi xlink:href="javascript:pwn()">x</mi></math>
      <iframe src="https://evil.example/"></iframe><iframe srcdoc="<script>pwn()</script>"></iframe>
      <object data="evil.swf"></object><embed src="evil.swf"><applet code="x"></applet>
      <p>本文</p></body></html>`);
    assertInert(result.html);
    expect(result.html).toContain('<h1 id="t">見出し</h1>');
    expect(result.html).toContain('<p>本文</p>');
    expect(result.html).not.toContain('pwn');
    expect(codes(result)).toEqual(
      [
        'asset-not-registered',
        'asset-not-registered',
        'embed-removed',
        'event-handler-removed',
        'inline-svg-removed',
        'mathml-removed',
        'script-removed',
      ].toSorted(),
    );
    expect(result.diagnostics.find((entry) => entry.code === 'script-removed')?.count).toBe(2);
    expect(result.diagnostics.find((entry) => entry.code === 'embed-removed')?.count).toBe(5);
  });

  it('treats the contents of noscript as ordinary elements and removes executed content inside them too', () => {
    const result = render(
      '<noscript><img src=x onerror=pwn()><iframe src="//evil.example"></iframe><p>代替の文</p></noscript>',
    );
    assertInert(result.html);
    expect(result.html).toContain('<p>代替の文</p>');
    expect(result.html).not.toContain('noscript');
    expect(result.html).not.toContain('pwn');
  });

  it('leaves no executed content even inside template or with inputs that exploit parsing rule differences', () => {
    const sources = [
      '<template shadowrootmode="open"><script>pwn()</script><p onclick="pwn()">t</p></template>',
      '<style><!--</style><img src=x onerror=pwn()>--></style>',
      '<svg><style><img src=x onerror=pwn()></style></svg>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=pwn()&gt;">',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=pwn()>',
      '<p title="</p><script>pwn()</script>">x</p>',
      '<textarea></textarea><script>pwn()</script>',
      '<title></title><script>pwn()</script>',
      '<xmp><script>pwn()</script></xmp><img src=x onerror=pwn()>',
      '<plaintext><script>pwn()</script>',
      '<a href="x" onmouseover=pwn() ONCLICK=pwn()>a</a>',
      '<div on-click="x" o="1" onx>d</div>',
      '<!--<script>pwn()</script>--><!--[if IE]><script>pwn()</script><![endif]-->',
      '<img src=x one="1" onerror="pwn()" / onload=pwn()>',
      '<p <script>pwn()</script>>x</p>',
    ];
    for (const source of sources) {
      const result = render(source);
      assertInert(result.html);
      // Transforming the output again finds nothing left to remove.
      const again = render(result.html);
      expect(inspect(again.html).tags, source).toEqual(inspect(result.html).tags);
    }
  });

  it('a document with more elements than the limit is an error instead of being transformed', () => {
    expect(() => render('<p>x</p>'.repeat(60_000))).toThrow(ParseLimitError);
  });
});

describe('SEC-006 removal of automatic navigation and external requests', () => {
  it('removes meta refresh, base, iframe, ping, resource hints and form targets', () => {
    const result = render(`<html><head>
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <meta http-equiv="Content-Security-Policy" content="script-src *">
      <meta name="referrer" content="unsafe-url"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <base href="https://evil.example/">
      <link rel="prefetch" href="https://evil.example/p"><link rel="dns-prefetch" href="//evil.example">
      <link rel="preconnect" href="https://evil.example"><link rel="preload" href="https://evil.example/x.js" as="script">
      <link rel="icon" href="https://evil.example/favicon.ico"><link rel="manifest" href="https://evil.example/m.json">
      </head><body>
      <a href="https://evil.example/" ping="https://evil.example/ping" target="_blank" download>外部</a>
      <form action="https://evil.example/post" method="post" target="_top"><input name="q"><button formaction="https://evil.example/2">送信</button></form>
      <img src="https://evil.example/beacon.png" attributionsrc="https://evil.example/attr" referrerpolicy="unsafe-url" crossorigin="use-credentials">
      <video src="https://evil.example/v.mp4" poster="https://evil.example/p.png" autoplay></video>
      <audio src="https://evil.example/a.mp3"></audio>
      <div style="background:url(https://evil.example/bg.png)" background="https://evil.example/b.png">x</div>
      <input autofocus>
      </body></html>`);
    assertInert(result.html);
    expect(result.html).not.toContain('evil.example');
    expect(result.html).toContain('<meta charset="utf-8">');
    expect(result.html).toContain('<meta name="viewport"');
    // Form controls are kept for display only.
    expect(result.html).toContain('<input name="q">');
    expect(inspect(result.html).attributes).not.toContain('autofocus');
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'meta-refresh-removed',
        'base-removed',
        'network-hint-removed',
        'form-action-removed',
        'remote-asset-blocked',
        'media-blocked',
        'link-disabled',
      ]),
    );
  });

  it('disables links, lists them, and keeps only in-document navigation', () => {
    const result = render(`<a href="#sec">文書内</a>
      <a href="https://example.com/a">  外部の
        ページ </a><a href="mailto:a@example.com">mail</a>
      <a href="../other/b.md#x">隣の文書</a><a href="/docs/c.html">rootからの文書</a>
      <a href="javascript:pwn()">js</a><a href="file:///etc/passwd">file</a><a href="a.png">画像</a>
      <a href="https://example.com/a">同じ行き先</a>
      <map><area href="https://example.com/area" alt="a"></map>`);
    expect(result.html).toContain('<a href="#sec">文書内</a>');
    expect(inspect(result.html).attributes.filter((name) => name === 'href')).toHaveLength(1);
    expect(result.html).not.toContain('javascript');
    expect(result.links).toEqual([
      {
        linkId: 'lnk_0001',
        href: 'https://example.com/a',
        text: '外部の ページ',
        kind: 'external',
      },
      { linkId: 'lnk_0002', href: 'mailto:a@example.com', text: 'mail', kind: 'external' },
      { linkId: 'lnk_0003', href: '../other/b.md#x', text: '隣の文書', kind: 'document' },
      { linkId: 'lnk_0004', href: '/docs/c.html', text: 'rootからの文書', kind: 'document' },
      { linkId: 'lnk_0005', href: 'javascript:pwn()', text: 'js', kind: 'other' },
      { linkId: 'lnk_0006', href: 'file:///etc/passwd', text: 'file', kind: 'other' },
      { linkId: 'lnk_0007', href: 'a.png', text: '画像', kind: 'other' },
      { linkId: 'lnk_0008', href: 'https://example.com/area', text: '', kind: 'external' },
    ]);
    expect(result.diagnostics.find((entry) => entry.code === 'link-disabled')?.count).toBe(9);
  });
});

describe('keeps only registered assets', () => {
  const assets: Record<string, AssetRole> = {
    'img/a.png': 'image',
    'img/b.svg': 'svg',
    'css/site.css': 'style',
    'fonts/f.woff2': 'font',
    'app.js': 'script',
    'data.json': 'data',
  };

  it('keeps registered images and stylesheets rewritten to relative URLs, and removes the rest with a reason', () => {
    const result = render(
      `<link rel="stylesheet" href="/css/site.css?v=2"><link rel="stylesheet" href="https://evil.example/x.css">
       <link rel="alternate stylesheet" href="/css/site.css">
       <img src="../img/a.png" alt="a"><img src="/img/b.svg"><img src="missing.png"><img src="../../secret.png">
       <img src=".git/logo.png"><img src="movie.mp4"><img src="/css/site.css"><img src="/data.json">
       <img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml,<svg onload=pwn()>">
       <img srcset="../img/a.png 1x, https://evil.example/2x.png 2x, missing.png 3x" src="../img/a.png">
       <picture><source srcset="/img/b.svg" type="image/svg+xml"><img src="../img/a.png"></picture>
       <input type="image" src="../img/a.png"><input type="text" src="../img/a.png">
       <table background="../img/a.png"><tr><td>x</td></tr></table>
       <script src="/app.js"></script>
       <style>@import "/css/site.css"; @font-face { font-family: f; src: url(/fonts/f.woff2); }
         .a { background: url(../img/a.png); } .b { background: url(https://evil.example/b.png); color: red }
         .c { background: url(data:image/png;base64,AAAA) } .d { src: url(data:font/woff2;base64,AAAA) }</style>
       <p style="background: url(/img/b.svg); color: blue">x</p>`,
      assets,
      'docs/page.html',
    );
    assertInert(result.html);
    expect(result.html).not.toContain('evil.example');
    expect(result.html).toContain('<link rel="stylesheet" href="../css/site.css?v=2">');
    expect(result.html).toContain('<img src="../img/a.png" alt="a">');
    expect(result.html).toContain('<img src="../img/b.svg">');
    expect(result.html).toContain('<img src="data:image/png;base64,AAAA">');
    expect(result.html).not.toContain('image/svg+xml,');
    expect(result.html).toContain('<img srcset="../img/a.png 1x" src="../img/a.png">');
    expect(result.html).toContain('<source srcset="../img/b.svg" type="image/svg+xml">');
    expect(result.html).toContain('<input type="image" src="../img/a.png">');
    expect(result.html).toContain('<input type="text">');
    expect(result.html).toContain('<table background="../img/a.png">');
    expect(result.html).toContain('@import "../css/site.css"');
    expect(result.html).toContain('src:url(../fonts/f.woff2)');
    expect(result.html).toContain('.a{background:url(../img/a.png)}');
    expect(result.html).toContain('.b{color:red}');
    expect(result.html).toContain('.c{background:url(data:image/png;base64,AAAA)}');
    expect(result.html).toContain('style="background:url(../img/b.svg);color:blue"');
    // Non-image files and data registered only individually are not output as images.
    expect(result.html).not.toContain('data.json');
    expect(result.html).not.toContain('app.js');

    const byCode = (code: string) =>
      result.diagnostics.filter((entry) => entry.code === code).map((entry) => entry.target);
    expect(byCode('asset-not-registered')).toEqual(['docs/missing.png']);
    expect(byCode('asset-rejected')).toEqual(['../../secret.png']);
    expect(byCode('asset-hidden')).toEqual(['docs/.git/logo.png']);
    expect(byCode('asset-unsupported').toSorted()).toEqual(
      ['css/site.css', 'data.json', 'docs/movie.mp4'].toSorted(),
    );
    expect(byCode('remote-asset-blocked').toSorted()).toEqual(
      [
        'https://evil.example/x.css',
        'https://evil.example/2x.png',
        'https://evil.example/b.png',
      ].toSorted(),
    );
    expect(byCode('data-url-blocked').toSorted()).toEqual(['font/woff2', 'image/svg+xml']);
    expect(result.diagnostics.find((entry) => entry.target === 'docs/missing.png')?.count).toBe(2);
  });

  it('collects candidate local files the document references, with their context', () => {
    const references = scanHtmlReferences(
      `<link rel="stylesheet" href="a.css"><link rel="icon" href="icon.png">
       <script src="app.js"></script><img src="a.png" srcset="b.png 2x">
       <video poster="p.png" src="v.mp4"></video>
       <style>@import "b.css"; .a { background: url(c.png) } @font-face { src: url(f.woff2) }</style>
       <p style="background:url(d.png)">x</p><a href="e.html">e</a>
       <noscript><img src="n.png"></noscript><template><img src="t.png"></template>`,
    );
    expect(references).toEqual(
      expect.arrayContaining([
        { url: 'a.css', context: 'style' },
        { url: 'app.js', context: 'script' },
        { url: 'a.png', context: 'image' },
        { url: 'b.png', context: 'image' },
        { url: 'p.png', context: 'image' },
        { url: 'b.css', context: 'style' },
        { url: 'c.png', context: 'css-url' },
        { url: 'f.woff2', context: 'font' },
        { url: 'd.png', context: 'css-url' },
        { url: 'n.png', context: 'image' },
        { url: 't.png', context: 'image' },
      ]),
    );
    // Resource hints, link targets and videos are not asset candidates.
    const urls = references.map((reference) => reference.url);
    for (const url of ['icon.png', 'v.mp4', 'e.html']) expect(urls, url).not.toContain(url);
  });

  it('preserves ordinary structure and layout rules', () => {
    const source = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>設計</title>
<style>.grid{display:grid;grid-template-columns:1fr 2fr;gap:1rem}.card{display:flex}</style></head>
<body class="doc"><header><h1 id="top">設計書</h1></header>
<main class="grid"><section class="card" style="padding:1rem"><h2>節</h2><p>段落<br>改行 <strong>強調</strong> <code>code</code></p>
<ul><li>項目</li></ul><table><thead><tr><th scope="col">列</th></tr></thead><tbody><tr><td data-x="1" aria-label="値">値</td></tr></tbody></table>
<details open=""><summary>補足</summary><pre>  整形済み  </pre></details></section></main></body></html>`;
    const result = render(source);
    expect(result.diagnostics).toEqual([]);
    // Structure, class, id, data attributes, style attributes and layout CSS are output unchanged.
    // The only addition is the id that the outline anchor of a heading without one names.
    expect(result.html).toBe(source.replace('<h2>節</h2>', '<h2 id="h2">節</h2>'));
  });
});

describe('interactive view transform', () => {
  function interactive(source: string, assets: Record<string, AssetRole> = {}, sdkScript?: string) {
    return transformStaticHtml({
      source,
      documentLogicalPath: 'pages/index.html',
      assets: new Map(Object.entries(assets)),
      interactive: true,
      ...(sdkScript === undefined ? {} : { sdkScript }),
    });
  }

  it('keeps inline scripts, registered script files and event attributes, and removes unregistered and external scripts as whole elements', () => {
    const result = interactive(
      `<script>window.a = 1</script>
       <script type="module" src="/js/app.mjs"></script>
       <script src="missing.js"></script>
       <script src="https://cdn.example/x.js"></script>
       <button onclick="go()">押す</button>`,
      { 'js/app.mjs': 'script' },
    );
    const found = inspect(result.html);
    expect(found.tags.filter((tag) => tag === 'script')).toHaveLength(2);
    expect(result.html).toContain('<script>window.a = 1</script>');
    // Root-relative references are rewritten to paths relative to the document.
    expect(result.html).toContain('<script type="module" src="../js/app.mjs"></script>');
    expect(found.attributes).toContain('onclick');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { code: 'script-not-loaded', target: null, count: 2 },
        { code: 'asset-not-registered', target: 'pages/missing.js', count: 1 },
        { code: 'remote-asset-blocked', target: 'https://cdn.example/x.js', count: 1 },
      ]),
    );
  });

  it('removes embeds, base, automatic navigation, resource hints, form targets, popups, download and ping, as in static', () => {
    const result = interactive(
      `<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">
       <link rel="preconnect" href="https://evil.example"><link rel="modulepreload" href="x.js">
       <iframe src="https://evil.example"></iframe><iframe srcdoc="<script>1</script>"></iframe>
       <object data="x"></object><embed src="x"><portal src="x"></portal>
       <form action="https://evil.example/"><button formaction="https://evil.example/">送る</button></form>
       <a href="https://evil.example/" target="_blank" ping="https://evil.example/" download>link</a>
       <noscript><img src="https://evil.example/pixel.png"></noscript>
       <svg><script>1</script></svg>`,
    );
    const found = inspect(result.html);
    for (const tag of ['base', 'iframe', 'object', 'embed', 'portal', 'noscript', 'svg']) {
      expect(found.tags).not.toContain(tag);
    }
    expect(found.tags.filter((tag) => tag === 'meta' || tag === 'link')).toEqual([]);
    for (const name of ['action', 'formaction', 'target', 'ping', 'download', 'srcdoc', 'href']) {
      expect(found.attributes).not.toContain(name);
    }
    expect(result.links).toHaveLength(1);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'noscript-removed',
        'embed-removed',
        'base-removed',
        'meta-refresh-removed',
      ]),
    );
  });

  it('inserts the SDK as the first script in head, and refuses an SDK containing a closing script tag', () => {
    const result = interactive(
      '<!doctype html><html><head><script>first()</script></head><body></body></html>',
      {},
      'window.sdk = 1;',
    );
    expect(result.html).toContain('<head><script>window.sdk = 1;</script><script>first()</script>');
    expect(() => interactive('<p>x</p>', {}, 'a = "</script><script>evil()"')).toThrow();
  });

  it('in static, the same document keeps no scripts or event attributes, and the SDK is not inserted', () => {
    const result = transformStaticHtml({
      source: '<script>1</script><button onclick="go()">押す</button>',
      documentLogicalPath: 'index.html',
      assets: new Map(),
      sdkScript: 'window.sdk = 1;',
    });
    const found = inspect(result.html);
    expect(found.tags).not.toContain('script');
    expect(found.attributes).not.toContain('onclick');
  });
});

describe('heading anchors in the static view', () => {
  // Headings of the output as the browser parses it, in document order (the contents of template are not shown).
  function headingsOf(html: string): Array<{ id: string | null; text: string }> {
    const headings: Array<{ id: string | null; text: string }> = [];
    const stack: HtmlNode[] = [parse(html, { scriptingEnabled: false })];
    while (stack.length > 0) {
      const node = stack.pop() as HtmlNode;
      if ('tagName' in node && /^h[1-6]$/.test(node.tagName)) {
        const id = node.attrs.find((attribute) => attribute.name === 'id')?.value ?? null;
        const text = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
        headings.push({ id, text });
      }
      if ('childNodes' in node) stack.push(...node.childNodes.toReversed());
    }
    return headings;
  }

  // The outline items a link in the view reaches: each target names a heading of the outline, and the element
  // with that id in the output is that heading.
  function targetsOf(source: string) {
    const result = render(source);
    const outline = analyzeHtml(source).outline;
    const shown = headingsOf(result.html);
    for (const target of result.headingTargets) {
      const item = outline.find((candidate) => candidate.sectionId === target.sectionId);
      expect(item?.anchor).toBe(target.anchor);
      expect(shown.find((heading) => heading.id === target.anchor)?.text).toBe(item?.title);
    }
    return result.headingTargets;
  }

  it('gives headings without an id the outline anchor, keeps written ids, and avoids ids used anywhere in the document', () => {
    const source =
      '<h1 id="top">A</h1><h2>B</h2><h2 id="">C</h2><h3>D</h3><p id="h4">後方の要素</p>' +
      '<template><p id="h3">表示されない</p></template>';
    expect(analyzeHtml(source).outline.map((item) => item.anchor)).toEqual([
      'top',
      'h2',
      'h3-2',
      'h4-2',
    ]);
    expect(headingsOf(render(source).html)).toEqual([
      { id: 'top', text: 'A' },
      { id: 'h2', text: 'B' },
      { id: 'h3-2', text: 'C' },
      { id: 'h4-2', text: 'D' },
    ]);
    expect(targetsOf(source)).toEqual([
      { sectionId: 'sec_0001', anchor: 'top' },
      { sectionId: 'sec_0002', anchor: 'h2' },
      { sectionId: 'sec_0003', anchor: 'h3-2' },
      { sectionId: 'sec_0004', anchor: 'h4-2' },
    ]);
  });

  it('leaves out headings the view removes, without shifting the numbering of later headings', () => {
    const source =
      '<h1>A</h1><object><h2>B</h2></object><svg><foreignObject><h2>C</h2></foreignObject></svg><h2>D</h2>';
    expect(analyzeHtml(source).outline.map((item) => [item.sectionId, item.anchor])).toEqual([
      ['sec_0001', 'h1'],
      ['sec_0002', 'h2'],
      ['sec_0003', 'h3'],
      ['sec_0004', 'h4'],
    ]);
    expect(targetsOf(source)).toEqual([
      { sectionId: 'sec_0001', anchor: 'h1' },
      { sectionId: 'sec_0004', anchor: 'h4' },
    ]);
  });

  it('leaves out a heading whose id belongs to an earlier element of the view', () => {
    expect(targetsOf('<h2 id="same">First</h2><h2 id="same">Second</h2>')).toEqual([
      { sectionId: 'sec_0001', anchor: 'same' },
    ]);
    expect(
      targetsOf('<object><h2 id="same">Removed</h2></object><h2 id="same">Visible</h2>'),
    ).toEqual([{ sectionId: 'sec_0002', anchor: 'same' }]);
    expect(targetsOf('<p id="x">段落</p><h2 id="x">X</h2>')).toEqual([]);
  });

  it('leaves out a heading whose encoded fragment names another element as written, in either order', () => {
    // The fragment of 節 is %E7%AF%80. The browser looks for it as written before decoding it.
    expect(targetsOf('<h2 id="節">節</h2>')).toEqual([{ sectionId: 'sec_0001', anchor: '節' }]);
    expect(targetsOf('<h2 id="%E7%AF%80">表記</h2><h2 id="節">節</h2>')).toEqual([
      { sectionId: 'sec_0001', anchor: '%E7%AF%80' },
    ]);
    expect(targetsOf('<h2 id="節">節</h2><h2 id="%E7%AF%80">表記</h2>')).toEqual([
      { sectionId: 'sec_0002', anchor: '%E7%AF%80' },
    ]);
    expect(targetsOf('<a name="%E7%AF%80"></a><h2 id="節">節</h2>')).toEqual([]);
    // A name equal to the anchor itself does not matter: an id is looked for first.
    expect(targetsOf('<a name="x"></a><h2 id="x">X</h2>')).toEqual([
      { sectionId: 'sec_0001', anchor: 'x' },
    ]);
  });

  it('keeps headings inside noscript in static and never counts headings inside template', () => {
    const source = '<template><h2>T</h2></template><noscript><h2>N</h2></noscript><h2>Z</h2>';
    expect(targetsOf(source)).toEqual([
      { sectionId: 'sec_0001', anchor: 'h1' },
      { sectionId: 'sec_0002', anchor: 'h2' },
    ]);
  });

  it('adds no ids to the interactive view and returns no targets for it', () => {
    const source = '<h1>A</h1><h2 id="">B</h2>';
    const result = transformStaticHtml({
      source,
      documentLogicalPath: 'index.html',
      assets: new Map(),
      interactive: true,
    });
    expect(headingsOf(result.html)).toEqual([
      { id: null, text: 'A' },
      { id: '', text: 'B' },
    ]);
    expect(result.headingTargets).toEqual([]);
  });
});
