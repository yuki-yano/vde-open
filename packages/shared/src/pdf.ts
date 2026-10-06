// Characters that cannot be in a file name on common systems, and control characters.
const UNSAFE_FILE_NAME = /[\\/:*?"<>|\p{Cc}]/gu;
// File systems limit a name to 255 bytes. Leave room for ".pdf" and the " (1)" a browser adds to a duplicate.
const MAX_NAME_BYTES = 200;

function utf8Length(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

// File name of the PDF exported from a document: the source file name with the extension .pdf (README.md → README.pdf).
// A document without a path (read from stdin) uses its title.
export function pdfFileName(document: { displayPath: string | null; title: string }): string {
  const { displayPath, title } = document;
  let name = title;
  if (displayPath !== null) {
    const base = displayPath.slice(
      Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\')) + 1,
    );
    const dot = base.lastIndexOf('.');
    name = dot > 0 ? base.slice(0, dot) : base;
  }
  let safe = '';
  let bytes = 0;
  for (const character of name.replace(UNSAFE_FILE_NAME, '_').trim()) {
    bytes += utf8Length(character);
    if (bytes > MAX_NAME_BYTES) break;
    safe += character;
  }
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');
  return `${safe === '' ? 'document' : safe}.pdf`;
}
