// Styles of the print document (PDF export). A white document for paper; the management UI palette is not used.
// Colors of text on the code background (#f6f8fa) are at least 4.5:1, and keywords are bold so they stay apart in a
// monochrome print. Comments are not italic, since Japanese fonts have no italic and would be slanted mechanically.

// The macOS system font (San Francisco, with Hiragino for Japanese), then named fonts. Not system-ui: on Japanese
// Windows it resolves to Yu Gothic UI, which is meant for UI text.
const SANS = [
  '-apple-system',
  'BlinkMacSystemFont',
  "'Hiragino Sans'",
  "'Hiragino Kaku Gothic ProN'",
  "'Segoe UI'",
  "'Yu Gothic Medium'",
  "'Yu Gothic'",
  'Meiryo',
  "'Noto Sans CJK JP'",
  "'Noto Sans JP'",
  'sans-serif',
].join(', ');

const MONO = [
  'ui-monospace',
  "'SF Mono'",
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  "'Liberation Mono'",
  "'Hiragino Sans'",
  "'Yu Gothic Medium'",
  "'Noto Sans CJK JP'",
  'monospace',
].join(', ');

// Page box with the title in the header and the page number in the footer. The title is a CSS string already escaped
// by the caller (string-set is not supported by Chrome).
export function printPageStyle(cssTitle: string): string {
  return `@page {
  size: A4;
  margin: 20mm;
  @top-left {
    content: ${cssTitle};
    vertical-align: bottom;
    padding-bottom: 6mm;
    font: 8pt/1.4 ${SANS};
    color: #57606a;
  }
  @bottom-center {
    content: counter(page) " / " counter(pages);
    vertical-align: top;
    padding-top: 6mm;
    font: 8pt/1.4 ${SANS};
    color: #57606a;
  }
}`;
}

const CHECK_MARK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='%23ffffff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

export const PRINT_STYLE = `
:root {
  color-scheme: light;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
*, *::before, *::after {
  box-sizing: border-box;
}
html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
}
body {
  font-family: ${SANS};
  font-size: 10.5pt;
  line-height: 1.75;
  color: #1f2328;
  font-kerning: normal;
  overflow-wrap: anywhere;
}
.document > :first-child {
  margin-top: 0;
}
h1, h2, h3, h4, h5, h6 {
  margin: 1.7em 0 0.6em;
  font-weight: 600;
  line-height: 1.35;
  color: #111418;
  break-after: avoid;
}
h1 {
  font-size: 20pt;
  font-weight: 700;
  padding-bottom: 0.3em;
  border-bottom: 1.5pt solid #1f2328;
}
h2 {
  font-size: 14.5pt;
  padding-bottom: 0.25em;
  border-bottom: 0.75pt solid #d0d7de;
}
h3 {
  font-size: 12pt;
}
h4 {
  font-size: 10.5pt;
}
h5, h6 {
  font-size: 10pt;
  color: #57606a;
}
p, ul, ol, table, pre, blockquote, figure, .keep-together {
  margin: 0.8em 0;
}
p, li, blockquote {
  orphans: 3;
  widows: 3;
}
ul, ol {
  padding-left: 1.6em;
}
ul {
  list-style: disc;
}
ol {
  list-style: decimal;
}
li + li, li > ul, li > ol {
  margin-top: 0.2em;
}
li > ul, li > ol, li > p:last-child {
  margin-bottom: 0;
}
li > p:first-child {
  margin-top: 0;
}
li:has(> input[type='checkbox']), li:has(> p:first-child > input[type='checkbox']) {
  list-style: none;
  margin-left: -1.4em;
}
input[type='checkbox'] {
  appearance: none;
  width: 0.95em;
  height: 0.95em;
  margin: 0 0.45em 0 0;
  border: 1pt solid #57606a;
  border-radius: 2pt;
  vertical-align: -0.12em;
  background: #ffffff;
}
input[type='checkbox']:checked {
  border-color: #1f2328;
  background: #1f2328 ${CHECK_MARK} center / 90% no-repeat;
}
a {
  color: #0969da;
  text-decoration: underline;
  text-decoration-color: #9cc3ec;
  text-underline-offset: 2px;
}
strong {
  font-weight: 600;
}
hr {
  margin: 1.8em 0;
  border: 0;
  border-top: 0.75pt solid #d0d7de;
}
img {
  display: block;
  max-width: 100%;
  max-height: 230mm;
  height: auto;
  margin: 0 auto;
  break-inside: avoid;
}
.blocked-image {
  color: #57606a;
  font-size: 0.9em;
}
blockquote {
  margin-left: 0;
  margin-right: 0;
  padding: 0.1em 1em;
  border-left: 3pt solid #d0d7de;
  color: #57606a;
}
blockquote > :first-child {
  margin-top: 0;
}
blockquote > :last-child {
  margin-bottom: 0;
}
table {
  display: table;
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5pt;
  line-height: 1.55;
}
thead {
  display: table-header-group;
}
tr {
  break-inside: avoid;
}
th, td {
  padding: 0.45em 0.75em;
  border: 0.75pt solid #d0d7de;
  text-align: left;
  vertical-align: top;
}
th {
  background: #f3f5f7;
  font-weight: 600;
}
code, pre {
  font-family: ${MONO};
}
:not(pre) > code {
  padding: 0.1em 0.35em;
  border-radius: 3pt;
  background: #eff2f5;
  font-size: 0.88em;
}
pre {
  padding: 0.8em 1em;
  border: 0.75pt solid #d8dee4;
  border-radius: 4pt;
  background: #f6f8fa;
  font-size: 8.8pt;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.keep-together {
  break-inside: avoid;
}
.keep-together > pre, .keep-together > figure {
  margin: 0;
}
figure.tm-code-frame > figcaption {
  margin-bottom: 0.3em;
  break-after: avoid;
  font-family: ${MONO};
  font-size: 8.5pt;
  color: #57606a;
}
figure.tm-code-frame > pre {
  margin: 0;
}
.th-keyword { color: #cf222e; font-weight: 600; }
.th-string, .th-code-inline, .th-inserted { color: #0a3069; }
.th-number, .th-literal { color: #0550ae; }
.th-comment, .th-meta { color: #59636e; }
.th-function, .th-command, .th-property, .th-link { color: #6639ba; }
.th-tag { color: #116329; }
.th-type, .th-attr, .th-selector, .th-variable { color: #953800; }
.th-heading { color: #0550ae; font-weight: 600; }
.th-deleted { color: #82071e; }
.footnotes {
  margin-top: 2em;
  padding-top: 0.6em;
  border-top: 0.75pt solid #d0d7de;
  font-size: 9pt;
  color: #57606a;
}
.footnotes ol {
  margin: 0;
}
/* The hidden "Footnotes" heading of the renderer would appear in the PDF outline. */
.sr-only {
  display: none;
}
.data-footnote-backref {
  text-decoration: none;
  font-variant-emoji: text;
}
`;
