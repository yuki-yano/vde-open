// Transform an HTML document into its viewable form (spec 10.4). static has no scripts; interactive keeps only registered scripts.
// Rewrites the parse5 syntax tree and serializes it. No regex replacement on the HTML string.
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

import {
  fragmentOfAnchor,
  htmlHeadings,
  htmlIdOf,
  ParseLimitError,
  PARSER_LIMITS,
  type HtmlHeading,
} from './analysis.ts';
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
  // Location of the document (relative to the assets-root). Base for resolving relative references.
  documentLogicalPath: string;
  // Logical paths and roles of the assets that can be served.
  assets: ReadonlyMap<string, AssetRole>;
  // interactive: keep the document's scripts and event handlers (loading only registered script files). Default is static.
  interactive?: boolean;
  // SDK for communication between the HTML and the host, inserted as the first script (interactive only).
  sdkScript?: string;
}

// A heading the view can be moved to with `#anchor`. sectionId and anchor are the ones in the outline.
export interface HeadingTarget {
  sectionId: string;
  anchor: string;
}

export interface StaticHtmlResult {
  html: string;
  links: StaticLink[];
  diagnostics: StaticDiagnostic[];
  // Static only. Empty in interactive, whose output gets no added ids.
  headingTargets: HeadingTarget[];
}

// Elements removed with their descendants, and the reason.
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

// Attributes removed on any element. They lead to navigation, submission, external requests or permission changes.
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

// Traversal policy. Shared by the transform and the reference scan.
interface Policy {
  // Whether to keep scripts and event handlers (interactive).
  interactive: boolean;
  // The URL to output when the reference is kept, or null to remove it.
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

// Collect the text inside an element. No recursion, however deep the nesting.
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

// Inspect each srcset candidate and return only the ones that can be kept.
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

// Inspect the element's attributes. Returns false when the whole element is removed.
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

  // Files referenced by scripts are not used in the static view but are included in the document revision.
  // In interactive, only registered files are loaded. A script that cannot be loaded is removed as a whole.
  if (tag === 'script') {
    const src = getAttribute(element, 'src');
    if (src !== undefined) {
      const resolved = policy.asset(src, 'script');
      if (policy.interactive) {
        if (resolved === null) return false;
        element.attrs = element.attrs.map((attribute) =>
          attribute.name === 'src' ? { ...attribute, value: resolved } : attribute,
        );
      }
    }
  }

