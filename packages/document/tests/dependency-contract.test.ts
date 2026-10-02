// 導入した版のTanStack Markdown／Highlight、parse5、css-treeについて、
// この製品が前提にするAPIと挙動を固定する。版を上げたらここで差分を検出する。
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
import { renderHtml } from '@tanstack/markdown/html';
import { parseMarkdown } from '@tanstack/markdown/parser';
import * as csstree from 'css-tree';
import { parse, serialize } from 'parse5';
import { describe, expect, it } from 'vitest';

describe('@tanstack/markdown 1.0.0', () => {
  it('parserはserializableなASTを返し、nodeに原文位置を持たない', () => {
    const document = parseMarkdown('# 認証仕様\n\n本文です。\n\n## 節\n');
    expect(document.type).toBe('root');
    expect(document.children.map((node) => node.type)).toEqual(['heading', 'paragraph', 'heading']);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    for (const node of document.children) {
      expect(node).not.toHaveProperty('position');
      expect(node).not.toHaveProperty('loc');
    }
  });

  it('allowHtml: falseでは生HTMLをescapeし、scriptを出力しない', () => {
    const output = renderHtml('<script>alert(1)</script>\n\n<b onclick="x()">太字</b>\n', {
      allowHtml: false,
    });
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/<b\b/i);
    expect(output).toContain('&lt;b onclick=');
  });

  it('javascript:のURLをリンクとして出力しない', () => {
    const output = renderHtml('[x](javascript:alert(1))\n', { allowHtml: false });
    expect(output).not.toMatch(/href="javascript:/i);
  });
});

describe('@tanstack/highlight 1.0.0', () => {
  it('仕様8.2の基準言語を明示登録できる', () => {
    const highlighter = createHighlighter({
      languages: [js, jsx, ts, tsx, json, yaml, html, css, shell, markdown],
    });
    expect(highlighter.listLanguages().toSorted()).toEqual(
      ['css', 'html', 'js', 'json', 'jsx', 'markdown', 'shell', 'ts', 'tsx', 'yaml'].toSorted(),
    );
    // bashは独立したexportではなく、shellのaliasとして解決される。
    expect(highlighter.normalizeLanguage('bash')).toBe('shell');
  });

  it('Markdown用adapterはsourceをescapeし、pre/codeを二重にしない', () => {
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
  it('HTMLを構文解析して直列化でき、scriptを実行しない', () => {
    const tree = parse(
      '<!doctype html><title>t</title><p>本文<script>globalThis.__ran = 1</script>',
    );
    expect(serialize(tree)).toContain('<p>本文<script>globalThis.__ran = 1</script></p>');
    expect(globalThis).not.toHaveProperty('__ran');
  });
});

describe('css-tree 3.2.1', () => {
  it('url()と@importの参照先を構文木から取り出せる', () => {
    const ast = csstree.parse('@import "a.css"; .x { background: url(img/b.png) }');
    const urls: string[] = [];
    csstree.walk(ast, (node) => {
      if (node.type === 'Url') urls.push(node.value);
      if (node.type === 'String') urls.push(node.value);
    });
    expect(urls).toEqual(['a.css', 'img/b.png']);
  });
});
