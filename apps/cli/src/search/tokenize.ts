// 検索用の文字列の正規化と、語への分割（仕様9.2）。原文は変更せず、派生した値だけを作る。

// 全角・半角や合成文字の違いをそろえ、大文字と小文字を区別しない形にする。
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
// 英数のidentifier（snake_case、kebab-case、dotでつないだ名前、camelCaseを含む）。
const IDENTIFIER = /[A-Za-z0-9]+(?:[_.\-/][A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*/g;
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

// 文字列を検索語へ分ける。日本語は語の単位、英数は単語の単位。
// identifierは、分けた部分に加えて、分ける前の形も語として残す（`refresh_token`そのものでも探せる）。
// 大文字と小文字の境目で分けるので、正規化（小文字化）の前の文字列を渡す。
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

// 重複を除いた検索語。queryの解釈に使う。
export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

const ASCII_WORD = /^[a-z0-9]+$/;

// 綴りのゆらぎを許すのは、英数の4文字以上の語だけ。日本語へは適用しない。
export function allowsFuzzy(term: string): boolean {
  return term.length >= 4 && ASCII_WORD.test(term);
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

// Unicode code pointの単位で切り出す。文字の途中で切らない。
export function sliceCodePoints(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}
