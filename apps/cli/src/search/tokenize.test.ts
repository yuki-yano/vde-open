import { describe, expect, it } from 'vitest';

import { allowsFuzzy, tokenize } from './tokenize.ts';

describe('SRCH-003 tokenization into search terms', () => {
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

  it('spelling variations are allowed only for ASCII terms of 4 or more characters', () => {
    expect(allowsFuzzy('token')).toBe(true);
    expect(allowsFuzzy('api')).toBe(false);
    expect(allowsFuzzy('認証認証')).toBe(false);
    expect(allowsFuzzy('refresh_token')).toBe(false);
  });
});
