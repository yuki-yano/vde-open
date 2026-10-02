// HTML文書を、scriptなしで表示する形へ変換する（仕様10.4）。
// parse5の構文木を書き換えて出力する。HTMLの文字列への正規表現の置換はしない。
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

import { ParseLimitError, PARSER_LIMITS } from './analysis.ts';
import { transformCss, type CssKind } from './css-transform.ts';
import {
  classifyLink,
  classifyReference,
  dirnameOfLogicalPath,
  hasHiddenSegment,
  assetTypeOf,
  isRasterDataMime,
  relativeUrlTo,
  roleAllowed,
  type AssetRole,
  type ReferenceContext,
} from './references.ts';

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlParent = DefaultTreeAdapterMap['parentNode'];
type HtmlChild = DefaultTreeAdapterMap['childNode'];

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export interface StaticLink {
  linkId: string;
  href: string;
  text: string;
  kind: 'external' | 'document' | 'other';
}

export interface StaticDiagnostic {
  code: string;
  target: string | null;
  count: number;
}

export interface ScannedReference {
  url: string;
  context: ReferenceContext;
}

export interface StaticHtmlInput {
  source: string;
  // 文書の位置（assets-rootからの相対path）。相対参照を解決する基準になる。
  documentLogicalPath: string;
  // 配信できるassetのlogical pathと種別。
  assets: ReadonlyMap<string, AssetRole>;
}

export interface StaticHtmlResult {
  html: string;
  links: StaticLink[];
  diagnostics: StaticDiagnostic[];
}

// 子孫ごと取り除く要素と、その理由。
const REMOVED_ELEMENTS: Record<string, string> = {
  script: 'script-removed',
  iframe: 'embed-removed',
  frame: 'embed-removed',
  frameset: 'embed-removed',
  object: 'embed-removed',
  embed: 'embed-removed',
  applet: 'embed-removed',
  portal: 'embed-removed',
  base: 'base-removed',
  plaintext: 'element-removed',
  noembed: 'element-removed',
  noframes: 'element-removed',
};

// 要素にかかわらず取り除く属性。遷移、送信、外部への要求、権限の変更につながるもの。
const REMOVED_ATTRIBUTES = new Set([
  'srcdoc',
  'ping',
  'download',
  'target',
  'formtarget',
  'formaction',
  'action',
  'autofocus',
  'nonce',
  'integrity',
  'crossorigin',
  'referrerpolicy',
  'attributionsrc',
  'manifest',
  'data',
  'codebase',
  'archive',
  'classid',
  'code',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'profile',
  'icon',
  'xlink:href',
  'xml:base',
  'imagesrcset',
]);

const NETWORK_HINTS = new Set([
  'prefetch',
  'dns-prefetch',
  'preconnect',
  'preload',
  'modulepreload',
  'prerender',
]);

const ATTRIBUTE_NAME = /^[a-z_][a-z0-9_.:-]*$/;
const MAX_LINKS = 2000;
const MAX_DIAGNOSTICS = 500;
const MAX_TARGET_LENGTH = 200;
const MAX_LINK_TEXT = 120;

// 走査の方針。変換と、参照の収集で共有する。
interface Policy {
  // 参照を残すなら出力するURL、取り除くならnull。
  asset(url: string, context: ReferenceContext): string | null;
  link(href: string, text: string): void;
  note(code: string, target: string | null): void;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

function isParent(node: HtmlNode): node is HtmlParent {
  return 'childNodes' in node;
}

function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// 要素の中の文字を集める。入れ子が深くても再帰しない。
function textOf(root: HtmlNode): string {
  let text = '';
  const stack: HtmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (node.nodeName === '#text' && 'value' in node) text += node.value;
    else if (isParent(node) && node.nodeName !== 'script' && node.nodeName !== 'style') {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index] as HtmlNode);
      }
    }
    if (text.length > MAX_LINK_TEXT * 4) break;
  }
  return collapse(text).slice(0, MAX_LINK_TEXT);
}

