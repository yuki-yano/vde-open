// Extract CSS references (url(), @import) from the syntax tree and remove the ones not allowed (spec 10.4).
// Rewrites the css-tree syntax tree and serializes it, instead of replacing strings.
import type {
  CssNode,
  Declaration,
  generate as GenerateFn,
  List,
  ListItem,
  parse as ParseFn,
  walk as WalkFn,
  WalkContext,
} from 'css-tree';
// The main css-tree entry reads syntax data from the filesystem, so it cannot be bundled into the distribution.
// Use the standalone entries for parse, walk and generate only. They have no type declarations, so the main entry's types are applied.
// @ts-expect-error standalone entry without type declarations
import generateUntyped from 'css-tree/generator';
// @ts-expect-error standalone entry without type declarations
import parseUntyped from 'css-tree/parser';
// @ts-expect-error standalone entry without type declarations
import walkUntyped from 'css-tree/walker';

const parse = parseUntyped as typeof ParseFn;
const walk = walkUntyped as typeof WalkFn;
const generate = generateUntyped as typeof GenerateFn;

// stylesheet is a CSS file or a style element; declarations is a style attribute.
export type CssKind = 'stylesheet' | 'declarations';

export type CssReferenceContext = 'style' | 'font' | 'css-url';

// Returns the URL to output when the reference is kept, or null to remove it.
export type CssUrlResolver = (url: string, context: CssReferenceContext) => string | null;

export interface CssTransformResult {
  css: string;
  // Number of parts disabled because they could not be parsed.
  invalid: number;
}

// Functions that take a URL as a string.
const STRING_URL_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'src']);
// Functions that substitute a value later. Inside a URL-taking function, what gets fetched cannot be determined.
const INDIRECT_FUNCTIONS = new Set(['var', 'env', 'attr']);
// Legacy mechanisms that fetch or execute. The whole declaration is removed.
const BLOCKED_FUNCTIONS = new Set(['expression']);
const BLOCKED_PROPERTIES = new Set(['behavior', '-moz-binding']);
// A value that could not be parsed and contains a function or an escape may hide a url().
const OPAQUE_VALUE = /[(\\]/;

// keep: keep it. drop: remove it because it contains a reference that is not allowed. invalid: disable it because what gets fetched cannot be determined.
type DeclarationVerdict = 'keep' | 'drop' | 'invalid';

// Inspect the references in a declaration value and rewrite them when the declaration can be kept.
function rewriteDeclaration(
  declaration: Declaration,
  inFontFace: boolean,
  resolve: CssUrlResolver,
): DeclarationVerdict {
  // A declaration whose name uses escapes is read by the browser as a different name. It cannot be judged, so it is disabled.
  if (declaration.property.includes('\\')) return 'invalid';
  const property = declaration.property.toLowerCase();
  if (BLOCKED_PROPERTIES.has(property)) return 'drop';
  const context: CssReferenceContext = inFontFace && property === 'src' ? 'font' : 'css-url';
  let verdict: DeclarationVerdict = 'keep';
  const visit = (url: string): string => {
    const resolved = resolve(url, context);
    if (resolved === null && verdict === 'keep') verdict = 'drop';
    return resolved ?? url;
  };
  walk(declaration.value, (node: CssNode) => {
    if (node.type === 'Raw') {
      if (OPAQUE_VALUE.test(node.value)) verdict = 'invalid';
    } else if (node.type === 'Url') {
      node.value = visit(node.value);
    } else if (node.type === 'Function') {
      const name = node.name.toLowerCase();
      if (name.includes('\\')) verdict = 'invalid';
      else if (BLOCKED_FUNCTIONS.has(name)) verdict = 'drop';
      else if (STRING_URL_FUNCTIONS.has(name)) {
        node.children.forEach((child) => {
          if (child.type === 'String') child.value = visit(child.value);
        });
        // A value substituted from a custom property or similar is fetched as a URL even when it is a string.
        walk(node, (inner: CssNode) => {
          if (inner.type === 'Function' && INDIRECT_FUNCTIONS.has(inner.name.toLowerCase())) {
            verdict = 'invalid';
          }
        });
      }
    }
  });
  return verdict;
}

export function transformCss(
  source: string,
  kind: CssKind,
  resolve: CssUrlResolver,
): CssTransformResult {
  let invalid = 0;
  let ast: CssNode;
  try {
    ast = parse(source, {
      context: kind === 'stylesheet' ? 'stylesheet' : 'declarationList',
      positions: false,
      // Parse custom property values too. Otherwise a url() inside the value is missed.
      parseCustomProperty: true,
      onParseError: () => {
        invalid += 1;
      },
    });
    walk(ast, {
      enter(
        this: WalkContext,
        node: CssNode,
        item: ListItem<CssNode> | null,
        list: List<CssNode> | null,
      ): symbol | undefined {
        if (node.type === 'Declaration') {
          const inFontFace = this.atrule?.name.toLowerCase() === 'font-face';
          const verdict = rewriteDeclaration(node, inFontFace, resolve);
          if (verdict === 'invalid') invalid += 1;
          if (verdict !== 'keep' && item && list) list.remove(item);
          return this.skip;
        }
        if (node.type === 'Atrule') {
          // A rule whose name uses escapes (such as `@\69mport`) is read by the browser as a different rule.
          if (node.name.includes('\\')) {
            invalid += 1;
            if (item && list) list.remove(item);
            return this.skip;
          }
          const name = node.name.toLowerCase();
          // The URL of @namespace is a name, not a fetch target.
          if (name === 'namespace') return this.skip;
          if (name === 'import') {
            const prelude = node.prelude;
            const target =
              prelude?.type === 'AtrulePrelude'
                ? prelude.children.toArray().find((child) => child.type !== 'WhiteSpace')
                : undefined;
            const resolved =
              target?.type === 'Url' || target?.type === 'String'
                ? resolve(target.value, 'style')
                : null;
            if (resolved !== null && (target?.type === 'Url' || target?.type === 'String')) {
              target.value = resolved;
            } else if (item && list) list.remove(item);
            return this.skip;
          }
          if (node.prelude?.type === 'Raw' && OPAQUE_VALUE.test(node.prelude.value)) {
            invalid += 1;
            if (item && list) list.remove(item);
            return this.skip;
          }
          return undefined;
        }
        // A rule whose selector could not be parsed is disabled as a whole.
        if (node.type === 'Rule' && node.prelude.type === 'Raw') {
          invalid += 1;
          if (item && list) list.remove(item);
          return this.skip;
        }
        // An unparsed part that appears directly in a list of rules or declarations. Disabled.
        if (
          node.type === 'Raw' &&
          item &&
          list &&
          this.declaration === null &&
          this.atrulePrelude === null &&
          this.selector === null
        ) {
          invalid += 1;
          list.remove(item);
        }
        return undefined;
      },
    });
    // The output goes inside a style element, so make it impossible to form a closing tag.
    return { css: generate(ast).replaceAll('<', String.raw`\3c `), invalid };
  } catch {
    // CSS that cannot be parsed into a tree is disabled as a whole.
    return { css: '', invalid: invalid + 1 };
  }
}

export interface CssReference {
  url: string;
  context: CssReferenceContext;
}

// Collect the URLs the CSS references, without rewriting.
export function scanCssReferences(source: string, kind: CssKind): CssReference[] {
  const references: CssReference[] = [];
  transformCss(source, kind, (url, context) => {
    references.push({ url, context });
    return url;
  });
  return references;
}
