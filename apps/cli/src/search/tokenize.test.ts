import { describe, expect, it } from 'vitest';

import { allowsFuzzy, normalizeForSearch, tokenize, uniqueTokens } from './tokenize.ts';

describe('SRCH-003 検索語への分割', () => {
  it('日本語は語の単位に分け、空白がなくても検索語になる', () => {
    const tokens = tokenize('セッションの有効期限を更新する。認証は必須です');
    for (const word of ['セッション', '有効', '期限', '更新', '認証', '必須']) {
      expect(tokens, word).toContain(word);
    }
    // 句読点や助詞の区切りは、空白がなくても分かれる。
    expect(tokens).not.toContain('セッションの有効期限を更新する。認証は必須です');
  });

  it('英数のidentifierは、部分と、分ける前の形の両方を語にする', () => {
    const tokens = tokenize('call refreshToken() with refresh_token and api.v2/users-list');
    for (const word of [
      'refreshtoken',
      'refresh',
      'token',
      'refresh_token',
      'api.v2/users-list',
      'api',
      'v2',
      'users',
      'list',
    ]) {
      expect(tokens, word).toContain(word);
    }
  });

  it('全角と半角、大文字と小文字をそろえる', () => {
    expect(normalizeForSearch('ＡＰＩ Ｋｅｙ ｶﾞｲﾄﾞ')).toBe('api key ガイド');
    expect(uniqueTokens('ＡＰＩ api Api')).toEqual(['api']);
    expect(tokenize('ｾｯｼｮﾝ')).toContain('セッション');
  });

  it('綴りのゆらぎを許すのは、英数の4文字以上の語だけ', () => {
    expect(allowsFuzzy('token')).toBe(true);
    expect(allowsFuzzy('api')).toBe(false);
    expect(allowsFuzzy('認証認証')).toBe(false);
    expect(allowsFuzzy('refresh_token')).toBe(false);
  });
});
