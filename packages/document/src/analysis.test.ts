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

describe('Markdownのoutline', () => {
  it('root直下の見出しを文書順に並べ、祖先の見出しをheadingPathに入れる', () => {
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
    // anchorはparserが渡す位置から作る。連番ではないが、文書内で一意になる。
    expect(outline.every((item) => /^h\d+$/.test(item.anchor))).toBe(true);
    expect(new Set(outline.map((item) => item.anchor)).size).toBe(outline.length);
  });

  it('同名の見出しでもsectionIdとanchorが一意になる', () => {
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

  it('引用や箇条書きの中の見出し、frontmatter、コード内の#は節にしない', () => {
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

  it('Setextの見出しは見出しとして扱わない（導入版の既知の非対応）', () => {
    expect(analyzeMarkdown('Setextの見出し\n===\n\n本文\n').outline).toEqual([]);
  });
});

describe('MD-006 構造の上限', () => {
  it('nodeが多すぎる文書を解析errorにする', () => {
    const source = Array.from({ length: PARSER_LIMITS.maxNodes / 2 + 10 }, () => 'a').join('\n\n');
    expect(() => parseMarkdownDocument(source)).toThrow(ParseLimitError);
  });

  it('入れ子が深すぎる文書を解析errorにする', () => {
    const source = `${'> '.repeat(PARSER_LIMITS.maxDepth + 2)}深い`;
    expect(() => parseMarkdownDocument(source)).toThrow(ParseLimitError);
  });
});

describe('HTMLのoutline', () => {
  it('title要素と見出しを取り出し、scriptとstyleの内容を拾わない', () => {
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
    });
    expect(analyzeHtml(fixture('review.html')).title).toBe('ログイン画面の選択サンプル');
  });
});
