// MarkdownのReact描画。TanStack Markdown／Highlightへの参照は、このpackageの中に閉じる。
import { createHighlighter } from '@tanstack/highlight';
import {
  css,
  html,
  js,
  json,
  jsx,
  markdown,
  plaintext,
  shell,
  ts,
  tsx,
  yaml,
} from '@tanstack/highlight/languages';
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown';
import type { CodeHighlighter, MarkdownDocument } from '@tanstack/markdown';
import { renderMarkdownReact } from '@tanstack/markdown/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { isSafeLink, MARKDOWN_PARSE_OPTIONS } from './analysis.ts';

// highlightするcode blockの上限（仕様7.4）。超える場合は色付けせずに表示する。
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

// 言語は明示的に登録する。未登録の言語は色付けしない。
const highlighter = createHighlighter({
  languages: [js, jsx, ts, tsx, json, yaml, html, css, shell, markdown, plaintext],
});
const registered = new Set(highlighter.listLanguages());
const highlightAdapter = createTanStackMarkdownHighlighter(highlighter);

const safeHighlighter: CodeHighlighter = (code, lang, options) => {
  const normalized = lang ? highlighter.normalizeLanguage(lang) : 'plaintext';
  const usable = registered.has(normalized) && code.length <= MAX_HIGHLIGHT_CHARS;
  return highlightAdapter(code, usable ? normalized : 'plaintext', options);
};

// URLは解析の時点で絞っている（analysis.ts）。描画でも同じ条件を確かめ、
// 別の経路で作られたASTが渡されても、危険なlinkや画像の読み込みを出さない。
function Link({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>): ReactNode {
  if (!href || !isSafeLink(href)) return <span>{children}</span>;
  if (href.startsWith('#')) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

// 画像は読み込まず、代替textだけを示す。
function BlockedImage({ alt }: ComponentPropsWithoutRef<'img'>): ReactNode {
  return <span data-blocked-image="">{alt ? `[画像: ${alt}]` : '[画像]'}</span>;
}

export interface MarkdownViewProps {
  // parseMarkdownDocumentの結果。解析はworkerで行い、描画だけをここで行う。
  document: MarkdownDocument;
}

export function MarkdownView({ document }: MarkdownViewProps): ReactNode {
  return renderMarkdownReact(document, {
    ...MARKDOWN_PARSE_OPTIONS,
    allowHtml: false,
    highlighter: safeHighlighter,
    components: { a: Link, img: BlockedImage },
  });
}
