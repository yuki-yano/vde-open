import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.ts';

describe('canonical JSON', () => {
  it('sorts keys recursively, keeps array order and adds no whitespace', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: '日本語' })).toBe(
      '{"a":"日本語","b":[3,{"a":2,"z":1}]}',
    );
  });

  it('rejects undefined and non-finite numbers', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson([Number.NaN])).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
