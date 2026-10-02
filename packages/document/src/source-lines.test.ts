import { describe, expect, it } from 'vitest';

import {
  buildLineIndex,
  byteRangeOfLines,
  lineOfByte,
  truncateAtCodePoint,
} from './source-lines.ts';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('物理行の数え方', () => {
  it.each([
    ['', 1],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['a\r\nb\r\n', 2],
    ['a\n\n', 2],
  ])('%j は %i 行', (text, lines) => {
    expect(buildLineIndex(bytes(text)).lineCount).toBe(lines);
  });
});

describe('行範囲のbyte範囲', () => {
  it('各行の改行を含み、連続する範囲をつなぐと原文を再現する', () => {
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

  it('endは最終行までに切り詰め、範囲外のstartはnullにする', () => {
    const index = buildLineIndex(bytes('a\nb\n'));
    expect(byteRangeOfLines(index, 2, 99)).toEqual({ startByte: 2, endByteExclusive: 4 });
    expect(byteRangeOfLines(index, 3, 3)).toBeNull();
    expect(byteRangeOfLines(index, 0, 1)).toBeNull();
    expect(byteRangeOfLines(index, 2, 1)).toBeNull();
  });

  it('空のsourceは1行目が空の範囲になる', () => {
    const index = buildLineIndex(bytes(''));
    expect(byteRangeOfLines(index, 1, 1)).toEqual({ startByte: 0, endByteExclusive: 0 });
  });

  it('byte位置から行番号を引ける', () => {
    const index = buildLineIndex(bytes('ab\ncd\nef'));
    expect([0, 2, 3, 5, 6, 7].map((byte) => lineOfByte(index, byte))).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe('code point境界での切り詰め', () => {
  it('多byte文字の途中で切らない', () => {
    const source = bytes('認証abc');
    // 「認」「証」は各3 byte。4 byteの予算では「認」までしか入らない。
    expect(truncateAtCodePoint(source, 0, source.byteLength, 4)).toBe(3);
    expect(truncateAtCodePoint(source, 0, source.byteLength, 6)).toBe(6);
    expect(truncateAtCodePoint(source, 0, source.byteLength, 100)).toBe(source.byteLength);
  });

  it('4 byte文字でも、切った位置から続けると原文を再現する', () => {
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
