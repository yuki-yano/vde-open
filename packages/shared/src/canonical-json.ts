// revisionとstateのchecksumに使う決定的なJSON表現（仕様4.1）。
// object keyを再帰的に辞書順へ整列し、arrayの順序を保ち、空白を入れない。
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('canonical JSONに非有限のnumberは使えません');
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(',')}]`;
      return serializeObject(value as Record<string, unknown>);
    default:
      throw new TypeError(`canonical JSONに${typeof value}は使えません`);
  }
}

function serializeObject(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value).toSorted()) {
    const item = value[key];
    if (item === undefined) throw new TypeError(`canonical JSONにundefinedは使えません: ${key}`);
    parts.push(`${JSON.stringify(key)}:${serialize(item)}`);
  }
  return `{${parts.join(',')}}`;
}
