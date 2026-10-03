import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  analyzeHtml,
  analyzeMarkdown,
  ParseLimitError,
  parseMarkdownDocument,
  PARSER_LIMITS,
} from './analysis.ts';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../tests/fixtures/handoff/${name}`, import.meta.url)),
    'utf8',
  );

describe('Markdown outline', () => {
  it('lists headings directly under the root in document order and puts ancestor headings in headingPath', () => {
    const { title, outline } = analyzeMarkdown(fixture('auth.md'));
    expect(title).toBe('認証仕様');
    expect(outline.slice(0, 4).map(({ anchor: _anchor, ...rest }) => rest)).toEqual([
      { sectionId: 'sec_0001', level: 1, title: '認証仕様', headingPath: ['認証仕様'] },
      {
        sectionId: 'sec_0002',
        level: 2,
        title: 'セッションの有効期限',
        headingPath: ['認証仕様', 'セッションの有効期限'],
      },
      {
        sectionId: 'sec_0003',
        level: 3,
        title: '更新の判定',
        headingPath: ['認証仕様', 'セッションの有効期限', '更新の判定'],
      },
      {
        sectionId: 'sec_0004',
        level: 2,
        title: 'エラーの契約',
        headingPath: ['認証仕様', 'エラーの契約'],
      },
    ]);
    // Anchors are built from the position the parser passes. Not sequential, but unique within the document.
    expect(outline.every((item) => /^h\d+$/.test(item.anchor))).toBe(true);
    expect(new Set(outline.map((item) => item.anchor)).size).toBe(outline.length);
  });

  it('sectionId and anchor are unique even for headings with the same name', () => {
    const { outline } = analyzeMarkdown('# 概要\n\n## 手順\n\n## 手順\n\n# 概要\n');
    expect(new Set(outline.map((item) => item.sectionId)).size).toBe(4);
    expect(new Set(outline.map((item) => item.anchor)).size).toBe(4);
    expect(outline.map((item) => item.headingPath)).toEqual([
      ['概要'],
      ['概要', '手順'],
      ['概要', '手順'],
      ['概要'],
    ]);
  });

  it('headings inside quotes or lists, frontmatter, and # inside code do not become sections', () => {
    const source = [
      '---',
      'title: frontmatterの値',
      '---',
      '序文',
      '',
      '> ## 引用の中',
      '',
      '- ## 箇条書きの中',
      '',
      '```md',
      '# コードの中',
      '```',
      '',
      '## 本物の見出し',
      '',
    ].join('\n');
    expect(analyzeMarkdown(source).outline.map((item) => item.title)).toEqual(['本物の見出し']);
  });

  it('Setext headings are not treated as headings (known limitation of the adopted version)', () => {
    expect(analyzeMarkdown('Setextの見出し\n===\n\n本文\n').outline).toEqual([]);
  });
});

describe('MD-006 structure limits', () => {
  it('a document with too many nodes is a parse error', () => {
    const source = Array.from({ length: PARSER_LIMITS.maxNodes / 2 + 10 }, () => 'a').join('\n\n');
    expect(() => parseMarkdownDocument(source)).toThrow(ParseLimitError);
  });

  it('a document nested too deeply is a parse error', () => {
    const source = `${'> '.repeat(PARSER_LIMITS.maxDepth + 2)}深い`;
    expect(() => parseMarkdownDocument(source)).toThrow(ParseLimitError);
  });
});

describe('HTML outline', () => {
  it('extracts the title element and headings, and does not collect script or style content', () => {
    const html = [
      '<!doctype html><title>設計メモ</title>',
      '<style>h1::after { content: "x" }</style>',
      '<h1 id="top">概要<script>document.title = "書き換え"</script></h1>',
      '<section><h2>詳細 <em>その1</em></h2></section>',
      '<template><h2>描画されない</h2></template>',
    ].join('');
    expect(analyzeHtml(html)).toEqual({
      title: '設計メモ',
      outline: [
        { sectionId: 'sec_0001', level: 1, title: '概要', headingPath: ['概要'], anchor: 'top' },
        {
          sectionId: 'sec_0002',
          level: 2,
          title: '詳細 その1',
          headingPath: ['概要', '詳細 その1'],
          anchor: 'h2',
        },
      ],
      sections: [
        { sectionId: 'sec_0001', level: 1, title: '概要', headingPath: ['概要'], text: '' },
        {
          sectionId: 'sec_0002',
          level: 2,
          title: '詳細 その1',
          headingPath: ['概要', '詳細 その1'],
          text: '',
        },
      ],
    });
    expect(analyzeHtml(fixture('review.html')).title).toBe('ログイン画面の選択サンプル');
  });
});

