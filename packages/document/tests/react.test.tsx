import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseMarkdownDocument } from '../src/analysis.ts';
import { MarkdownView } from '../src/react.tsx';

const render = (source: string) =>
  renderToStaticMarkup(<MarkdownView document={parseMarkdownDocument(source)} />);

describe('MD-001 rendering of supported syntax', () => {
  it('renders ATX headings, tables, task lists, footnotes, code and reference links', () => {
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

describe('MD-002 fixed behavior for unsupported syntax', () => {
  it('Setext, indented code and bare URLs are not converted and the source text is shown intact', () => {
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

describe('MD-003 raw HTML and dangerous URLs', () => {
  it('does not output raw HTML as elements and brings in no scripts or event handlers', () => {
    const output = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n段落中の<b onclick="x()">太字</b>\n',
    );
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/<img/i);
    expect(output).not.toMatch(/<b[\s>]/i);
    // It remains only as escaped text.
    expect(output).toContain('&lt;script&gt;');
  });

  it('does not link javascript, file or data URLs, and loads no images', () => {
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

  it('script inside code is shown escaped', () => {
    const output = render('```html\n<script>alert(1)</script>\n```\n\n`<script>inline</script>`\n');
    expect(output).not.toMatch(/<script/i);
    expect(output).toContain('&lt;script&gt;');
  });
});

describe('MD-004 code block highlighting', () => {
  it('does not double pre and code', () => {
    const output = render('```ts\nconst a: number = 1;\n```\n');
    expect(output.match(/<pre\b/g)).toHaveLength(1);
    expect(output.match(/<code\b/g)).toHaveLength(1);
  });

  it('unknown languages and oversized blocks are shown without coloring', () => {
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
  it('does not turn tags, groups, approvals or commands into display or permissions', () => {
    const output = render(
      '---\ntags: [secret]\ngroup: admin\napproved: true\nrun: rm -rf /\n---\n\n# 本文\n',
    );
    expect(output).toMatch(/<h1[^>]*>本文<\/h1>/);
    for (const text of ['secret', 'admin', 'approved', 'rm -rf']) {
      expect(output).not.toContain(text);
    }
  });
});