function rewriteCss(source: string, kind: CssKind, policy: Policy): string {
  const result = transformCss(source, kind, (url, context) => policy.asset(url, context));
  if (result.invalid > 0) policy.note('css-invalid', null);
  return result.css;
}

// srcsetの各候補を調べ、残せるものだけを返す。
function rewriteSrcset(value: string, policy: Policy): string {
  const kept: string[] = [];
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim();
    if (trimmed === '') continue;
    const space = trimmed.search(/\s/);
    const url = space === -1 ? trimmed : trimmed.slice(0, space);
    const descriptor = space === -1 ? '' : trimmed.slice(space).trim();
    const resolved = policy.asset(url, 'image');
    if (resolved !== null) kept.push(descriptor === '' ? resolved : `${resolved} ${descriptor}`);
  }
  return kept.join(', ');
}

// 要素の属性を調べる。要素ごと取り除くならfalse。
function rewriteElement(element: HtmlElement, policy: Policy): boolean {
  const tag = element.tagName;

  if (tag === 'meta') {
    const equiv = getAttribute(element, 'http-equiv');
    if (equiv !== undefined) {
      if (equiv.trim().toLowerCase() === 'refresh') policy.note('meta-refresh-removed', null);
      return false;
    }
    if ((getAttribute(element, 'name') ?? '').trim().toLowerCase() === 'referrer') return false;
  }

  if (tag === 'link') {
    const rel = (getAttribute(element, 'rel') ?? '').toLowerCase().split(/\s+/);
    const isStylesheet = rel.includes('stylesheet') && !rel.includes('alternate');
    if (!isStylesheet) {
      if (rel.some((token) => NETWORK_HINTS.has(token))) policy.note('network-hint-removed', null);
      return false;
    }
    const href = getAttribute(element, 'href');
    const resolved = href === undefined ? null : policy.asset(href, 'style');
    if (resolved === null) return false;
    element.attrs = element.attrs.map((attribute) =>
      attribute.name === 'href' ? { ...attribute, value: resolved } : attribute,
    );
  }

  // scriptが参照するfileは、表示では使わないが、文書の版には含める。
  if (tag === 'script') {
    const src = getAttribute(element, 'src');
    if (src !== undefined) policy.asset(src, 'script');
  }

  const isAnchor = tag === 'a' || tag === 'area';
  const isMedia = tag === 'video' || tag === 'audio' || tag === 'track';
  const kept: HtmlElement['attrs'] = [];
  let handlers = 0;
  for (const attribute of element.attrs) {
    const name = attribute.name;
    if (!ATTRIBUTE_NAME.test(name)) continue;
    if (name.startsWith('on')) {
      handlers += 1;
      continue;
    }
    if (REMOVED_ATTRIBUTES.has(name)) {
      if (name === 'action' || name === 'formaction') policy.note('form-action-removed', null);
      continue;
    }
    if (name === 'style') {
      const css = rewriteCss(attribute.value, 'declarations', policy);
      if (css !== '') kept.push({ ...attribute, value: css });
      continue;
    }
    if (name === 'href') {
      if (tag === 'link') kept.push(attribute);
      else if (isAnchor) {
        // 文書内の移動だけを残す。それ以外のlinkは無効にして、本体の一覧から開けるようにする。
        if (classifyLink(attribute.value).kind === 'fragment') kept.push(attribute);
        else policy.link(attribute.value, textOf(element));
      }
      continue;
    }
    if (name === 'src') {
      const isImage =
        tag === 'img' ||
        (tag === 'input' && (getAttribute(element, 'type') ?? '').toLowerCase() === 'image');
      if (isImage) {
        const resolved = policy.asset(attribute.value, 'image');
        if (resolved !== null) kept.push({ ...attribute, value: resolved });
      } else if (isMedia || tag === 'source') {
        policy.note('media-blocked', attribute.value.slice(0, MAX_TARGET_LENGTH));
      }
      continue;
    }
    if (name === 'srcset') {
      if (tag === 'img' || tag === 'source') {
        const value = rewriteSrcset(attribute.value, policy);
        if (value !== '') kept.push({ ...attribute, value });
      }
      continue;
    }
    if (name === 'poster' || name === 'background') {
      const resolved = policy.asset(attribute.value, 'image');
      if (resolved !== null) kept.push({ ...attribute, value: resolved });
      continue;
    }
    kept.push(attribute);
  }
  if (handlers > 0) policy.note('event-handler-removed', null);
  element.attrs = kept;
  return true;
}

