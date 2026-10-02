// 文書中の参照（URL）を分類し、local fileへの参照をassets-rootからの相対path（logical path）へ解決する。
// filesystemには触れない。ここで決めるのは、文字列としての参照がどこを指すかだけ（仕様10.3）。

export type AssetRole = 'image' | 'svg' | 'style' | 'font' | 'script' | 'data';

// 参照が現れた文脈。使えるassetの種別が決まる。
// explicitは、利用者が`--asset`で個別に指定したもの。
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
  // suffixは`?query#fragment`。配信はpathだけで決めるので、解決には使わない。
  | { kind: 'local'; logicalPath: string; suffix: string }
  | { kind: 'fragment' }
  | { kind: 'remote' }
  | { kind: 'data'; mime: string }
  | { kind: 'rejected'; reason: ReferenceRejection };

export interface AssetType {
  mime: string;
  role: AssetRole;
}

// 配信できるassetの種別（仕様10.3）。拡張子で決め、内容からの推測はしない。
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

// 変換後のHTMLへ残してよいdata URLの画像形式。SVGは含めない。
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

// `.`で始まる名前（.env、.gitなど）を含むpathは、assetとして扱わない。
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

// browserのURL解析と同じく、途中のtab・改行と、前後の空白・制御文字を除く。
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

// logical pathとして正しい形か。区切りは`/`で、`.`や`..`、空の要素を含まない。
export function isValidLogicalPath(logicalPath: string): boolean {
  if (logicalPath === '') return false;
  return logicalPath.split('/').every((segment) => {
    if (segment === '' || segment === '.' || segment === '..') return false;
    return !segment.includes('\\') && !hasCharCode(segment, 0);
  });
}

// baseDirは、参照を含むfileのdirectory（logical path。rootなら空文字）。
export function classifyReference(raw: string, baseDir: string): Reference {
  const cleaned = stripUrlWhitespace(raw);
  if (cleaned === '') return { kind: 'rejected', reason: 'empty' };
  if (cleaned.startsWith('#')) return { kind: 'fragment' };
  if (hasCharCode(cleaned, 0)) return { kind: 'rejected', reason: 'nul' };
  // browserは`\`を`/`として扱うことがあり、UNCも`\\`で始まる。解釈が分かれるので受け付けない。
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
    // javascript:、blob:、Windowsのdrive letter（C:）など。
    return { kind: 'rejected', reason: 'scheme' };
  }
  if (cleaned.startsWith('//')) return { kind: 'remote' };

  const hashAt = cleaned.indexOf('#');
  const beforeHash = hashAt === -1 ? cleaned : cleaned.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const rawPath = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const suffix = cleaned.slice(rawPath.length);
  // pathのない参照（`?x`など）は、文書自身を指す。
  if (rawPath === '') return { kind: 'rejected', reason: 'empty' };
  // 区切りやNULをencodeした形は、decodeの段階によって指す先が変わる。
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
    // 1回のdecodeで終わらない形（二重のencode）は受け付けない。
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

// schemeやhostを持たない、文書からの相対参照の形か。どこを指すかは、文書の位置が決まってから調べる。
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

// fromDirにあるfileから、logical pathを指す相対URL。発行した表示用URLの中だけで解決される。
export function relativeUrlTo(fromDir: string, logicalPath: string): string {
  const depth = fromDir === '' ? 0 : fromDir.split('/').length;
  return `${'../'.repeat(depth)}${encodeLogicalPath(logicalPath)}`;
}

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm']);

// 文書として開ける拡張子か（仕様5.2の既定対象）。
export function hasDocumentExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export type LinkTarget =
  | { kind: 'fragment' }
  // browserの別tabで開けるURL（http・https・mailto）。
  | { kind: 'external'; url: string }
  // localの文書への相対link。fromRootは`/`始まり（assets-rootからの指定）。segmentsは`..`を含みうる。
  | { kind: 'document'; fromRoot: boolean; segments: string[] }
  | { kind: 'other' };

// 文書中のlinkの行き先を分類する。localの文書へのlinkは、開く前に本体で確認する（仕様10.4）。
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
