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
import { useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react';

import { isSafeLink, MARKDOWN_PARSE_OPTIONS } from './analysis.ts';
import { classifyLink } from './references.ts';

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

export interface MarkdownViewProps {
  // parseMarkdownDocumentの結果。解析はworkerで行い、描画だけをここで行う。
  document: MarkdownDocument;
  // 画像の参照を、表示できるURLへ直す。表示できなければnull。指定がなければ、画像は表示しない。
  resolveImage?: (src: string) => string | null;
  // localの文書へのlinkが押されたときに呼ばれる。指定がなければ、linkとして扱わない。
  onOpenLink?: (href: string) => void;
  // code blockの上に置く操作（copyなど）。表示しているcodeは、操作の要素から`codeOfBlock`で読む。
  codeActions?: ReactNode;
}

// code blockの中の要素（操作のbuttonなど）から、そのcode blockが表示しているcode
// （色付けのための要素を除いた文字列）を読む。
export function codeOfBlock(element: Element): string {
  return element.closest('[data-code-block]')?.querySelector('pre code')?.textContent ?? '';
}

type Components = NonNullable<Parameters<typeof renderMarkdownReact>[1]>['components'];

// URLは解析の時点で絞っている（analysis.ts）。描画でも同じ条件を確かめ、
// 別の経路で作られたASTが渡されても、危険なlinkや画像の読み込みを出さない。
function createComponents(
  resolveImage: MarkdownViewProps['resolveImage'],
  onOpenLink: MarkdownViewProps['onOpenLink'],
  codeActions: MarkdownViewProps['codeActions'],
): Components {
  function Link({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>): ReactNode {
    if (!href) return <span>{children}</span>;
    if (isSafeLink(href)) {
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
    // localの文書へのlink。遷移はせず、開いてよいかを本体で確かめてから開く。
    if (onOpenLink && classifyLink(href).kind === 'document') {
      return (
        <button type="button" data-local-link="" onClick={() => onOpenLink(href)}>
          {children}
        </button>
      );
    }
    return <span>{children}</span>;
  }

  // 表示できるのは、登録済みのlocal fileだけ。それ以外は読み込まず、代替textだけを示す。
  function Image({ src, alt, title }: ComponentPropsWithoutRef<'img'>): ReactNode {
    const url = typeof src === 'string' ? (resolveImage?.(src) ?? null) : null;
    if (url === null) {
      return <span data-blocked-image="">{alt ? `[画像: ${alt}]` : '[画像]'}</span>;
    }
    return (
      <img src={url} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" />
    );
  }

  // code block。操作（codeActions）は、各code blockの上に置く。操作の中の要素から、
  // その要素が属するcode blockのcodeを`codeOfBlock`で読む。
  function Pre({ children, ...rest }: ComponentPropsWithoutRef<'pre'>): ReactNode {
    if (codeActions === undefined) return <pre {...rest}>{children}</pre>;
    return (
      <div data-code-block="">
        <div data-code-actions="">{codeActions}</div>
        <pre {...rest}>{children}</pre>
      </div>
    );
  }

  return { a: Link, img: Image, pre: Pre };
}

export function MarkdownView({
  document,
  resolveImage,
  onOpenLink,
  codeActions,
}: MarkdownViewProps): ReactNode {
  const components = useMemo(
    () => createComponents(resolveImage, onOpenLink, codeActions),
    [resolveImage, onOpenLink, codeActions],
  );
  return renderMarkdownReact(document, {
    ...MARKDOWN_PARSE_OPTIONS,
    allowHtml: false,
    highlighter: safeHighlighter,
    components,
  });
}
