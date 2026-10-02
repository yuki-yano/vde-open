import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseMarkdownDocument } from '../src/analysis.ts';
import { MarkdownView } from '../src/react.tsx';

const render = (source: string) =>
  renderToStaticMarkup(<MarkdownView document={parseMarkdownDocument(source)} />);

describe('MD-001 対応する構文の描画', () => {
  it('ATX見出し、表、task list、脚注、code、reference linkを描画する', () => {
    const output = render(
      [
        '# 認証仕様',
        '',
        '日本語の段落と[参照リンク][ref]、脚注[^1]。',
        '',
        '| code | 意味 |',
        '|---|---|',
        '| A | 失効 |',
        '',
        '- [x] 済み',
        '- [ ] 未着手',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '~~~',
        'tildeのfence',
        '~~~',
        '',
        '[ref]: https://example.com/doc',
        '[^1]: 脚注の本文',
        '',
      ].join('\n'),
    );
    expect(output).toMatch(/<h1[^>]*>認証仕様<\/h1>/);
    expect(output).toContain('<table');
    expect(output).toMatch(/<input[^>]*type="checkbox"/);
    expect(output).toContain('脚注の本文');
    expect(output).toContain('href="https://example.com/doc"');
    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('tildeのfence');
  });
});

describe('MD-002 対応しない構文の固定した挙動', () => {
  it('Setext、indent code、裸URLは変換せず、原文の文字を壊さずに表示する', () => {
    const output = render(
      'Setextの見出し\n===\n\n    indentしたcode\n\nhttps://example.com/bare\n',
    );
    expect(output).not.toMatch(/<h1/);
    expect(output).toContain('Setextの見出し');
    expect(output).toContain('indentしたcode');
    expect(output).not.toContain('<pre');
    expect(output).toContain('https://example.com/bare');
    expect(output).not.toContain('href="https://example.com/bare"');
  });
});

describe('MD-003 生HTMLと危険なURL', () => {
  it('生HTMLを要素として出力せず、scriptやevent handlerを持ち込まない', () => {
    const output = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n段落中の<b onclick="x()">太字</b>\n',
    );
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/<img/i);
    expect(output).not.toMatch(/<b[\s>]/i);
    // escapeされた文字としてだけ残る。
    expect(output).toContain('&lt;script&gt;');
  });

  it('javascript・file・dataのURLをlinkにせず、画像を読み込まない', () => {
    const output = render(
      [
        '[js](javascript:alert(1))',
        '[file](file:///etc/passwd)',
        '[data](data:text/html,<script>1</script>)',
        '[相対](../secret.md)',
        '![remote](https://example.com/a.png)',
        '![local](./a.png)',
        '[見出しへ](#h1)',
      ].join('\n\n'),
    );
    expect(output).not.toMatch(/href="(javascript|file|data):/i);
    expect(output).not.toContain('secret.md"');
    expect(output).not.toMatch(/<img/i);
    expect(output).toContain('href="#h1"');
  });

  it('code中のscriptはescapeして表示する', () => {
    const output = render('```html\n<script>alert(1)</script>\n```\n\n`<script>inline</script>`\n');
    expect(output).not.toMatch(/<script/i);
    expect(output).toContain('&lt;script&gt;');
  });
});

describe('MD-004 code blockのhighlight', () => {
  it('preとcodeを二重にしない', () => {
    const output = render('```ts\nconst a: number = 1;\n```\n');
    expect(output.match(/<pre\b/g)).toHaveLength(1);
    expect(output.match(/<code\b/g)).toHaveLength(1);
  });

  it('未知の言語と大きすぎるblockは、色付けせずに表示する', () => {
    const unknown = render('```brainfuck\n+++.<script>\n```\n');
    expect(unknown.match(/<pre\b/g)).toHaveLength(1);
    expect(unknown).not.toMatch(/<script/i);
    expect(unknown).not.toMatch(/class="[^"]*keyword/);

    const huge = render(`\`\`\`ts\n${'const a = 1;\n'.repeat(22_000)}\`\`\`\n`);
    expect(huge.match(/<pre\b/g)).toHaveLength(1);
    expect(huge).not.toMatch(/class="[^"]*keyword/);
  });
});

describe('MD-005 frontmatter', () => {
  it('tag・group・承認・命令を、表示や権限へ変換しない', () => {
    const output = render(
      '---\ntags: [secret]\ngroup: admin\napproved: true\nrun: rm -rf /\n---\n\n# 本文\n',
    );
    expect(output).toMatch(/<h1[^>]*>本文<\/h1>/);
    for (const text of ['secret', 'admin', 'approved', 'rm -rf']) {
      expect(output).not.toContain(text);
    }
  });
});
