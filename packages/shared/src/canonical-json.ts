// Deterministic JSON representation used for revision and state checksums (spec 4.1).
// Sorts object keys recursively, keeps array order and adds no whitespace.
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
        throw new TypeError('A non-finite number cannot be used in canonical JSON.');
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(',')}]`;
      return serializeObject(value as Record<string, unknown>);
    default:
      throw new TypeError(`A ${typeof value} cannot be used in canonical JSON.`);
  }
}

function serializeObject(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value).toSorted()) {
    const item = value[key];
    if (item === undefined)
      throw new TypeError(`undefined cannot be used in canonical JSON (key: ${key}).`);
    parts.push(`${JSON.stringify(key)}:${serialize(item)}`);
  }
  return `{${parts.join(',')}}`;
}
