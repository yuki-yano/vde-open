// 原文の物理行とbyte範囲（仕様8.3）。
// 行は1-based。改行はLFで数え、CRLFは1改行。末尾の改行の後に架空の行を数えない。
// 空のsourceは1つの空行。byte位置は0-basedでend exclusive。

const LF = 0x0a;

export interface LineIndex {
  byteLength: number;
  lineCount: number;
  // 各行の先頭byte位置。lineStarts[n - 1]がn行目。
  lineStarts: number[];
}

export function buildLineIndex(source: Uint8Array): LineIndex {
  const lineStarts = [0];
  for (let index = 0; index < source.byteLength; index += 1) {
    if (source[index] === LF && index + 1 < source.byteLength) lineStarts.push(index + 1);
  }
  return { byteLength: source.byteLength, lineCount: lineStarts.length, lineStarts };
}

export interface ByteRange {
  startByte: number;
  endByteExclusive: number;
}

// start〜end行（両端を含む）のbyte範囲。各行の改行も含めるので、
// 連続する範囲をつなぐと原文を再現できる。endは最終行までに切り詰める。
export function byteRangeOfLines(index: LineIndex, start: number, end: number): ByteRange | null {
  if (start < 1 || end < start || start > index.lineCount) return null;
  const lastLine = Math.min(end, index.lineCount);
  return {
    startByte: index.lineStarts[start - 1] as number,
    endByteExclusive:
      lastLine < index.lineCount ? (index.lineStarts[lastLine] as number) : index.byteLength,
  };
}

// byte位置を含む行番号。
export function lineOfByte(index: LineIndex, byte: number): number {
  let low = 0;
  let high = index.lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((index.lineStarts[middle] as number) <= byte) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

// [start, end)からmaxBytes以内で、UTF-8のcode pointを壊さない終端を返す。
export function truncateAtCodePoint(
  source: Uint8Array,
  start: number,
  end: number,
  maxBytes: number,
): number {
  if (end - start <= maxBytes) return end;
  let cut = start + maxBytes;
  // 継続byte（10xxxxxx）の途中なら、そのcode pointの先頭まで戻る。
  while (cut > start && ((source[cut] as number) & 0xc0) === 0x80) cut -= 1;
  return cut;
}
