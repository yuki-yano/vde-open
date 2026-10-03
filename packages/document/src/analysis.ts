import { parseMarkdown } from '@tanstack/markdown/parser';
import type {
  BlockNode,
  InlineNode,
  MarkdownDocument,
  ParseOptions,
  UrlTransform,
} from '@tanstack/markdown';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

import { classifyLink, isRelativeReference } from './references.ts';

// Limits on the parse result (spec 7.4). A document beyond them is a parse error and falls back to the source view.
export const PARSER_LIMITS = { maxNodes: 100_000, maxDepth: 64 } as const;

export class ParseLimitError extends Error {
  readonly limit: 'nodes' | 'depth';

  constructor(limit: 'nodes' | 'depth') {
    super(`The document structure exceeds the limit: ${limit}.`);
    this.name = 'ParseLimitError';
    this.limit = limit;
  }
}

export interface OutlineItem {
  // Starts at sec_0001. sec_0000 is used for the preamble before the first heading. Stable only within a revision.
  sectionId: string;
  level: number;
  title: string;
  // Titles of the ancestor headings and of this heading.
  headingPath: string[];
  // Anchor in the view. Assigned by the same rules as the UI rendering.
  anchor: string;
}

// Unit of search and partial reads (spec 8.3). The text from a heading up to just before the next heading.
// Text under a lower heading is not folded into the upper section. Ancestor headings are passed in headingPath.
export interface Section {
  // A heading section has the same number as in the outline. sec_0000 is the preamble before the first heading.
  sectionId: string;
  // Heading depth. 0 for the preamble.
  level: number;
  title: string;
  headingPath: string[];
  // Extracted text (excluding the heading text). The displayed characters, not the source.
  text: string;
}

export interface DocumentAnalysis {
  title: string | null;
  outline: OutlineItem[];
  sections: Section[];
}

// Heading anchor. Left to the parser, Japanese headings would all get the same slug,
// so it is built from the position index the parser passes. Not sequential, but unique within the document.
const headingAnchor = (_text: string, index: number): string => `h${String(index + 1)}`;

const SAFE_LINK = /^(https?:|mailto:)/i;

export function isSafeLink(url: string): boolean {
  return url.startsWith('#') || SAFE_LINK.test(url);
}

// URLs are narrowed at parse time.
// Images keep only relative references from the document. Only registered local files can be shown (checked by the renderer).
// Links keep external http(s) and mailto, headings in the document, and relative links to local documents.
export const markdownUrlTransform: UrlTransform = (url, kind) => {
  if (kind === 'image') return isRelativeReference(url) ? url : null;
  return isSafeLink(url) || classifyLink(url).kind === 'document' ? url : null;
};

// The server and the UI use the same parse options. Raw HTML is always disabled.
export const MARKDOWN_PARSE_OPTIONS: ParseOptions = {
  allowHtml: false,
  frontmatter: true,
  headingIds: headingAnchor,
  urlTransform: markdownUrlTransform,
};

export function parseMarkdownDocument(source: string): MarkdownDocument {
  const document = parseMarkdown(source, MARKDOWN_PARSE_OPTIONS);
  assertWithinLimits(document);
  return document;
}

export function sectionIdOf(index: number): string {
  return `sec_${String(index).padStart(4, '0')}`;
}

export function inlineText(nodes: InlineNode[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        text += node.value;
        break;
      case 'strong':
      case 'emphasis':
      case 'strike':
      case 'link':
      case 'inlineComponent':
        text += inlineText(node.children);
        break;
      case 'image':
        text += node.alt;
        break;
      case 'break':
        text += ' ';
        break;
      default:
        break;
    }
  }
  return text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countInline(nodes: InlineNode[], depth: number, budget: { nodes: number }): void {
  if (depth > PARSER_LIMITS.maxDepth) throw new ParseLimitError('depth');
  for (const node of nodes) {
    budget.nodes += 1;
    if (budget.nodes > PARSER_LIMITS.maxNodes) throw new ParseLimitError('nodes');
    if ('children' in node) countInline(node.children, depth + 1, budget);
  }
}

