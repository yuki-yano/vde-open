// Print document for the PDF export. Renders one Markdown revision into a single HTML document that a headless
// browser prints. The document loads nothing: no scripts, no network, no files.
// Used by the daemon's print worker; kept out of the management UI bundle.
import type { MarkdownExtension, RenderOptions } from '@tanstack/markdown';
import { renderBlock, renderDocument } from '@tanstack/markdown/html';

import { MARKDOWN_PARSE_OPTIONS, parseMarkdownDocument } from './analysis.ts';
import { safeHighlighter } from './highlight.ts';
import { PRINT_STYLE, printPageStyle } from './print-style.ts';
import { localImagePath, renderedLinkOf } from './rendering-rules.ts';

export {
  renderHtmlPrintDocument,
  type HtmlPrintInput,
  type HtmlPrintOutput,
} from './html-print.ts';

export interface PrintInput {
  source: string;
  // Shown in the page header (shortened) and as the PDF title.
  title: string;
  documentLogicalPath: string;
  // Logical paths of the registered images of the revision (roles image and svg). Other images show their alt text.
  images: string[];
  // Unguessable marker. A registered image gets `src="<imageSlot>-<index into images>"`, which the caller replaces
  // with a data URL while writing the page, so image bytes never pass through the worker.
  imageSlot: string;
}

const PRINT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// Kana or Hangul tells the language, which decides the glyphs of Han characters and the language of the tagged PDF.
const KANA = /[\u3041-\u3096\u30a1-\u30fa]/;
const HANGUL = /[\uac00-\ud7af]/;
const IMAGE_SLOT = /^[0-9a-f]{32,}$/;
// A code block up to this many lines is kept on one page. Longer blocks continue on the next page.
const KEEP_TOGETHER_LINES = 25;
// The page header shows at most this many characters of the title.
const HEADER_TITLE_LENGTH = 60;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

// A CSS string literal. Everything except letters, digits and spaces is a hexadecimal escape,
// so the title can close neither the string nor the style element.
export function cssString(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += /^[A-Za-z0-9 ]$/.test(character)
      ? character
      : `\\${(character.codePointAt(0) ?? 0xfffd).toString(16)} `;
  }
  return `"${escaped}"`;
}

export function headerTitle(title: string): string {
  const characters = Array.from(title);
  return characters.length > HEADER_TITLE_LENGTH
    ? `${characters.slice(0, HEADER_TITLE_LENGTH - 1).join('')}…`
    : title;
}

// Images and links follow the same rules as the management UI (rendering-rules.ts). Every image and link node
// is rendered here, so none falls through to the default output of the renderer.
function printNodes(input: PrintInput, baseOptions: RenderOptions): MarkdownExtension {
  const images = new Map(input.images.map((logicalPath, index) => [logicalPath, index]));
  return {
    name: 'vde-open-print',
    renderHtml(node, context) {
      if (node.type === 'image') {
        const logicalPath = localImagePath(node.src, input.documentLogicalPath);
        const index = logicalPath === null ? undefined : images.get(logicalPath);
        if (index === undefined) {
          const text = node.alt ? `[image: ${node.alt}]` : '[image]';
          return `<span class="blocked-image">${escapeHtml(text)}</span>`;
        }
        const title = node.title ? ` title="${escapeHtml(node.title)}"` : '';
        return `<img src="${input.imageSlot}-${String(index)}" alt="${escapeHtml(node.alt)}"${title}>`;
      }
      if (node.type === 'link') {
        const children = node.children.map((child) => context.renderInline(child)).join('');
        const kind = renderedLinkOf(node.href);
        if (kind !== 'fragment' && kind !== 'external') return children;
        const title = node.title ? ` title="${escapeHtml(node.title)}"` : '';
        return `<a href="${escapeHtml(node.href)}"${title}>${children}</a>`;
      }
      // A short code block moves to the next page as a whole instead of splitting.
      if (node.type === 'code' && node.value.split('\n').length <= KEEP_TOGETHER_LINES) {
        return `<div class="keep-together">${renderBlock(node, baseOptions)}</div>`;
      }
      return undefined;
    },
  };
}

export function renderPrintDocument(input: PrintInput): string {
  if (!IMAGE_SLOT.test(input.imageSlot))
    throw new Error('The image slot must be random hexadecimal.');
  const baseOptions: RenderOptions = {
    ...MARKDOWN_PARSE_OPTIONS,
    allowHtml: false,
    highlighter: safeHighlighter,
  };
  const body = renderDocument(parseMarkdownDocument(input.source), {
    ...baseOptions,
    extensions: [printNodes(input, baseOptions)],
  });
  // Otherwise no lang: the browser then uses its own language, and nothing wrong is claimed.
  const lang = KANA.test(input.source)
    ? ' lang="ja"'
    : HANGUL.test(input.source)
      ? ' lang="ko"'
      : '';
  return [
    '<!doctype html>',
    `<html${lang}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${printPageStyle(cssString(headerTitle(input.title)))}${PRINT_STYLE}</style>`,
    '</head>',
    `<body><main class="document">${body}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
