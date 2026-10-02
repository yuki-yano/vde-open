import { parseMarkdown } from '@tanstack/markdown/parser';
import type {
  BlockNode,
  InlineNode,
  MarkdownDocument,
  ParseOptions,
  UrlTransform,
} from '@tanstack/markdown';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

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

export interface DocumentAnalysis {
  title: string | null;
  outline: OutlineItem[];
}

// 見出しのanchor。parserに任せると日本語の見出しがすべて同じslugになるので、
// parserが渡す位置の番号から作る。連番にはならないが、文書内で一意になる。
const headingAnchor = (_text: string, index: number): string => `h${String(index + 1)}`;

const SAFE_LINK = /^(https?:|mailto:)/i;

export function isSafeLink(url: string): boolean {
  return url.startsWith('#') || SAFE_LINK.test(url);
}

// URLは解析の時点で絞る。linkは外部のhttp(s)・mailtoと、文書内の見出しだけを残す。
// 画像は読み込まない。localの画像は、P3の限定asset経由で表示する。
const urlTransform: UrlTransform = (url, kind) => {
  if (kind === 'image') return null;
  return isSafeLink(url) ? url : null;
};

// serverとUIで同じ解析条件を使う。生HTMLは常に無効。
export const MARKDOWN_PARSE_OPTIONS: ParseOptions = {
  allowHtml: false,
  frontmatter: true,
  headingIds: headingAnchor,
  urlTransform,
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

// root直下の見出しを文書順に扱う（仕様8.3）。引用や箇条書きの中の見出しは節にしない。
export function analyzeMarkdown(source: string): DocumentAnalysis {
  const document = parseMarkdownDocument(source);
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  for (const node of document.children) {
    if (node.type !== 'heading') continue;
    headings.push({
      level: node.depth,
      title: collapse(inlineText(node.children)),
      anchor: node.id ?? '',
    });
  }
  const outline = buildOutline(headings);
  return { title: outline.find((item) => item.title !== '')?.title ?? null, outline };
}

type HtmlNode = DefaultTreeAdapterMap['node'];

function htmlText(node: HtmlNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  // 実行される内容や表示されない内容は、見出しの文字として拾わない。
  if (node.nodeName === 'script' || node.nodeName === 'style' || node.nodeName === 'template')
    return '';
  let text = '';
  for (const child of node.childNodes) text += htmlText(child);
  return text;
}

// HTMLは静的に解析するだけで、scriptは実行しない（仕様8.4）。
export function analyzeHtml(source: string): DocumentAnalysis {
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  let title: string | null = null;
  let visited = 0;
  const walk = (node: HtmlNode, depth: number): void => {
    visited += 1;
    if (visited > PARSER_LIMITS.maxNodes) throw new ParseLimitError('nodes');
    if (node.nodeName === 'script' || node.nodeName === 'style' || node.nodeName === 'template')
      return;
    if ('tagName' in node) {
      if (node.tagName === 'title' && title === null) {
        const text = collapse(htmlText(node));
        if (text !== '') title = text;
      }
      const match = /^h([1-6])$/.exec(node.tagName);
      if (match) {
        const id = node.attrs.find((attribute) => attribute.name === 'id')?.value;
        headings.push({
          level: Number(match[1]),
          title: collapse(htmlText(node)),
          anchor: id ?? `h${String(headings.length + 1)}`,
        });
      }
    }
    if ('childNodes' in node) {
      // HTMLの入れ子は深くなりやすい。構造の上限ではなく、再帰の安全のために打ち切る。
      if (depth > 512) throw new ParseLimitError('depth');
      for (const child of node.childNodes) walk(child, depth + 1);
    }
  };
  walk(parse(source), 0);
  return { title, outline: buildOutline(headings) };
}

export function analyzeDocument(source: string, format: 'markdown' | 'html'): DocumentAnalysis {
  return format === 'markdown' ? analyzeMarkdown(source) : analyzeHtml(source);
}
