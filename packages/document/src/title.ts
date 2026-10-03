import { parseMarkdown } from '@tanstack/markdown/parser';
import type { InlineNode } from '@tanstack/markdown';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];

// Length of the source head used to infer the title, so a huge document is not parsed in full on every registration.
const TITLE_SCAN_CHARS = 64 * 1024;
const MAX_TITLE_LENGTH = 160;

function inlineText(nodes: InlineNode[]): string {
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

function normalize(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return Array.from(collapsed).slice(0, MAX_TITLE_LENGTH).join('');
}

function markdownTitle(source: string): string | null {
  const document = parseMarkdown(source, { allowHtml: false, frontmatter: true });
  for (const node of document.children) {
    if (node.type === 'heading') return normalize(inlineText(node.children));
  }
  return null;
}

function findElement(node: Node, tagName: string): Node | null {
  if ('tagName' in node && node.tagName === tagName) return node;
  if (!('childNodes' in node)) return null;
  for (const child of node.childNodes) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

function htmlTitle(source: string): string | null {
  const title = findElement(parse(source), 'title');
  if (!title || !('childNodes' in title)) return null;
  let text = '';
  for (const child of title.childNodes) {
    if (child.nodeName === '#text' && 'value' in child) text += child.value;
  }
  return normalize(text);
}

// The first heading, or the HTML title. null when none is found (the caller uses the filename or similar).
export function extractTitle(source: string, format: 'markdown' | 'html'): string | null {
  const head = source.slice(0, TITLE_SCAN_CHARS);
  return format === 'markdown' ? markdownTitle(head) : htmlTitle(head);
}
