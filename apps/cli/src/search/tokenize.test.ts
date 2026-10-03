import { describe, expect, it } from 'vitest';

import { allowsFuzzy, normalizeForSearch, tokenize, uniqueTokens } from './tokenize.ts';

describe('SRCH-003 tokenization into search terms', () => {
  it('Japanese is split by word and becomes search terms without spaces', () => {
    const tokens = tokenize('セッションの有効期限を更新する。認証は必須です');
    for (const word of ['セッション', '有効', '期限', '更新', '認証', '必須']) {
      expect(tokens, word).toContain(word);
    }
    // Punctuation and particle boundaries split even without spaces.
    expect(tokens).not.toContain('セッションの有効期限を更新する。認証は必須です');
  });

  it('ASCII identifiers yield both the pieces and the unsplit form as terms', () => {
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

  it('unifies full-width and half-width, and upper and lower case', () => {
    expect(normalizeForSearch('ＡＰＩ Ｋｅｙ ｶﾞｲﾄﾞ')).toBe('api key ガイド');
    expect(uniqueTokens('ＡＰＩ api Api')).toEqual(['api']);
    expect(tokenize('ｾｯｼｮﾝ')).toContain('セッション');
  });

  it('spelling variations are allowed only for ASCII terms of 4 or more characters', () => {
    expect(allowsFuzzy('token')).toBe(true);
    expect(allowsFuzzy('api')).toBe(false);
    expect(allowsFuzzy('認証認証')).toBe(false);
    expect(allowsFuzzy('refresh_token')).toBe(false);
  });
});
