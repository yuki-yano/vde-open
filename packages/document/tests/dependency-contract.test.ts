// Pin the API and behavior this product relies on in the adopted versions of TanStack Markdown and Highlight, parse5 and css-tree.
// After a version bump, differences show up here.
import { createHighlighter } from '@tanstack/highlight';
import {
  css,
  html,
  js,
  json,
  jsx,
  markdown,
  shell,
  ts,
  tsx,
  yaml,
} from '@tanstack/highlight/languages';
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown';
import { renderBlock, renderHtml } from '@tanstack/markdown/html';
import { parseMarkdown } from '@tanstack/markdown/parser';
import * as csstree from 'css-tree';
import { parse, serialize } from 'parse5';
import { describe, expect, it } from 'vitest';

describe('@tanstack/markdown 1.0.0', () => {
  it('the parser returns a serializable AST whose nodes carry no source positions', () => {
    const document = parseMarkdown('# 認証仕様\n\n本文です。\n\n## 節\n');
    expect(document.type).toBe('root');
    expect(document.children.map((node) => node.type)).toEqual(['heading', 'paragraph', 'heading']);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    for (const node of document.children) {
      expect(node).not.toHaveProperty('position');
      expect(node).not.toHaveProperty('loc');
    }
  });

  it('with allowHtml: false, raw HTML is escaped and no script is output', () => {
    const output = renderHtml('<script>alert(1)</script>\n\n<b onclick="x()">太字</b>\n', {
      allowHtml: false,
    });
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/<b\b/i);
    expect(output).toContain('&lt;b onclick=');
  });

  it('does not output a javascript: URL as a link', () => {
    const output = renderHtml('[x](javascript:alert(1))\n', { allowHtml: false });
    expect(output).not.toMatch(/href="javascript:/i);
  });

  it('an extension renderHtml hook replaces the output of image, link and code nodes, nested ones too', () => {
    const options = {
      allowHtml: false,
      extensions: [
        {
          name: 'contract',
          renderHtml: (node: { type: string }) =>
            node.type === 'image' || node.type === 'link' || node.type === 'code'
              ? `[${node.type}]`
              : undefined,
        },
      ],
    };
    const output = renderHtml(
      '![a](a.png) [b](https://example.com)\n\n- ![c](c.png)\n\n> ```ts\n> x\n> ```\n',
      options,
    );
    expect(output).toBe(
      '<p>[image] [link]</p>\n<ul>\n<li>[image]</li>\n</ul>\n<blockquote>\n[code]\n</blockquote>',
    );
    // Rendering a node without the extension gives the default output.
    expect(renderBlock({ type: 'code', lang: 'ts', value: 'x' }, { allowHtml: false })).toBe(
      '<pre class="tm-code" data-lang="ts"><code class="language-ts">x</code></pre>',
    );
  });
});

describe('@tanstack/highlight 1.0.0', () => {
  it('the baseline languages of spec 8.2 can be registered explicitly', () => {
    const highlighter = createHighlighter({
      languages: [js, jsx, ts, tsx, json, yaml, html, css, shell, markdown],
    });
    expect(highlighter.listLanguages().toSorted()).toEqual(
      ['css', 'html', 'js', 'json', 'jsx', 'markdown', 'shell', 'ts', 'tsx', 'yaml'].toSorted(),
    );
    // bash is not a separate export; it resolves as an alias of shell.
    expect(highlighter.normalizeLanguage('bash')).toBe('shell');
  });

  it('the Markdown adapter escapes the source and does not double pre/code', () => {
    const highlighter = createHighlighter({ languages: [ts] });
    const markdownHighlighter = createTanStackMarkdownHighlighter(highlighter);
    const output = renderHtml('```ts\nconst a = "<script>";\n```\n', {
      allowHtml: false,
      highlighter: markdownHighlighter,
    });
    expect(output).not.toMatch(/<script/i);
    expect(output.match(/<pre\b/g)).toHaveLength(1);
    expect(output.match(/<code\b/g)).toHaveLength(1);
  });
});

describe('parse5 8.0.1', () => {
  it('parses and serializes HTML without executing scripts', () => {
    const tree = parse(
      '<!doctype html><title>t</title><p>本文<script>globalThis.__ran = 1</script>',
    );
    expect(serialize(tree)).toContain('<p>本文<script>globalThis.__ran = 1</script></p>');
    expect(globalThis).not.toHaveProperty('__ran');
  });
});

describe('css-tree 3.2.1', () => {
  it('extracts the targets of url() and @import from the syntax tree', () => {
    const ast = csstree.parse('@import "a.css"; .x { background: url(img/b.png) }');
    const urls: string[] = [];
    csstree.walk(ast, (node) => {
      if (node.type === 'Url') urls.push(node.value);
      if (node.type === 'String') urls.push(node.value);
    });
    expect(urls).toEqual(['a.css', 'img/b.png']);
  });
});