// 構文木を走査し、取り除く要素を外す。入れ子が深くても再帰しない。
function rewriteTree(root: HtmlParent, policy: Policy): void {
  let visited = 0;
  const stack: HtmlParent[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop() as HtmlParent;
    const pending = [...parent.childNodes];
    const kept: HtmlChild[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const child = pending[index] as HtmlChild;
      visited += 1;
      if (visited > PARSER_LIMITS.maxNodes) throw new ParseLimitError('nodes');
      if (child.nodeName === '#comment') continue;
      if (!isElement(child)) {
        kept.push(child);
        continue;
      }
      if (child.namespaceURI !== HTML_NAMESPACE) {
        // 文書に埋め込まれたSVGとMathMLは、scriptや外部参照を持てるので取り除く。
        policy.note(
          child.namespaceURI === SVG_NAMESPACE ? 'inline-svg-removed' : 'mathml-removed',
          null,
        );
        continue;
      }
      const removal = REMOVED_ELEMENTS[child.tagName];
      if (removal !== undefined) {
        if (child.tagName === 'script') rewriteElement(child, policy);
        policy.note(removal, null);
        continue;
      }
      if (child.tagName === 'noscript') {
        // scriptは動かないので、noscriptの中身をそのまま表示する。要素を外して中身を残す。
        pending.splice(index + 1, 0, ...child.childNodes);
        continue;
      }
      if (!rewriteElement(child, policy)) continue;
      if (child.tagName === 'style') {
        const css = rewriteCss(textOfStyle(child), 'stylesheet', policy);
        child.childNodes = [{ nodeName: '#text', value: css, parentNode: child }];
        kept.push(child);
        continue;
      }
      kept.push(child);
      stack.push(child);
      if (child.tagName === 'template' && 'content' in child) stack.push(child.content);
    }
    parent.childNodes = kept;
    for (const child of kept) child.parentNode = parent;
  }
}

function textOfStyle(element: HtmlElement): string {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeName === '#text' && 'value' in child) text += child.value;
  }
  return text;
}

// 変換後の出力をもう一度解析し、実行や遷移につながる要素・属性が残っていないことを確かめる。
function assertStaticOutput(html: string): void {
  const stack: HtmlNode[] = [parse(html, { scriptingEnabled: false })];
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (isElement(node)) {
      const unsafe =
        node.namespaceURI !== HTML_NAMESPACE ||
        REMOVED_ELEMENTS[node.tagName] !== undefined ||
        node.attrs.some(
          (attribute) => attribute.name.startsWith('on') || REMOVED_ATTRIBUTES.has(attribute.name),
        );
      if (unsafe) throw new Error(`unsafe static output: ${node.tagName}`);
      if (node.tagName === 'template' && 'content' in node) stack.push(node.content);
    }
    if (isParent(node)) for (const child of node.childNodes) stack.push(child);
  }
}

// 元の文書と表示が異なる理由を、種類と対象ごとに数える。
export class DiagnosticLog {
  readonly #entries = new Map<string, StaticDiagnostic>();

  note(code: string, target: string | null): void {
    const key = `${code}\n${target ?? ''}`;
    const existing = this.#entries.get(key);
    if (existing) existing.count += 1;
    else if (this.#entries.size < MAX_DIAGNOSTICS) {
      this.#entries.set(key, { code, target, count: 1 });
    }
  }