describe('section extraction', () => {
  it('SRCH-014: a Markdown section runs from a heading to just before the next heading, and lower text is not folded into upper sections', () => {
    const analysis = analyzeMarkdown(
      [
        '序文の段落。',
        '',
        '# 認証',
        '',
        '認証の概要。',
        '',
        '## 有効期限',
        '',
        'セッションは30分で失効する。',
        '',
        '- 延長は1回まで',
        '- `refresh_token` を使う',
        '',
        '## 有効期限',
        '',
        '| 種類 | 期限 |',
        '|---|---|',
        '| access | 30分 |',
        '',
        '```ts',
        'const ttl = 1800;',
        '```',
        '',
        '# 付録',
        '',
        '> 引用の中の文。',
      ].join('\n'),
    );
    expect(analysis.sections).toEqual([
      { sectionId: 'sec_0000', level: 0, title: '', headingPath: [], text: '序文の段落。' },
      {
        sectionId: 'sec_0001',
        level: 1,
        title: '認証',
        headingPath: ['認証'],
        text: '認証の概要。',
      },
      {
        sectionId: 'sec_0002',
        level: 2,
        title: '有効期限',
        headingPath: ['認証', '有効期限'],
        text: 'セッションは30分で失効する。\n\n延長は1回まで\nrefresh_token を使う',
      },
      {
        // Headings with the same name still get different section IDs.
        sectionId: 'sec_0003',
        level: 2,
        title: '有効期限',
        headingPath: ['認証', '有効期限'],
        text: '種類 期限\naccess 30分\n\nconst ttl = 1800;',
      },
      {
        sectionId: 'sec_0004',
        level: 1,
        title: '付録',
        headingPath: ['付録'],
        text: '引用の中の文。',
      },
    ]);
    // Heading sections use the same IDs as the outline. The preamble does not appear in the outline.
    expect(analysis.outline.map((item) => item.sectionId)).toEqual([
      'sec_0001',
      'sec_0002',
      'sec_0003',
      'sec_0004',
    ]);
    // The upper section does not contain the text of the lower sections.
    expect(analysis.sections[1]?.text).not.toContain('30分');
    // Without a preamble, sec_0000 is not created.
    expect(analyzeMarkdown('# 見出し\n\n本文\n').sections.map((s) => s.sectionId)).toEqual([
      'sec_0001',
    ]);
    expect(analyzeMarkdown('見出しのない文書。\n').sections).toEqual([
      { sectionId: 'sec_0000', level: 0, title: '', headingPath: [], text: '見出しのない文書。' },
    ]);
    // An empty document also has one empty preamble (so a section found by search can be read by the same ID).
    const empty = { sectionId: 'sec_0000', level: 0, title: '', headingPath: [], text: '' };
    expect(analyzeMarkdown('').sections).toEqual([empty]);
    expect(analyzeHtml('<!doctype html><title>空</title>').sections).toEqual([empty]);
  });

  it('SRCH-013: HTML is extracted statically, without script content, form field values or hidden content', () => {
    const analysis = analyzeHtml(
      `<!doctype html><html><head><title>設計</title><style>.x{content:"STYLE-SECRET"}</style>
       <script>const token = "SCRIPT-SECRET"; document.body.innerHTML = "<p>scriptが作る本文</p>";</script></head>
       <body><p>序文の文。</p>
       <h1>認証</h1><p>本文の<strong>段落</strong>。</p><pre><code>const a = 1;</code></pre>
       <form><input name="q" value="INPUT-SECRET"><textarea>TEXTAREA-SECRET</textarea>
       <select><option>OPTION-SECRET</option></select><button>送信</button></form>
       <template><p>TEMPLATE-SECRET</p></template><noscript><p>scriptなしの文</p></noscript>
       <div><h2>詳細</h2><table><tr><th>種類</th><th>期限</th></tr><tr><td>access</td><td>30分</td></tr></table></div>
       </body></html>`,
    );
    expect(analysis.title).toBe('設計');
    expect(analysis.sections).toEqual([
      { sectionId: 'sec_0000', level: 0, title: '', headingPath: [], text: '序文の文。' },
      {
        sectionId: 'sec_0001',
        level: 1,
        title: '認証',
        headingPath: ['認証'],
        text: '本文の段落。\nconst a = 1;\n送信\nscriptなしの文',
      },
      {
        sectionId: 'sec_0002',
        level: 2,
        title: '詳細',
        headingPath: ['認証', '詳細'],
        text: '種類 期限\naccess 30分',
      },
    ]);
    const all = JSON.stringify(analysis);
    for (const hidden of ['SECRET', 'scriptが作る本文', 'innerHTML']) {
      expect(all, hidden).not.toContain(hidden);
    }
  });
});
