// JSONを、重複したkeyを拒否しながら読む（仕様11.2）。JSON.parseは重複を黙って後勝ちにするので使わない。
// 値の型はJSON.parseと同じ。`__proto__`というkeyは拒否する（検証の途中で黙って捨てられたり、
// prototypeを書き換えたりする経路を作らない）。

export class StrictJsonError extends Error {
  readonly reason: 'syntax' | 'duplicate-key' | 'forbidden-key' | 'depth';
  // 問題の位置（JSON Pointer）。値は含めない。
  readonly pointer: string;

  constructor(reason: StrictJsonError['reason'], pointer: string, message: string) {
    super(message);
    this.name = 'StrictJsonError';
    this.reason = reason;
    this.pointer = pointer;
  }
}

const MAX_DEPTH = 64;

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function parseStrictJson(text: string): unknown {
  let index = 0;

  const fail = (reason: StrictJsonError['reason'], pointer: string, message: string): never => {
    throw new StrictJsonError(reason, pointer, message);
  };

  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text[index];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break;
      index += 1;
    }
  };

  const parseString = (pointer: string): string => {
    // 開始の`"`は呼び出し側で確かめてある。文字列の規則はJSON.parseに任せる。
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return fail('syntax', pointer, '文字列が正しくありません。');
        }
      }
      index += 1;
    }
    return fail('syntax', pointer, '文字列が閉じていません。');
  };

  const parseValue = (pointer: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('depth', pointer, '入れ子が深すぎます。');
    skipWhitespace();
    const char = text[index];
    if (char === '{') {
      index += 1;
      const object: Record<string, unknown> = {};
      const seen = new Set<string>();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return object;
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') fail('syntax', pointer, 'objectのkeyがありません。');
        const key = parseString(pointer);
        const child = `${pointer}/${escapePointer(key)}`;
        if (seen.has(key)) fail('duplicate-key', child, '同じkeyが2回あります。');
        if (key === '__proto__') fail('forbidden-key', child, '`__proto__`はkeyに使えません。');
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('syntax', child, '`:`がありません。');
        index += 1;
        const value = parseValue(child, depth + 1);
        Object.defineProperty(object, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skipWhitespace();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] === '}') {
          index += 1;
          return object;
        }
        fail('syntax', pointer, '`,`か`}`がありません。');
      }
    }
    if (char === '[') {
      index += 1;
      const array: unknown[] = [];
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue(`${pointer}/${String(array.length)}`, depth + 1));
        skipWhitespace();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] === ']') {
          index += 1;
          return array;
        }
        fail('syntax', pointer, '`,`か`]`がありません。');
      }
    }
    if (char === '"') return parseString(pointer);
    // 数値・true・false・null。字句の範囲を切り出し、規則の確認はJSON.parseに任せる。
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(index, index + 512),
    );
    if (!match) return fail('syntax', pointer, '値が正しくありません。');
    index += match[0].length;
    return JSON.parse(match[0]) as unknown;
  };

  const value = parseValue('', 0);
  skipWhitespace();
  if (index !== text.length) fail('syntax', '', 'JSONの後に余分な内容があります。');
  return value;
}
