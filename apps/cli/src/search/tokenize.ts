// Normalization and tokenization for search (spec 9.2). The source is not modified; only derived values are produced.

// Unifies full-width/half-width and composed forms, and makes it case-insensitive.
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
// ASCII identifiers (snake_case, kebab-case, dotted names, and camelCase).
const IDENTIFIER = /[A-Za-z0-9]+(?:[_.\-/][A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*/g;
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

// Splits text into search terms. Japanese by word, ASCII by word.
// Identifiers keep the unsplit form as a term too, in addition to the pieces (so `refresh_token` itself is searchable).
// Splits at case boundaries, so pass the text before normalization (lowercasing).
export function tokenize(text: string): string[] {
  const nfkc = text.normalize('NFKC');
  const tokens: string[] = [];
  for (const part of segmenter.segment(nfkc)) {
    if (part.isWordLike) tokens.push(part.segment.toLowerCase());
  }
  for (const match of nfkc.matchAll(IDENTIFIER)) {
    const identifier = match[0];
    tokens.push(identifier.toLowerCase());
    for (const piece of identifier.split(/[_.\-/]/)) {
      for (const word of piece.split(CAMEL_BOUNDARY)) {
        if (word !== '') tokens.push(word.toLowerCase());
      }
    }
  }
  return tokens;
}

// Search terms without duplicates. Used to interpret queries.
export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

const ASCII_WORD = /^[a-z0-9]+$/;

// Spelling variations are allowed only for ASCII terms of 4 or more characters. Not applied to Japanese.
export function allowsFuzzy(term: string): boolean {
  return term.length >= 4 && ASCII_WORD.test(term);
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

// Slices by Unicode code point. Never cuts a character in half.
export function sliceCodePoints(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}
