import { inflateSync } from 'node:zlib';

// The text on each page of a PDF written by Chrome (Skia): plain objects, Flate-compressed content streams, and fonts
// with ToUnicode maps. Just enough to check what is printed in tests; not a general PDF reader.
export function pdfPageTexts(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const objects = new Map<number, { body: string; start: number }>();
  for (const match of raw.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), {
      body: match[2] ?? '',
      start: (match.index ?? 0) + match[0].indexOf(match[2] ?? ''),
    });
  }
  const body = (ref: number) => objects.get(ref)?.body ?? '';
  const stream = (ref: number): Buffer => {
    const object = objects.get(ref);
    if (!object) return Buffer.alloc(0);
    const begin = /stream\r?\n/.exec(object.body);
    const end = object.body.lastIndexOf('endstream');
    if (!begin || end === -1) return Buffer.alloc(0);
    const from = object.start + begin.index + begin[0].length;
    const bytes = pdf.subarray(from, object.start + end);
    return /\/FlateDecode/.test(object.body.slice(0, begin.index)) ? inflateSync(bytes) : bytes;
  };

  const unicodeMaps = new Map<number, { width: number; map: Map<string, string> }>();
  const unicodeOf = (fontRef: number) => {
    const cached = unicodeMaps.get(fontRef);
    if (cached) return cached;
    const map = new Map<string, string>();
    let width = 2;
    const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(body(fontRef));
    if (toUnicode) {
      const cmap = stream(Number(toUnicode[1])).toString('latin1');
      const decode = (hex: string) => Buffer.from(hex, 'hex').swap16().toString('utf16le');
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of (section[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
          width = (pair[1] ?? '').length / 2;
          map.set((pair[1] ?? '').toUpperCase(), decode(pair[2] ?? ''));
        }
      }
      for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const range of (section[1] ?? '').matchAll(
          /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g,
        )) {
          const low = parseInt(range[1] ?? '0', 16);
          const high = parseInt(range[2] ?? '0', 16);
          width = (range[1] ?? '').length / 2;
          const targets = (range[3] ?? '').startsWith('[')
            ? [...(range[3] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => decode(m[1] ?? ''))
            : null;
          const first = targets === null ? parseInt((range[3] ?? '').slice(1, -1), 16) : 0;
          for (let code = low; code <= high; code += 1) {
            const key = code
              .toString(16)
              .toUpperCase()
              .padStart(width * 2, '0');
            map.set(
              key,
              targets === null
                ? String.fromCodePoint(first + code - low)
                : (targets[code - low] ?? ''),
            );
          }
        }
      }
    }
    const result = { width, map };
    unicodeMaps.set(fontRef, result);
    return result;
  };

  // The page tree, in order. Chrome nests it for longer documents.
  const leaves = (ref: number): number[] => {
    const node = body(ref);
    if (!/\/Type\s*\/Pages\b/.test(node)) return [ref];
    const kids = /\/Kids \[([^\]]*)\]/.exec(node)?.[1] ?? '';
    return [...kids.matchAll(/(\d+) 0 R/g)].flatMap((kid) => leaves(Number(kid[1])));
  };
  const root = /\/Root (\d+) 0 R/.exec(raw);
  const pagesRef = /\/Pages (\d+) 0 R/.exec(body(Number(root?.[1])));
  return leaves(Number(pagesRef?.[1])).map((ref) => {
    const page = body(ref);
    const fonts = new Map(
      [...(/\/Font <<([\s\S]*?)>>/.exec(page)?.[1] ?? '').matchAll(/\/(\S+) (\d+) 0 R/g)].map(
        (font) => [font[1] ?? '', Number(font[2])],
      ),
    );
    const contents = /\/Contents (\d+) 0 R/.exec(page);
    const content = stream(Number(contents?.[1])).toString('latin1');
    let font: { width: number; map: Map<string, string> } = { width: 2, map: new Map() };
    let text = '';
    // Chrome wraps glyphs whose ToUnicode is a compatibility character (a Kangxi radical for 方, for example)
    // in a marked-content span with the real text as ActualText. The glyphs inside such a span are skipped.
    let actual: string | null = null;
    const spans: Array<boolean> = [];
    const decode = (hex: string) =>
      Buffer.from(hex, 'hex')
        .swap16()
        .toString('utf16le')
        .replace(/^\uFEFF/, '');
    for (const token of content.matchAll(
      /\/ActualText\s*<([0-9A-Fa-f\s]*)>|\bBDC\b|\bEMC\b|\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>|\bET\b/g,
    )) {
      if (token[1] !== undefined) {
        actual = decode(token[1].replace(/\s/g, ''));
      } else if (token[0] === 'BDC') {
        spans.push(actual !== null);
        if (actual !== null) text += actual;
        actual = null;
      } else if (token[0] === 'EMC') {
        spans.pop();
      } else if (token[2] !== undefined) {
        font = unicodeOf(fonts.get(token[2]) ?? -1);
      } else if (token[3] !== undefined) {
        if (spans.includes(true)) continue;
        const hex = token[3].replace(/\s/g, '').toUpperCase();
        for (let at = 0; at < hex.length; at += font.width * 2) {
          text += font.map.get(hex.slice(at, at + font.width * 2)) ?? '';
        }
      } else {
        text += '\n';
      }
    }
    return text;
  });
}
