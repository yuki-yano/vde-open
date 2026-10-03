// Physical lines and byte ranges of the source (spec 8.3).
// Lines are 1-based. Newlines are counted by LF; CRLF is one newline. No phantom line is counted after a trailing newline.
// An empty source is one empty line. Byte positions are 0-based and end exclusive.

const LF = 0x0a;

export interface LineIndex {
  byteLength: number;
  lineCount: number;
  // Byte offset where each line starts. lineStarts[n - 1] is line n.
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

// Byte range of lines start to end (inclusive). Each line's newline is included,
// so joining consecutive ranges reproduces the source. end is clamped to the last line.
export function byteRangeOfLines(index: LineIndex, start: number, end: number): ByteRange | null {
  if (start < 1 || end < start || start > index.lineCount) return null;
  const lastLine = Math.min(end, index.lineCount);
  return {
    startByte: index.lineStarts[start - 1] as number,
    endByteExclusive:
      lastLine < index.lineCount ? (index.lineStarts[lastLine] as number) : index.byteLength,
  };
}

// Line number containing the byte offset.
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

// Return an end within maxBytes of [start, end) that does not split a UTF-8 code point.
export function truncateAtCodePoint(
  source: Uint8Array,
  start: number,
  end: number,
  maxBytes: number,
): number {
  if (end - start <= maxBytes) return end;
  let cut = start + maxBytes;
  // If inside continuation bytes (10xxxxxx), back up to the start of that code point.
  while (cut > start && ((source[cut] as number) & 0xc0) === 0x80) cut -= 1;
  return cut;
}
