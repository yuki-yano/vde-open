// Classify references (URLs) in a document and resolve references to local files into paths relative to the assets-root (logical paths).
// Never touches the filesystem. This only decides where a reference, as a string, points (spec 10.3).

export type AssetRole = 'image' | 'svg' | 'style' | 'font' | 'script' | 'data';

// Context the reference appeared in. Decides which asset roles can be used.
// explicit is one the user gave individually with `--asset`.
export type ReferenceContext = 'image' | 'style' | 'script' | 'font' | 'css-url' | 'explicit';

export type ReferenceRejection =
  | 'empty'
  | 'nul'
  | 'backslash'
  | 'scheme'
  | 'file-url'
  | 'encoded'
  | 'outside-root'
  | 'directory';

export type Reference =
  // suffix is `?query#fragment`. Serving is decided by the path alone, so it is not used for resolution.
  | { kind: 'local'; logicalPath: string; suffix: string }
  | { kind: 'fragment' }
  | { kind: 'remote' }
  | { kind: 'data'; mime: string }
  | { kind: 'rejected'; reason: ReferenceRejection };

export interface AssetType {
  mime: string;
  role: AssetRole;
}

// Asset types that can be served (spec 10.3). Decided by extension, never guessed from content.
const ASSET_TYPES: Record<string, AssetType> = {
  png: { mime: 'image/png', role: 'image' },
  jpg: { mime: 'image/jpeg', role: 'image' },
  jpeg: { mime: 'image/jpeg', role: 'image' },
  webp: { mime: 'image/webp', role: 'image' },
  gif: { mime: 'image/gif', role: 'image' },
  avif: { mime: 'image/avif', role: 'image' },
  svg: { mime: 'image/svg+xml', role: 'svg' },
  css: { mime: 'text/css; charset=utf-8', role: 'style' },
  woff: { mime: 'font/woff', role: 'font' },
  woff2: { mime: 'font/woff2', role: 'font' },
  js: { mime: 'text/javascript; charset=utf-8', role: 'script' },
  mjs: { mime: 'text/javascript; charset=utf-8', role: 'script' },
  json: { mime: 'application/json; charset=utf-8', role: 'data' },
};

// Image formats of data URLs allowed to stay in the transformed HTML. SVG is excluded.
const RASTER_DATA_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const ALLOWED_ROLES: Record<ReferenceContext, readonly AssetRole[]> = {
  image: ['image', 'svg'],
  style: ['style'],
  script: ['script'],
  font: ['font'],
  'css-url': ['image', 'svg', 'font'],
  explicit: ['image', 'svg', 'style', 'font', 'script', 'data'],
};

export function assetTypeOf(logicalPath: string): AssetType | null {
  const name = logicalPath.slice(logicalPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(ASSET_TYPES, extension) ? (ASSET_TYPES[extension] as AssetType) : null;
}

export function roleAllowed(context: ReferenceContext, role: AssetRole): boolean {
  return ALLOWED_ROLES[context].includes(role);
}

// A path containing a name starting with `.` (.env, .git and so on) is not treated as an asset.
export function hasHiddenSegment(logicalPath: string): boolean {
  return logicalPath.split('/').some((segment) => segment.startsWith('.'));
}

export function isRasterDataMime(mime: string): boolean {
  return RASTER_DATA_MIMES.has(mime);
}

function hasCharCode(text: string, code: number): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === code) return true;
  }
  return false;
}

// As in browser URL parsing, strip tabs and newlines inside, and whitespace and control characters at both ends.
function stripUrlWhitespace(raw: string): string {
  let text = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    text += raw[index];
  }
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 32) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 32) end -= 1;
  return text.slice(start, end);
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ENCODED_SEPARATOR_OR_NUL = /%(2f|5c|00)/i;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;

// Whether this is a well-formed logical path: separated by `/`, with no `.`, `..` or empty segments.
export function isValidLogicalPath(logicalPath: string): boolean {
  if (logicalPath === '') return false;
  return logicalPath.split('/').every((segment) => {
    if (segment === '' || segment === '.' || segment === '..') return false;
    return !segment.includes('\\') && !hasCharCode(segment, 0);
  });
}

