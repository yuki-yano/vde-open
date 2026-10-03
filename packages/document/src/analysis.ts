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

// 解析結果の上限（仕様7.4）。超えた文書は解析errorとし、原文の表示へ切り替える。
export const PARSER_LIMITS = { maxNodes: 100_000, maxDepth: 64 } as const;

export class ParseLimitError extends Error {
  readonly limit: 'nodes' | 'depth';

  constructor(limit: 'nodes' | 'depth') {
    super(`文書の構造が上限を超えています: ${limit}`);
    this.name = 'ParseLimitError';
    this.limit = limit;
  }
}

export interface OutlineItem {
  // sec_0001から始まる。sec_0000は最初の見出しより前の序文に使う。revisionの中でだけ安定。
  sectionId: string;
  level: number;
  title: string;
  // 祖先の見出しと自分自身のtitle。
  headingPath: string[];
  // 表示上のanchor。UIの描画と同じ規則で付ける。
  anchor: string;
}

// 検索と部分取得の単位（仕様8.3）。見出しから、次の見出しの直前までの本文。
// 下位の見出しの本文は、上位の節へ重ねて入れない。祖先の見出しはheadingPathで渡す。
export interface Section {
  // 見出しの節はoutlineと同じ番号。sec_0000は、最初の見出しより前の序文。
  sectionId: string;
  // 見出しの深さ。序文は0。
  level: number;
  title: string;
  headingPath: string[];
  // 抽出した本文（見出しの文字は含まない）。原文ではなく、表示される文字を取り出したもの。
  text: string;
}

export interface DocumentAnalysis {
  title: string | null;
  outline: OutlineItem[];
  sections: Section[];
}

// 見出しのanchor。parserに任せると日本語の見出しがすべて同じslugになるので、
// parserが渡す位置の番号から作る。連番にはならないが、文書内で一意になる。
const headingAnchor = (_text: string, index: number): string => `h${String(index + 1)}`;

const SAFE_LINK = /^(https?:|mailto:)/i;

export function isSafeLink(url: string): boolean {
  return url.startsWith('#') || SAFE_LINK.test(url);
}

// URLは解析の時点で絞る。
// 画像は、文書からの相対参照だけを残す。表示できるのは、登録済みのlocal fileだけ（描画側で確かめる）。
// linkは、外部のhttp(s)・mailto、文書内の見出し、localの文書への相対linkを残す。
export const markdownUrlTransform: UrlTransform = (url, kind) => {
  if (kind === 'image') return isRelativeReference(url) ? url : null;
  return isSafeLink(url) || classifyLink(url).kind === 'document' ? url : null;
};

// serverとUIで同じ解析条件を使う。生HTMLは常に無効。
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
      // 生HTMLは実行せず、文字として表示している。検索でも、書かれた文字として扱う。
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

// 構造の深さは、解析の時点で上限（64段）を確かめている。
function blocksText(nodes: BlockNode[]): string {
  return nodes
    .map(blockText)
    .filter((part) => part !== '')
    .join('\n\n');
}

function buildSections(outline: OutlineItem[], preamble: string, texts: string[]): Section[] {
  const sections: Section[] = [];
  // 見出しも本文もない文書も、空の序文を1つ持つ。検索で見つけた節を、同じIDで取得できるようにする。
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

// root直下の見出しを文書順に扱う（仕様8.3）。引用や箇条書きの中の見出しは節にしない。
export function analyzeMarkdown(source: string): DocumentAnalysis {
  const document = parseMarkdownDocument(source);
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  // 見出しごとの本文。先頭は、最初の見出しより前の序文。
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

// 実行される内容、表示されない内容、入力欄の値は、文字として拾わない（仕様8.4）。
const HTML_SKIPPED = new Set(['script', 'style', 'template', 'textarea', 'select', 'title']);
// 前後で行を分ける要素。
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

// 要素の中の文字。実行される内容や表示されない内容を持つ子は辿らない。
function htmlText(node: HtmlNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  let text = '';
  for (const child of node.childNodes) {
    if (!HTML_SKIPPED.has(child.nodeName)) text += htmlText(child);
  }
  return text;
}

// 行ごとに空白をまとめ、空の行を除く。
function tidy(text: string): string {
  return text
    .split('\n')
    .map(collapse)
    .filter((line) => line !== '')
    .join('\n');
}

// HTMLは静的に解析するだけで、scriptは実行しない（仕様8.4）。
// 取り出すのは、titleと見出しと、本文・codeの文字。CSSでの表示の有無や、scriptが後から作る内容は再現しない。
export function analyzeHtml(source: string): DocumentAnalysis {
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  // 見出しごとの本文。先頭は、最初の見出しより前の序文。
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
        // 見出しの文字は、本文には入れない。ここから次の見出しまでが、この節の本文。
        bodies.push('');
        return;
      }
    }
    if ('childNodes' in node) {
      // HTMLの入れ子は深くなりやすい。構造の上限ではなく、再帰の安全のために打ち切る。
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
  // scriptは動かさない前提で解析する。noscriptの中身も、表示される文字として拾う。
  walk(parse(source, { scriptingEnabled: false }), 0);
  const outline = buildOutline(headings);
  const [preamble, ...texts] = bodies.map(tidy);
  return { title, outline, sections: buildSections(outline, preamble ?? '', texts) };
}

export function analyzeDocument(source: string, format: 'markdown' | 'html'): DocumentAnalysis {
  return format === 'markdown' ? analyzeMarkdown(source) : analyzeHtml(source);
}
