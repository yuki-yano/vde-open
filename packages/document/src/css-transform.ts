// CSSの参照（url()、@import）を構文木から取り出し、許可されないものを取り除く（仕様10.4）。
// 文字列の置換ではなく、css-treeの構文木を書き換えてから出力する。
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
// css-treeの本体のentryは構文dataをfilesystemから読むため、配布物へbundleできない。
// 解析・走査・出力だけの単体entryを使う。単体entryには型宣言がないので、本体の型を当てる。
// @ts-expect-error 型宣言のない単体entry
import generateUntyped from 'css-tree/generator';
// @ts-expect-error 型宣言のない単体entry
import parseUntyped from 'css-tree/parser';
// @ts-expect-error 型宣言のない単体entry
import walkUntyped from 'css-tree/walker';

const parse = parseUntyped as typeof ParseFn;
const walk = walkUntyped as typeof WalkFn;
const generate = generateUntyped as typeof GenerateFn;

// stylesheetはCSS fileとstyle要素、declarationsはstyle属性。
export type CssKind = 'stylesheet' | 'declarations';

export type CssReferenceContext = 'style' | 'font' | 'css-url';

// 参照を残すなら出力するURL、取り除くならnullを返す。
export type CssUrlResolver = (url: string, context: CssReferenceContext) => string | null;

export interface CssTransformResult {
  css: string;
  // 解析できないために無効化した部分の数。
  invalid: number;
}

// 文字列でURLを受け取る関数。
const STRING_URL_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'src']);
// 値を後から差し込む関数。URLを受け取る関数の中にあると、何を取得するかを判定できない。
const INDIRECT_FUNCTIONS = new Set(['var', 'env', 'attr']);
// 取得や実行を起こす、古い仕組み。宣言ごと取り除く。
const BLOCKED_FUNCTIONS = new Set(['expression']);
const BLOCKED_PROPERTIES = new Set(['behavior', '-moz-binding']);
// 構文木にできなかった値のうち、関数やescapeを含むものは、url()が隠れているかもしれない。
const OPAQUE_VALUE = /[(\\]/;

// keep: 残す。drop: 許可されない参照を含むので取り除く。invalid: 何を取得するか判定できないので無効化する。
type DeclarationVerdict = 'keep' | 'drop' | 'invalid';

// 宣言の値に含まれる参照を調べ、残せるなら書き換える。
function rewriteDeclaration(
  declaration: Declaration,
  inFontFace: boolean,
  resolve: CssUrlResolver,
): DeclarationVerdict {
  // 名前をescapeで書いた宣言は、browserが別の名前として解釈する。判定できないので無効化する。
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
        // custom propertyなどから差し込まれる値は、文字列でもURLとして取得される。
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
      // custom propertyの値も構文木にする。しないと、値の中のurl()を見落とす。
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
          // 名前をescapeで書いた規則（`@\69mport`など）は、browserが別の規則として解釈する。
          if (node.name.includes('\\')) {
            invalid += 1;
            if (item && list) list.remove(item);
            return this.skip;
          }
          const name = node.name.toLowerCase();
          // @namespaceのURLは名前であって、取得先ではない。
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
        // selectorを構文木にできなかった規則は、規則ごと無効化する。
        if (node.type === 'Rule' && node.prelude.type === 'Raw') {
          invalid += 1;
          if (item && list) list.remove(item);
          return this.skip;
        }
        // 規則や宣言の並びに直接現れた、構文木にできなかった部分。無効化する。
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
    // style要素の中へ出力するので、要素を閉じる文字列を作れないようにする。
    return { css: generate(ast).replaceAll('<', String.raw`\3c `), invalid };
  } catch {
    // 構文木を作れないCSSは、全体を無効にする。
    return { css: '', invalid: invalid + 1 };
  }
}

export interface CssReference {
  url: string;
  context: CssReferenceContext;
}

// CSSが参照するURLを、書き換えずに集める。
export function scanCssReferences(source: string, kind: CssKind): CssReference[] {
  const references: CssReference[] = [];
  transformCss(source, kind, (url, context) => {
    references.push({ url, context });
    return url;
  });
  return references;
}
