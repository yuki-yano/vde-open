import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractTitle } from './title.ts';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../tests/fixtures/handoff/${name}`, import.meta.url)),
    'utf8',
  );

describe('title inference', () => {
  it('Markdown uses the first heading and strips formatting', () => {
    expect(extractTitle('前文\n\n## **認証** の `仕様`\n\n# 後の見出し\n', 'markdown')).toBe(
      '認証 の 仕様',
    );
    expect(extractTitle(fixture('auth.md'), 'markdown')).toBe('認証仕様');
  });

  it('does not treat frontmatter contents as a heading', () => {
    expect(extractTitle('---\ntitle: x\n---\n\n# 本当の見出し\n', 'markdown')).toBe('本当の見出し');
  });

  it('HTML uses the title element', () => {
    expect(extractTitle(fixture('review.html'), 'html')).toBe('ログイン画面の選択サンプル');
    expect(extractTitle('<h1>見出しだけ</h1>', 'html')).toBeNull();
  });

  it('returns null without a heading and cuts an overlong title to 160 characters', () => {
    expect(extractTitle('本文だけ\n', 'markdown')).toBeNull();
    expect(Array.from(extractTitle(`# ${'あ'.repeat(300)}\n`, 'markdown') ?? '')).toHaveLength(160);
  });
});
