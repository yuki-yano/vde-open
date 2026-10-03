// Inspect the image references and links of a Markdown document. Rendering is done by the host (React),
// so this only decides which images can be shown and which links can be opened.
import type { BlockNode, InlineNode } from '@tanstack/markdown';
import { parseMarkdown } from '@tanstack/markdown/parser';

import {
  assertWithinLimits,
  inlineText,
  MARKDOWN_PARSE_OPTIONS,
  markdownUrlTransform,
} from './analysis.ts';
import {
  DiagnosticLog,
  resolveAssetUrl,
  type ScannedReference,
  type StaticDiagnostic,
  type StaticHtmlInput,
  type StaticLink,
} from './html-static.ts';
import { classifyLink, dirnameOfLogicalPath } from './references.ts';

const MAX_LINKS = 2000;
const MAX_LINK_TEXT = 120;

interface Parsed {
  blocks: BlockNode[];
  // Image URLs written in the document. Includes the ones not shown.
  imageUrls: string[];
}

function parseWithImages(source: string): Parsed {
  const imageUrls: string[] = [];
  const document = parseMarkdown(source, {
    ...MARKDOWN_PARSE_OPTIONS,
    urlTransform: (url, kind, defaultUrl) => {
      if (kind === 'image') imageUrls.push(url);
      return markdownUrlTransform(url, kind, defaultUrl);
    },
  });
  assertWithinLimits(document);
  return { blocks: document.children, imageUrls };
}

function visitInline(nodes: InlineNode[], visit: (node: InlineNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if ('children' in node) visitInline(node.children, visit);
  }
}

// Structure depth is checked against the limit (64 levels) at parse time.
function visitBlocks(nodes: BlockNode[], visit: (node: InlineNode) => void): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
      case 'paragraph':
        visitInline(node.children, visit);
        break;
      case 'blockquote':
      case 'callout':
      case 'component':
        visitBlocks(node.children, visit);
        break;
      case 'list':
      case 'footnotes':
        for (const item of node.items) visitBlocks(item.children, visit);
        break;
      case 'table':
        for (const cell of node.header) visitInline(cell.children, visit);
        for (const row of node.rows) for (const cell of row) visitInline(cell.children, visit);
        break;
      default:
        break;
    }
  }
}

// Collect candidate local images the Markdown references.
export function scanMarkdownReferences(source: string): ScannedReference[] {
  return parseWithImages(source).imageUrls.map((url) => ({ url, context: 'image' }));
}

export interface MarkdownRenderInfo {
  links: StaticLink[];
  diagnostics: StaticDiagnostic[];
}

export function analyzeMarkdownRender(
  input: StaticHtmlInput,
  log: DiagnosticLog = new DiagnosticLog(),
): MarkdownRenderInfo {
  const baseDir = dirnameOfLogicalPath(input.documentLogicalPath);
  const parsed = parseWithImages(input.source);
  // Record why images cannot be shown. The host builds the shown URLs with the same rules.
  for (const url of parsed.imageUrls) resolveAssetUrl(url, 'image', baseDir, input.assets, log);

  const links: StaticLink[] = [];
  const seen = new Set<string>();
  visitBlocks(parsed.blocks, (node) => {
    if (node.type !== 'link' || links.length >= MAX_LINKS || seen.has(node.href)) return;
    const target = classifyLink(node.href);
    if (target.kind === 'fragment') return;
    seen.add(node.href);
    links.push({
      linkId: `lnk_${String(links.length + 1).padStart(4, '0')}`,
      href: node.href,
      text: inlineText(node.children).replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_TEXT),
      kind: target.kind,
    });
  });
  return { links, diagnostics: log.list() };
}
