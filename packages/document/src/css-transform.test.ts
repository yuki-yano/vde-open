import { describe, expect, it } from 'vitest';

import { scanCssReferences, transformCss, type CssUrlResolver } from './css-transform.ts';

// localの相対参照だけを残し、`r/`を前に付ける。
const localOnly: CssUrlResolver = (url) =>
  /^[a-z]+:|^\/\//i.test(url) ? null : url.startsWith('#') ? url : `r/${url}`;

describe('SEC-012 CSSの参照', () => {
  it('url()、@import、image-setの参照先を、文脈とともに取り出す', () => {
    const css = `
      @import "base.css";
      @import url(theme.css) screen;
      @font-face { font-family: x; src: url(f.woff2) format("woff2"); }
      .a { background: url( "img/a.png" ) no-repeat; }
      .b { background-image: image-set("b.png" 1x, url(b2.png) 2x); }
      .c { --bg: url(c.png); cursor: url(c.cur), auto; }
      @namespace svg url(http://www.w3.org/2000/svg);
      .d { mask: url(#m); }
    `;
    expect(scanCssReferences(css, 'stylesheet')).toEqual([
      { url: 'base.css', context: 'style' },
      { url: 'theme.css', context: 'style' },
      { url: 'f.woff2', context: 'font' },
      { url: 'img/a.png', context: 'css-url' },
      { url: 'b.png', context: 'css-url' },
      { url: 'b2.png', context: 'css-url' },
      { url: 'c.png', context: 'css-url' },
      { url: 'c.cur', context: 'css-url' },
      { url: '#m', context: 'css-url' },
    ]);
    expect(scanCssReferences('color: red; background: url(a.png)', 'declarations')).toEqual([
      { url: 'a.png', context: 'css-url' },
    ]);
  });

  it('許可されない参照を含む宣言と@importを取り除き、ほかの宣言は残す', () => {
    const css = `
      @import url(http://evil.example/a.css);
      @import "//evil.example/b.css";
      @import "ok.css";
      .a { color: red; background: url(http://evil.example/x.png); margin: 0; }
      .b { background: url(ok.png); }
      @font-face { font-family: x; src: url(https://evil.example/f.woff2); }
    `;
    const result = transformCss(css, 'stylesheet', localOnly);
    expect(result.css).not.toContain('evil.example');
    expect(result.css).toContain('@import "r/ok.css"');
    expect(result.css).toContain('.a{color:red;margin:0}');
    expect(result.css).toContain('.b{background:url(r/ok.png)}');
  });

  it('escapeや古い仕組みで隠した取得と実行を、宣言ごと取り除く', () => {
    const css = String.raw`
      .a { background: u\72l(http://evil.example/a.png); color: blue; }
      .b { background: \75rl(http://evil.example/b.png); }
      .c { width: expression(alert(1)); height: 1px; }
      .d { behavior: url(evil.htc); -moz-binding: url(evil.xml#x); display: block; }
      .e { --x: url(http://evil.example/c.png); background: var(--x); }
      .f { background: image-set("http://evil.example/d.png" 1x); }
      .g { background: -webkit-image-set(url(//evil.example/e.png) 1x); }
      .h { content: "</style><script>alert(1)</script>"; }
    `;
    const result = transformCss(css, 'stylesheet', localOnly);
    expect(result.css).not.toContain('evil');
    expect(result.css).not.toContain('expression');
    expect(result.css).not.toContain('<');
    expect(result.css).toContain('.a{color:blue}');
    expect(result.css).toContain('.c{height:1px}');
    expect(result.css).toContain('.d{display:block}');
    expect(result.css).toContain('.e{background:var(--x)}');
  });

  it('名前をescapeで書いた@import・宣言・関数は、無効化して数える', () => {
    const css = String.raw`
      @\69mport "http://evil.example/a.css";
      @impor\74  url(http://evil.example/b.css);
      @\49 MPORT "http://evil.example/c.css";
      .a { b\61 ckground: url(http://evil.example/d.png); color: red }
      .b { \62 ehavior: url(evil.htc); margin: 0 }
      .c { background: \69mage-set("http://evil.example/e.png" 1x); padding: 0 }
      @media screen { @\69mport "http://evil.example/f.css"; .d { color: blue } }
    `;
    const result = transformCss(css, 'stylesheet', localOnly);
    expect(result.css).not.toContain('evil');
    expect(result.css).not.toContain('mport');
    expect(result.invalid).toBeGreaterThanOrEqual(5);
    expect(result.css).toContain('.a{color:red}');
    expect(result.css).toContain('.b{margin:0}');
    expect(result.css).toContain('.c{padding:0}');
    expect(result.css).toContain('.d{color:blue}');
    // 走査でも、参照として数えない（登録もしない）。
    expect(scanCssReferences(css, 'stylesheet')).toEqual([]);
  });

  it('変数などから差し込む値を、URLを受け取る関数へ渡す宣言は、無効化する', () => {
    const css = `
      :root { --image: "http://evil.example/a.png"; --ok: "local.png"; --size: 2px }
      .a { background: image-set(var(--image) 1x); color: red }
      .b { background: -webkit-image-set(var(--ok) 1x, "b.png" 2x); margin: 0 }
      .c { background: image-set(env(x) 1x); padding: 0 }
      .d { content: attr(data-x); width: calc(var(--size) * 2); background: image-set("d.png" 1x) }
      .e { background: image(var(--image)); border: 0 }
      @font-face { font-family: f; src: src(var(--image)); font-display: swap }
    `;
    const result = transformCss(css, 'stylesheet', localOnly);
    expect(result.css).not.toContain('image-set(var');
    expect(result.css).not.toContain('image-set(env');
    expect(result.css).not.toContain('image(var');
    expect(result.css).not.toContain('src(var');
    expect(result.invalid).toBe(5);
    expect(result.css).toContain('.a{color:red}');
    expect(result.css).toContain('.b{margin:0}');
    expect(result.css).toContain('.c{padding:0}');
    // 変数そのものと、URLを受け取らない関数での利用は残す。
    expect(result.css).toContain('--image:"http://evil.example/a.png"');
    expect(result.css).toContain('width:calc(var(--size)*2)');
    expect(result.css).toContain('image-set("r/d.png"1x)');
    expect(result.css).toContain('font-display:swap');
  });

  it('解析できない部分は無効化して数え、解析できた部分は残す', () => {
    const result = transformCss(
      '.a { color: red } }}} @@@ { .b { color: blue }',
      'stylesheet',
      localOnly,
    );
    expect(result.invalid).toBeGreaterThan(0);
    expect(result.css).toContain('.a{color:red}');
    expect(result.css).not.toContain('@@@');
  });

  it('通常のlayoutの指定はそのまま通す', () => {
    const css = `
      :root { --gap: calc(1rem + 2px); --shadow: 0 0 4px rgba(0, 0, 0, 0.2); }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: var(--gap); }
      .flex > .item:not(.x):nth-child(2n + 1) { display: flex; transform: translate(-50%, 10px) rotate(3deg); }
      @media (min-width: 40rem) { .grid { box-shadow: var(--shadow); } }
      @supports (display: grid) { .a { color: color-mix(in srgb, red 50%, blue); } }
      @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
    `;
    const result = transformCss(css, 'stylesheet', localOnly);
    expect(result.invalid).toBe(0);
    for (const fragment of [
      '--gap:calc(1rem + 2px)',
      'repeat(auto-fill,minmax(12rem,1fr))',
      ':not(.x):nth-child(2n+1)',
      '@media (min-width:40rem)',
      'color-mix(in srgb,red 50%,blue)',
      '@keyframes spin',
    ]) {
      expect(result.css, fragment).toContain(fragment);
    }
  });

  it('style属性の宣言も同じ規則で扱う', () => {
    const result = transformCss(
      'color: red; background: url(//evil.example/a.png); width: 10px',
      'declarations',
      localOnly,
    );
    expect(result.css).toBe('color:red;width:10px');
  });
});
