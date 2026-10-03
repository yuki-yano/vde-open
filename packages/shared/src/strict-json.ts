// Parse JSON while rejecting duplicate keys (spec 11.2). JSON.parse silently lets the last duplicate win, so it is not used.
// Value types are the same as JSON.parse. The key `__proto__` is rejected (no path where validation silently drops it
// or the prototype gets rewritten).

export class StrictJsonError extends Error {
  readonly reason: 'syntax' | 'duplicate-key' | 'forbidden-key' | 'depth';
  // Location of the problem (JSON Pointer). Never includes the value.
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
    // The caller has already checked the opening `"`. String rules are left to JSON.parse.
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
          return fail('syntax', pointer, 'The string is not valid.');
        }
      }
      index += 1;
    }
    return fail('syntax', pointer, 'The string is not closed.');
  };

  const parseValue = (pointer: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('depth', pointer, 'The nesting is too deep.');
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
        if (text[index] !== '"') fail('syntax', pointer, 'An object key is missing.');
        const key = parseString(pointer);
        const child = `${pointer}/${escapePointer(key)}`;
        if (seen.has(key)) fail('duplicate-key', child, 'The same key appears twice.');
        if (key === '__proto__')
          fail('forbidden-key', child, '`__proto__` cannot be used as a key.');
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('syntax', child, 'A `:` is missing.');
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
        fail('syntax', pointer, 'A `,` or `}` is missing.');
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
        fail('syntax', pointer, 'A `,` or `]` is missing.');
      }
    }
    if (char === '"') return parseString(pointer);
    // Number, true, false or null. Cut out the token and leave the rule check to JSON.parse.
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(index, index + 512),
    );
    if (!match) return fail('syntax', pointer, 'The value is not valid.');
    index += match[0].length;
    return JSON.parse(match[0]) as unknown;
  };

  const value = parseValue('', 0);
  skipWhitespace();
  if (index !== text.length) fail('syntax', '', 'There is extra content after the JSON.');
  return value;
}