  list(): StaticDiagnostic[] {
    return [...this.#entries.values()];
  }
}

// 参照を、表示へ残せるURLへ直す。残せない参照はnullにして、理由を記録する。
// baseDirは、参照を含むfile（文書、またはCSS）のdirectory。
export function resolveAssetUrl(
  url: string,
  context: ReferenceContext,
  baseDir: string,
  assets: ReadonlyMap<string, AssetRole>,
  log: DiagnosticLog,
): string | null {
  const shown = url.slice(0, MAX_TARGET_LENGTH);
  const reference = classifyReference(url, baseDir);
  if (reference.kind === 'fragment') {
    // CSSの`url(#id)`は文書内の参照。HTMLの属性では、文書自身を読み込むことになるので外す。
    return context === 'css-url' ? url : null;
  }
  if (reference.kind === 'data') {
    const usable =
      (context === 'image' || context === 'css-url') && isRasterDataMime(reference.mime);
    if (!usable) log.note('data-url-blocked', reference.mime === '' ? null : reference.mime);
    return usable ? url : null;
  }
  if (reference.kind === 'remote') {
    log.note('remote-asset-blocked', shown);
    return null;
  }
  if (reference.kind === 'rejected') {
    if (reference.reason !== 'empty') log.note('asset-rejected', shown);
    return null;
  }
  const role = assets.get(reference.logicalPath);
  if (role === undefined) {
    if (hasHiddenSegment(reference.logicalPath)) log.note('asset-hidden', reference.logicalPath);
    else if (assetTypeOf(reference.logicalPath) === null) {
      log.note('asset-unsupported', reference.logicalPath);
    } else log.note('asset-not-registered', reference.logicalPath);
    return null;
  }
  if (!roleAllowed(context, role)) {
    log.note('asset-unsupported', reference.logicalPath);
    return null;
  }
  // scriptは表示では使わない（要素ごと取り除く）。
  if (context === 'script') return null;
  return `${relativeUrlTo(baseDir, reference.logicalPath)}${reference.suffix}`;
}

export function transformStaticHtml(
  input: StaticHtmlInput,
  log: DiagnosticLog = new DiagnosticLog(),
): StaticHtmlResult {
  const baseDir = dirnameOfLogicalPath(input.documentLogicalPath);
  const links: StaticLink[] = [];
  const linkIds = new Set<string>();

  const policy: Policy = {
    note: (code, target) => log.note(code, target),
    asset: (url, context) => resolveAssetUrl(url, context, baseDir, input.assets, log),
    link(href, text) {
      log.note('link-disabled', null);
      const target = classifyLink(href);
      if (target.kind === 'fragment' || links.length >= MAX_LINKS) return;
      const shown = href.trim().slice(0, 2000);
      if (linkIds.has(shown)) return;
      linkIds.add(shown);
      const linkId = `lnk_${String(links.length + 1).padStart(4, '0')}`;
      links.push({ linkId, href: shown, text, kind: target.kind });
    },
  };

  // scriptは動かさないので、noscriptの中身を通常の要素として解析する。
  // 既定の設定では中身が文字として素通りし、取り除く対象から漏れる。
  const document = parse(input.source, { scriptingEnabled: false });
  rewriteTree(document, policy);
  const html = serialize(document);
  assertStaticOutput(html);
  return { html, links, diagnostics: log.list() };
}

// HTMLが参照するlocal fileの候補を集める。style要素とstyle属性の中の参照も含む。
export function scanHtmlReferences(source: string): ScannedReference[] {
  const references: ScannedReference[] = [];
  const policy: Policy = {
    asset(url, context) {
      references.push({ url, context });
      return url;
    },
    link: () => undefined,
    note: () => undefined,
  };
  rewriteTree(parse(source, { scriptingEnabled: false }), policy);
  return references;
}
