import { describe, expect, it } from 'vitest';

import {
  buildLineIndex,
  byteRangeOfLines,
  lineOfByte,
  truncateAtCodePoint,
} from './source-lines.ts';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('counting physical lines', () => {
  it.each([
    ['', 1],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['a\r\nb\r\n', 2],
    ['a\n\n', 2],
  ])('%j has %i lines', (text, lines) => {
    expect(buildLineIndex(bytes(text)).lineCount).toBe(lines);
  });
});

describe('byte range of a line range', () => {
  it('includes each line newline, so joining consecutive ranges reproduces the source', () => {
    const source = bytes('一行目\r\n二行目\n三行目');
    const index = buildLineIndex(source);
    const first = byteRangeOfLines(index, 1, 1);
    const rest = byteRangeOfLines(index, 2, 3);
    expect(first).toEqual({ startByte: 0, endByteExclusive: 11 });
    expect(rest).toEqual({ startByte: 11, endByteExclusive: source.byteLength });
    const joined = Buffer.concat([
      source.subarray(first?.startByte, first?.endByteExclusive),
      source.subarray(rest?.startByte, rest?.endByteExclusive),
    ]);
    expect(joined.equals(source)).toBe(true);
  });

  it('clamps end to the last line and returns null for an out-of-range start', () => {
    const index = buildLineIndex(bytes('a\nb\n'));
    expect(byteRangeOfLines(index, 2, 99)).toEqual({ startByte: 2, endByteExclusive: 4 });
    expect(byteRangeOfLines(index, 3, 3)).toBeNull();
    expect(byteRangeOfLines(index, 0, 1)).toBeNull();
    expect(byteRangeOfLines(index, 2, 1)).toBeNull();
  });

  it('an empty source has an empty range for line 1', () => {
    const index = buildLineIndex(bytes(''));
    expect(byteRangeOfLines(index, 1, 1)).toEqual({ startByte: 0, endByteExclusive: 0 });
  });

  it('looks up the line number from a byte offset', () => {
    const index = buildLineIndex(bytes('ab\ncd\nef'));
    expect([0, 2, 3, 5, 6, 7].map((byte) => lineOfByte(index, byte))).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe('truncation at code point boundaries', () => {
  it('does not cut inside a multi-byte character', () => {
    const source = bytes('認証abc');
    // The first two characters are 3 bytes each. A 4 byte budget fits only the first one.
    expect(truncateAtCodePoint(source, 0, source.byteLength, 4)).toBe(3);
    expect(truncateAtCodePoint(source, 0, source.byteLength, 6)).toBe(6);
    expect(truncateAtCodePoint(source, 0, source.byteLength, 100)).toBe(source.byteLength);
  });

  it('with 4 byte characters, continuing from the cut reproduces the source', () => {
    const source = bytes('😀😀😀');
    let offset = 0;
    const parts: Buffer[] = [];
    while (offset < source.byteLength) {
      const cut = truncateAtCodePoint(source, offset, source.byteLength, 5);
      expect(cut).toBeGreaterThan(offset);
      parts.push(Buffer.from(source.subarray(offset, cut)));
      offset = cut;
    }
    expect(parts.map((part) => part.toString('utf8'))).toEqual(['😀', '😀', '😀']);
    expect(Buffer.concat(parts).equals(source)).toBe(true);
  });
});
