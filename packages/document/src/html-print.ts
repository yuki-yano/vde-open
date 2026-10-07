// Static HTML for printing. CSS stays in separate, sanitized files so @import cycles and media rules
// keep their browser semantics. Images and fonts are embedded by the daemon, without crossing the worker.
import { defaultTreeAdapter, html, parse, parseFragment, serialize } from 'parse5';

import { transformCss } from './css-transform.ts';
import { DiagnosticLog, resolveAssetUrl, transformStaticHtml } from './html-static.ts';
import { dirnameOfLogicalPath, type AssetRole } from './references.ts';

export interface HtmlPrintInput {
  source: string;
  title: string;
  documentLogicalPath: string;
  assets: Array<{ logicalPath: string; role: AssetRole }>;
  stylesheets: Array<{ logicalPath: string; text: string }>;
  assetSlot: string;
}

export interface HtmlPrintOutput {
  html: string;
  stylesheets: Array<{ name: string; css: string }>;
}

const PRINT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' file:; base-uri 'none'; form-action 'none'";

export function renderHtmlPrintDocument(input: HtmlPrintInput): HtmlPrintOutput {
  if (!/^[0-9a-f]{32,}$/.test(input.assetSlot))
    throw new Error('The asset slot must be random hexadecimal.');
  const assets = new Map(input.assets.map(({ logicalPath, role }) => [logicalPath, role]));
  const readable = new Set(input.stylesheets.map(({ logicalPath }) => logicalPath));
  const urls = new Map<string, string>();
  input.assets.forEach(({ logicalPath, role }, index) => {
    if (role === 'style' && readable.has(logicalPath))
      urls.set(logicalPath, `asset-${String(index)}.css`);
    else if (role === 'image' || role === 'svg' || role === 'font')
      urls.set(logicalPath, `${input.assetSlot}-${String(index)}`);
  });
  const log = new DiagnosticLog();
  const transformed = transformStaticHtml(
    {
      source: input.source,
      documentLogicalPath: input.documentLogicalPath,
      assets,
      assetUrls: urls,
    },
    log,
  );
  const stylesheets = input.stylesheets.flatMap(({ logicalPath, text }) => {
    const name = urls.get(logicalPath);
    if (name === undefined || assets.get(logicalPath) !== 'style') return [];
    return [
      {
        name,
        css: transformCss(text, 'stylesheet', (url, context) =>
          resolveAssetUrl(url, context, dirnameOfLogicalPath(logicalPath), assets, log, {
            assetUrls: urls,
          }),
        ).css,
      },
    ];
  });
  const document = parse(transformed.html, { scriptingEnabled: false });
  const root = document.childNodes.find((node) => 'tagName' in node && node.tagName === 'html');
  const head =
    root && 'childNodes' in root
      ? root.childNodes.find((node) => 'tagName' in node && node.tagName === 'head')
      : undefined;
  if (!head || !('tagName' in head)) throw new Error('The HTML document has no head.');
  // Defaults precede the author's CSS, including @page and @media print. No Markdown typography or margin boxes.
  const prefix = parseFragment(
    head,
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}"><style>@page { size: A4; margin: 20mm; }</style>`,
    {},
  ).childNodes;
  for (const node of prefix) node.parentNode = head;
  head.childNodes.unshift(...prefix);
  if (!head.childNodes.some((node) => 'tagName' in node && node.tagName === 'title')) {
    const title = defaultTreeAdapter.createElement('title', html.NS.HTML, []);
    defaultTreeAdapter.insertText(title, input.title);
    defaultTreeAdapter.appendChild(head, title);
  }
  return { html: serialize(document), stylesheets };
}
