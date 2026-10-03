// React rendering of Markdown. References to TanStack Markdown and Highlight stay inside this package.
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

// Upper limit of a code block to highlight (spec 7.4). Larger blocks are shown without coloring.
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

// Languages are registered explicitly. Unregistered languages are not colored.
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
  // Result of parseMarkdownDocument. Parsing happens in a worker; only rendering happens here.
  document: MarkdownDocument;
  // Resolve an image reference into a URL that can be shown, or null if it cannot. Without it, no images are shown.
  resolveImage?: (src: string) => string | null;
  // Called when a link to a local document is clicked. Without it, such links are not treated as links.
  onOpenLink?: (href: string) => void;
  // Actions placed above each code block (copy and so on). Read the shown code from an action element with `codeOfBlock`.
  codeActions?: ReactNode;
}

// From an element inside a code block (such as an action button), read the code that block shows
// (the text without the coloring elements).
export function codeOfBlock(element: Element): string {
  return element.closest('[data-code-block]')?.querySelector('pre code')?.textContent ?? '';
}

type Components = NonNullable<Parameters<typeof renderMarkdownReact>[1]>['components'];

// URLs are narrowed at parse time (analysis.ts). Rendering checks the same conditions,
// so an AST built by another path still produces no dangerous links or image loads.
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
    // Link to a local document. No navigation; the host checks whether it may be opened, then opens it.
    if (onOpenLink && classifyLink(href).kind === 'document') {
      return (
        <button type="button" data-local-link="" onClick={() => onOpenLink(href)}>
          {children}
        </button>
      );
    }
    return <span>{children}</span>;
  }

  // Only registered local files can be shown. Anything else is not loaded; only the alt text is shown.
  function Image({ src, alt, title }: ComponentPropsWithoutRef<'img'>): ReactNode {
    const url = typeof src === 'string' ? (resolveImage?.(src) ?? null) : null;
    if (url === null) {
      return <span data-blocked-image="">{alt ? `[image: ${alt}]` : '[image]'}</span>;
    }
    return (
      <img src={url} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" />
    );
  }

  // Code block. The actions (codeActions) are placed above each code block. From an element inside the actions,
  // read the code of the block it belongs to with `codeOfBlock`.
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