  const isAnchor = tag === 'a' || tag === 'area';
  const isMedia = tag === 'video' || tag === 'audio' || tag === 'track';
  const kept: HtmlElement['attrs'] = [];
  let handlers = 0;
  for (const attribute of element.attrs) {
    const name = attribute.name;
    if (!ATTRIBUTE_NAME.test(name)) continue;
    if (name.startsWith('on')) {
      if (policy.interactive) kept.push(attribute);
      else handlers += 1;
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
        // Keep only in-document navigation. Other links are disabled and made openable from the host's list.
        if (classifyLink(attribute.value).kind === 'fragment') kept.push(attribute);
        else policy.link(attribute.value, textOf(element));
      }
      continue;
    }
    if (name === 'src') {
      if (tag === 'script') {
        if (policy.interactive) kept.push(attribute);
        continue;
      }
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

// Walk the syntax tree and remove the elements to drop. No recursion, however deep the nesting.
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
        // Inline SVG and MathML can carry scripts and external references, so they are removed.
        policy.note(
          child.namespaceURI === SVG_NAMESPACE ? 'inline-svg-removed' : 'mathml-removed',
          null,
        );
        continue;
      }
      if (child.tagName === 'script' && policy.interactive) {
        if (rewriteElement(child, policy)) kept.push(child);
        else policy.note('script-not-loaded', null);
        continue;
      }
      const removal = REMOVED_ELEMENTS[child.tagName];
      if (removal !== undefined) {
        if (child.tagName === 'script') rewriteElement(child, policy);
        policy.note(removal, null);
        continue;
      }
      if (child.tagName === 'noscript') {
        // In static, scripts do not run, so the contents of noscript are shown as is. The element is removed and its contents kept.
        // In interactive, scripts run, so the contents of noscript are not shown. The whole element is removed.
        if (policy.interactive) policy.note('noscript-removed', null);
        else pending.splice(index + 1, 0, ...child.childNodes);
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

// Parse the transformed output again and check that no element or attribute leading to execution or navigation remains.
// In interactive, only scripts and event handlers are allowed.
function assertOutput(html: string, interactive: boolean): void {
  const stack: HtmlNode[] = [parse(html, { scriptingEnabled: false })];
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (isElement(node)) {
      const unsafe =
        node.namespaceURI !== HTML_NAMESPACE ||
        (REMOVED_ELEMENTS[node.tagName] !== undefined &&
          !(interactive && node.tagName === 'script')) ||
        (interactive && node.tagName === 'noscript') ||
        node.attrs.some(
          (attribute) =>
            (attribute.name.startsWith('on') && !interactive) ||
            REMOVED_ATTRIBUTES.has(attribute.name),
        );
      if (unsafe) throw new Error(`unsafe output: ${node.tagName}`);
      if (node.tagName === 'template' && 'content' in node) stack.push(node.content);
    }
    if (isParent(node)) for (const child of node.childNodes) stack.push(child);
  }
}

// Count why the view differs from the original document, by kind and target.
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

// Resolve a reference into a URL that can stay in the view. A reference that cannot stay becomes null, and the reason is recorded.
// baseDir is the directory of the file (document or CSS) that contains the reference.
export function resolveAssetUrl(
  url: string,
  context: ReferenceContext,
  baseDir: string,
  assets: ReadonlyMap<string, AssetRole>,
  log: DiagnosticLog,
  options: { scripts?: boolean } = {},
): string | null {
  const shown = url.slice(0, MAX_TARGET_LENGTH);
  const reference = classifyReference(url, baseDir);
  if (reference.kind === 'fragment') {
    // In CSS, `url(#id)` is an in-document reference. In an HTML attribute it would load the document itself, so it is removed.
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
  // The static view uses no scripts (the whole element is removed).
  if (context === 'script' && options.scripts !== true) return null;
  return `${relativeUrlTo(baseDir, reference.logicalPath)}${reference.suffix}`;
}

export function transformStaticHtml(
  input: StaticHtmlInput,
  log: DiagnosticLog = new DiagnosticLog(),
): StaticHtmlResult {
  const baseDir = dirnameOfLogicalPath(input.documentLogicalPath);
  const links: StaticLink[] = [];
  const linkIds = new Set<string>();
  const interactive = input.interactive === true;

  const policy: Policy = {
    interactive,
    note: (code, target) => log.note(code, target),
    asset: (url, context) =>
      resolveAssetUrl(url, context, baseDir, input.assets, log, { scripts: interactive }),
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

  // Parse the contents of noscript as ordinary elements. With the default setting the contents pass through as text
  // and escape removal (in interactive, the whole noscript element is removed).
  const document = parse(input.source, { scriptingEnabled: false });
  // In static, give each heading the id its outline anchor names, before elements are removed (the numbering covers
  // headings the view removes too). Interactive output is left as written, so its scripts and CSS see no added ids.
  const headings = interactive ? [] : htmlHeadings(document);
  for (const heading of headings) setId(heading.element, heading.anchor);
  rewriteTree(document, policy);
  if (interactive && input.sdkScript !== undefined) insertFirstScript(document, input.sdkScript);
  const html = serialize(document);
  assertOutput(html, interactive);
  return { html, links, diagnostics: log.list(), headingTargets: reachable(document, headings) };
}

function setId(element: HtmlElement, id: string): void {
  if (htmlIdOf(element) === id) return;
  const kept = element.attrs.filter((attribute) => attribute.name !== 'id');
  element.attrs = [...kept, { name: 'id', value: id }];
}

// The headings the view reaches with the fragment of their anchor: still in the shown document after the transform, and
// the element the browser picks for that fragment (the contents of template are not shown). The browser first looks
// for the fragment as written, as an id and then as the name of an a element, and only then for its percent-decoded
// form (HTML Standard, the indicated part of the document). So the heading must be the first element with its id, and
// when the fragment differs from the anchor (an encoded anchor), nothing may answer to the fragment as written.
function reachable(document: HtmlParent, headings: HtmlHeading[]): HeadingTarget[] {
  if (headings.length === 0) return [];
  const present = new Set<HtmlElement>();
  const firstById = new Map<string, HtmlElement>();
  const anchorNames = new Set<string>();
  const stack: HtmlNode[] = [document];
  while (stack.length > 0) {
    const node = stack.pop() as HtmlNode;
    if (isElement(node)) {
      present.add(node);
      const id = htmlIdOf(node);
      if (id !== null && !firstById.has(id)) firstById.set(id, node);
      const name = node.tagName === 'a' ? getAttribute(node, 'name') : undefined;
      if (name !== undefined && name !== '') anchorNames.add(name);
    }
    if (isParent(node)) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index] as HtmlNode);
      }
    }
  }
  return headings
    .filter(({ element, anchor }) => {
      if (!present.has(element) || firstById.get(anchor) !== element) return false;
      const fragment = fragmentOfAnchor(anchor);
      return fragment === anchor || (!firstById.has(fragment) && !anchorNames.has(fragment));
    })
    .map(({ sectionId, anchor }) => ({ sectionId, anchor }));
}

// Insert the script as the first child of head. It runs before any script in the document.
function insertFirstScript(document: HtmlParent, source: string): void {
  if (source.toLowerCase().includes('</script'))
    throw new Error('script text must not close itself');
  const html = document.childNodes.find(
    (node): node is HtmlElement => isElement(node) && node.tagName === 'html',
  );
  const head = html?.childNodes.find(
    (node): node is HtmlElement => isElement(node) && node.tagName === 'head',
  );
  if (!head) throw new Error('document has no head');
  const script: HtmlElement = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [],
    namespaceURI: HTML_NAMESPACE as HtmlElement['namespaceURI'],
    childNodes: [],
    parentNode: head,
    sourceCodeLocation: null,
  };
  script.childNodes = [{ nodeName: '#text', value: source, parentNode: script }];
  head.childNodes.unshift(script);
}

// Collect candidate local files the HTML references. Includes references inside style elements and style attributes.
export function scanHtmlReferences(source: string): ScannedReference[] {
  const references: ScannedReference[] = [];
  const policy: Policy = {
    interactive: false,
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
