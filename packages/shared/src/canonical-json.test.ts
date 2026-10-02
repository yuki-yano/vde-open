import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.ts';

describe('canonical JSON', () => {
  it('keyを再帰的に辞書順へ整列し、arrayの順序を保ち、空白を入れない', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: '日本語' })).toBe(
      '{"a":"日本語","b":[3,{"a":2,"z":1}]}',
    );
  });

  it('undefinedと非有限のnumberを拒否する', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson([Number.NaN])).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
