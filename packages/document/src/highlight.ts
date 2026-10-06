// Code highlighting shared by the management UI (React) and the print document (HTML string).
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
import type { CodeHighlighter } from '@tanstack/markdown';

// Upper limit of a code block to highlight (spec 7.4). Larger blocks are shown without coloring.
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

// Languages are registered explicitly. Unregistered languages are not colored.
const highlighter = createHighlighter({
  languages: [js, jsx, ts, tsx, json, yaml, html, css, shell, markdown, plaintext],
});
const registered = new Set(highlighter.listLanguages());
const highlightAdapter = createTanStackMarkdownHighlighter(highlighter);

export const safeHighlighter: CodeHighlighter = (code, lang, options) => {
  const normalized = lang ? highlighter.normalizeLanguage(lang) : 'plaintext';
  const usable = registered.has(normalized) && code.length <= MAX_HIGHLIGHT_CHARS;
  return highlightAdapter(code, usable ? normalized : 'plaintext', options);
};
