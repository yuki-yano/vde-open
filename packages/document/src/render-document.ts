// 1つの版を表示するための変換をまとめて行う。daemonの解析workerから呼ぶ。
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
  // 登録済みのCSS fileの内容。参照を調べ直してから配信する。
  stylesheets: Array<{ logicalPath: string; text: string }>;
}

export interface RenderOutput {
  // 変換後のHTML。Markdownは本体で描画するのでnull。
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
  const result = transformStaticHtml(staticInput, log);
  return { html: result.html, stylesheets, links: result.links, diagnostics: result.diagnostics };
}

export type ScanKind = 'markdown' | 'html' | 'css';

// 文書またはCSSが参照するlocal fileの候補を集める。
export function scanReferences(kind: ScanKind, source: string): ScannedReference[] {
  if (kind === 'markdown') return scanMarkdownReferences(source);
  if (kind === 'html') return scanHtmlReferences(source);
  return scanCssReferences(source, 'stylesheet');
}