function countBlocks(nodes: BlockNode[], depth: number, budget: { nodes: number }): void {
  if (depth > PARSER_LIMITS.maxDepth) throw new ParseLimitError('depth');
  for (const node of nodes) {
    budget.nodes += 1;
    if (budget.nodes > PARSER_LIMITS.maxNodes) throw new ParseLimitError('nodes');
    switch (node.type) {
      case 'heading':
      case 'paragraph':
        countInline(node.children, depth + 1, budget);
        break;
      case 'blockquote':
      case 'callout':
      case 'component':
        countBlocks(node.children, depth + 1, budget);
        break;
      case 'list':
        for (const item of node.items) countBlocks(item.children, depth + 1, budget);
        break;
      case 'table':
        for (const cell of node.header) countInline(cell.children, depth + 1, budget);
        for (const row of node.rows) {
          for (const cell of row) countInline(cell.children, depth + 1, budget);
        }
        break;
      case 'footnotes':
        for (const item of node.items) countBlocks(item.children, depth + 1, budget);
        break;
      default:
        break;
    }
  }
}

export function assertWithinLimits(document: MarkdownDocument): void {
  countBlocks(document.children, 1, { nodes: 0 });
}

function buildOutline(
  headings: Array<{ level: number; title: string; anchor: string }>,
): OutlineItem[] {
  const outline: OutlineItem[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  for (const [index, heading] of headings.entries()) {
    while (stack.length > 0 && (stack.at(-1) as { level: number }).level >= heading.level)
      stack.pop();
    stack.push({ level: heading.level, title: heading.title });
    outline.push({
      sectionId: sectionIdOf(index + 1),
      level: heading.level,
      title: heading.title,
      headingPath: stack.map((entry) => entry.title),
      anchor: heading.anchor,
    });
  }
  return outline;
}

function blockText(node: BlockNode): string {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      return collapse(inlineText(node.children));
    case 'code':
      return node.value;
    case 'html':
      // Raw HTML is not executed; it is shown as text. Search also treats it as the written text.
      return node.value;
    case 'blockquote':
    case 'component':
      return blocksText(node.children);
    case 'callout':
      return [collapse(node.title), blocksText(node.children)]
        .filter((part) => part !== '')
        .join('\n');
    case 'list':
    case 'footnotes':
      return node.items
        .map((item) => blocksText(item.children))
        .filter((part) => part !== '')
        .join('\n');
    case 'table':
      return [node.header, ...node.rows]
        .map((row) => row.map((cell) => collapse(inlineText(cell.children))).join(' '))
        .join('\n');
    default:
      return '';
  }
}

// Structure depth is checked against the limit (64 levels) at parse time.
function blocksText(nodes: BlockNode[]): string {
  return nodes
    .map(blockText)
    .filter((part) => part !== '')
    .join('\n\n');
}

function buildSections(outline: OutlineItem[], preamble: string, texts: string[]): Section[] {
  const sections: Section[] = [];
  // A document with neither headings nor text still has one empty preamble, so a section found by search can be read by the same ID.
  if (preamble !== '' || outline.length === 0) {
    sections.push({
      sectionId: sectionIdOf(0),
      level: 0,
      title: '',
      headingPath: [],
      text: preamble,
    });
  }
  for (const [index, item] of outline.entries()) {
    sections.push({
      sectionId: item.sectionId,
      level: item.level,
      title: item.title,
      headingPath: item.headingPath,
      text: texts[index] ?? '',
    });
  }
  return sections;
}

