// Run all transforms needed to show one revision. Called from the daemon's analysis worker.
import { scanCssReferences, transformCss } from './css-transform.ts';
import {
  DiagnosticLog,
  resolveAssetUrl,
  scanHtmlReferences,
  transformStaticHtml,
  type ScannedReference,
  type StaticDiagnostic,
  type StaticLink,
} from './html-static.ts';
import { analyzeMarkdownRender, scanMarkdownReferences } from './markdown-render.ts';
import { dirnameOfLogicalPath, type AssetRole } from './references.ts';

export interface RenderInput {
  format: 'markdown' | 'html';
  source: string;
  documentLogicalPath: string;
  assets: Array<{ logicalPath: string; role: AssetRole }>;
  // Contents of registered CSS files. Their references are re-checked before serving.
  stylesheets: Array<{ logicalPath: string; text: string }>;
  // HTML mode. interactive keeps registered scripts and event handlers.
  mode: 'static' | 'interactive';
  // SDK inserted as the first script into interactive HTML. null to insert none.
  sdkScript: string | null;
}

export interface RenderOutput {
  // Transformed HTML. null for Markdown, which the host renders.
  html: string | null;
  stylesheets: Array<{ logicalPath: string; css: string }>;
  links: StaticLink[];
  diagnostics: StaticDiagnostic[];
}

export function renderDocument(input: RenderInput): RenderOutput {
  const assets = new Map(input.assets.map((asset) => [asset.logicalPath, asset.role]));
  const log = new DiagnosticLog();
  const staticInput = {
    source: input.source,
    documentLogicalPath: input.documentLogicalPath,
    assets,
  };
  const stylesheets = input.stylesheets.map(({ logicalPath, text }) => {
    const baseDir = dirnameOfLogicalPath(logicalPath);
    const result = transformCss(text, 'stylesheet', (url, context) =>
      resolveAssetUrl(url, context, baseDir, assets, log),
    );
    if (result.invalid > 0) log.note('css-invalid', logicalPath);
    return { logicalPath, css: result.css };
  });
  if (input.format === 'markdown') {
    const info = analyzeMarkdownRender(staticInput, log);
    return { html: null, stylesheets, links: info.links, diagnostics: info.diagnostics };
  }
  const result = transformStaticHtml(
    {
      ...staticInput,
      interactive: input.mode === 'interactive',
      ...(input.mode === 'interactive' && input.sdkScript !== null
        ? { sdkScript: input.sdkScript }
        : {}),
    },
    log,
  );
  return { html: result.html, stylesheets, links: result.links, diagnostics: result.diagnostics };
}

export type ScanKind = 'markdown' | 'html' | 'css';

// Collect candidate local files the document or CSS references.
export function scanReferences(kind: ScanKind, source: string): ScannedReference[] {
  if (kind === 'markdown') return scanMarkdownReferences(source);
  if (kind === 'html') return scanHtmlReferences(source);
  return scanCssReferences(source, 'stylesheet');
}