// baseDir is the directory of the file containing the reference (a logical path; empty string for the root).
export function classifyReference(raw: string, baseDir: string): Reference {
  const cleaned = stripUrlWhitespace(raw);
  if (cleaned === '') return { kind: 'rejected', reason: 'empty' };
  if (cleaned.startsWith('#')) return { kind: 'fragment' };
  if (hasCharCode(cleaned, 0)) return { kind: 'rejected', reason: 'nul' };
  // Browsers sometimes treat `\` as `/`, and UNC paths start with `\\`. Interpretations differ, so it is rejected.
  if (cleaned.includes('\\')) return { kind: 'rejected', reason: 'backslash' };

  const scheme = SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'remote' };
    if (scheme === 'data') {
      const header = cleaned.slice('data:'.length).split(',', 1)[0] ?? '';
      const mime = (header.split(';', 1)[0] ?? '').trim().toLowerCase();
      return { kind: 'data', mime };
    }
    if (scheme === 'file') return { kind: 'rejected', reason: 'file-url' };
    // javascript:, blob:, a Windows drive letter (C:) and so on.
    return { kind: 'rejected', reason: 'scheme' };
  }
  if (cleaned.startsWith('//')) return { kind: 'remote' };

  const hashAt = cleaned.indexOf('#');
  const beforeHash = hashAt === -1 ? cleaned : cleaned.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const rawPath = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const suffix = cleaned.slice(rawPath.length);
  // A reference without a path (such as `?x`) points at the document itself.
  if (rawPath === '') return { kind: 'rejected', reason: 'empty' };
  // An encoded separator or NUL points somewhere different depending on the decoding stage.
  if (ENCODED_SEPARATOR_OR_NUL.test(rawPath)) return { kind: 'rejected', reason: 'encoded' };

  const stack = rawPath.startsWith('/') ? [] : baseDir.split('/').filter((part) => part !== '');
  const segments = rawPath.split('/');
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { kind: 'rejected', reason: 'encoded' };
    }
    if (hasCharCode(decoded, 0)) return { kind: 'rejected', reason: 'nul' };
    // A form that one decode does not finish (double encoding) is rejected.
    if (decoded.includes('/') || decoded.includes('\\') || PERCENT_ESCAPE.test(decoded)) {
      return { kind: 'rejected', reason: 'encoded' };
    }
    if (decoded === '' || decoded === '.') continue;
    if (decoded === '..') {
      if (stack.length === 0) return { kind: 'rejected', reason: 'outside-root' };
      stack.pop();
      continue;
    }
    stack.push(decoded);
  }
  const last = segments.at(-1) ?? '';
  if (stack.length === 0 || last === '' || last === '.' || last === '..') {
    return { kind: 'rejected', reason: 'directory' };
  }
  return { kind: 'local', logicalPath: stack.join('/'), suffix };
}

// Whether this has the form of a relative reference from the document, with no scheme or host. Where it points is checked once the document's location is known.
export function isRelativeReference(raw: string): boolean {
  const cleaned = stripUrlWhitespace(raw);
  if (cleaned === '' || cleaned.startsWith('#') || cleaned.startsWith('//')) return false;
  if (hasCharCode(cleaned, 0) || cleaned.includes('\\')) return false;
  return !SCHEME.test(cleaned);
}

export function dirnameOfLogicalPath(logicalPath: string): string {
  const slash = logicalPath.lastIndexOf('/');
  return slash === -1 ? '' : logicalPath.slice(0, slash);
}

export function encodeLogicalPath(logicalPath: string): string {
  return logicalPath.split('/').map(encodeURIComponent).join('/');
}

// Relative URL from a file in fromDir to the logical path. Resolved only inside the issued view URL.
export function relativeUrlTo(fromDir: string, logicalPath: string): string {
  const depth = fromDir === '' ? 0 : fromDir.split('/').length;
  return `${'../'.repeat(depth)}${encodeLogicalPath(logicalPath)}`;
}

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm']);

// Whether the extension can be opened as a document (default targets of spec 5.2).
export function hasDocumentExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export type LinkTarget =
  | { kind: 'fragment' }
  // A URL that opens in another browser tab (http, https, mailto).
  | { kind: 'external'; url: string }
  // Relative link to a local document. fromRoot means it starts with `/` (relative to the assets-root). segments may contain `..`.
  | { kind: 'document'; fromRoot: boolean; segments: string[] }
  | { kind: 'other' };

// Classify the target of a link in the document. A link to a local document is confirmed by the host before opening (spec 10.4).
export function classifyLink(raw: string): LinkTarget {
  const cleaned = stripUrlWhitespace(raw);
  if (cleaned.startsWith('#')) return { kind: 'fragment' };
  if (cleaned === '' || hasCharCode(cleaned, 0) || cleaned.includes('\\')) return { kind: 'other' };
  const scheme = SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
      ? { kind: 'external', url: cleaned }
      : { kind: 'other' };
  }
  if (cleaned.startsWith('//')) return { kind: 'other' };
  const rawPath = (cleaned.split('#', 1)[0] ?? '').split('?', 1)[0] ?? '';
  if (rawPath === '' || ENCODED_SEPARATOR_OR_NUL.test(rawPath)) return { kind: 'other' };
  const segments: string[] = [];
  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { kind: 'other' };
    }
    if (
      hasCharCode(decoded, 0) ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      PERCENT_ESCAPE.test(decoded)
    ) {
      return { kind: 'other' };
    }
    if (decoded === '' || decoded === '.') continue;
    segments.push(decoded);
  }
  const last = segments.at(-1);
  if (last === undefined || last === '..' || !hasDocumentExtension(last)) return { kind: 'other' };
  return { kind: 'document', fromRoot: rawPath.startsWith('/'), segments };
}