// Headings directly under the root, in document order (spec 8.3). Headings inside quotes or lists do not become sections.
export function analyzeMarkdown(source: string): DocumentAnalysis {
  const document = parseMarkdownDocument(source);
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  // Text per heading. The first entry is the preamble before the first heading.
  const bodies: BlockNode[][] = [[]];
  for (const node of document.children) {
    if (node.type === 'heading') {
      headings.push({
        level: node.depth,
        title: collapse(inlineText(node.children)),
        anchor: node.id ?? '',
      });
      bodies.push([]);
    } else (bodies.at(-1) as BlockNode[]).push(node);
  }
  const outline = buildOutline(headings);
  const [preamble, ...texts] = bodies.map(blocksText);
  return {
    title: outline.find((item) => item.title !== '')?.title ?? null,
    outline,
    sections: buildSections(outline, preamble ?? '', texts),
  };
}

type HtmlNode = DefaultTreeAdapterMap['node'];

// Executed content, hidden content and form field values are not collected as text (spec 8.4).
const HTML_SKIPPED = new Set(['script', 'style', 'template', 'textarea', 'select', 'title']);
// Elements that start a new line before and after.
const HTML_BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
]);
const HTML_CELLS = new Set(['td', 'th']);

// Text inside an element. Children with executed or hidden content are not visited.
function htmlText(node: HtmlNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  let text = '';
  for (const child of node.childNodes) {
    if (!HTML_SKIPPED.has(child.nodeName)) text += htmlText(child);
  }
  return text;
}

// Collapse whitespace per line and drop empty lines.
function tidy(text: string): string {
  return text
    .split('\n')
    .map(collapse)
    .filter((line) => line !== '')
    .join('\n');
}

// HTML is only analyzed statically; scripts never run (spec 8.4).
// Extracts the title, the headings, and the text of the body and code. Visibility set by CSS and content scripts create later are not reproduced.
export function analyzeHtml(source: string): DocumentAnalysis {
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  // Text per heading. The first entry is the preamble before the first heading.
  const bodies: string[] = [''];
  let title: string | null = null;
  let visited = 0;
  const append = (text: string) => {
    bodies[bodies.length - 1] += text;
  };
  const walk = (node: HtmlNode, depth: number): void => {
    visited += 1;
    if (visited > PARSER_LIMITS.maxNodes) throw new ParseLimitError('nodes');
    if (node.nodeName === '#text' && 'value' in node) {
      append(node.value);
      return;
    }
    if ('tagName' in node) {
      if (node.tagName === 'title' && title === null) {
        const text = collapse(htmlText(node));
        if (text !== '') title = text;
      }
      if (HTML_SKIPPED.has(node.tagName)) return;
      const match = /^h([1-6])$/.exec(node.tagName);
      if (match) {
        const id = node.attrs.find((attribute) => attribute.name === 'id')?.value;
        headings.push({
          level: Number(match[1]),
          title: collapse(htmlText(node)),
          anchor: id ?? `h${String(headings.length + 1)}`,
        });
        // Heading text is not part of the body. From here to the next heading is this section's text.
        bodies.push('');
        return;
      }
    }
    if ('childNodes' in node) {
      // HTML nesting easily gets deep. This cutoff is for recursion safety, not a structure limit.
      if (depth > 512) throw new ParseLimitError('depth');
      const separator = HTML_BLOCKS.has(node.nodeName)
        ? '\n'
        : HTML_CELLS.has(node.nodeName)
          ? ' '
          : '';
      append(separator);
      for (const child of node.childNodes) walk(child, depth + 1);
      append(separator);
    }
  };
  // Parse assuming scripts do not run. The contents of noscript are collected as displayed text too.
  walk(parse(source, { scriptingEnabled: false }), 0);
  const outline = buildOutline(headings);
  const [preamble, ...texts] = bodies.map(tidy);
  return { title, outline, sections: buildSections(outline, preamble ?? '', texts) };
}

export function analyzeDocument(source: string, format: 'markdown' | 'html'): DocumentAnalysis {
  return format === 'markdown' ? analyzeMarkdown(source) : analyzeHtml(source);
}
