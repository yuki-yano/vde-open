import type { RenderDiagnostic } from '@vde-open/shared';

// 元の文書と表示が異なる理由を、対象・理由・対処が分かる文にする（仕様13.4）。
// 「安全のため」とだけ書かず、何が起きたかと、表示するために必要な操作を書く。
type Describe = (target: string, count: number) => string;

const DESCRIPTIONS: Record<string, Describe> = {
  'asset-scan-failed': () =>
    '文書が参照するfileを調べる処理が、時間内に終わらないか、構造の上限を超えたため、画像とCSSを登録していません。vo refresh <文書ID> で調べ直せます。',
  'script-removed': (_target, count) =>
    `scriptを${String(count)}件取り除きました。この表示ではscriptを動かしません。scriptが作る内容は表示されません。`,
  'event-handler-removed': (_target, count) =>
    `onclickなどのevent属性を、${String(count)}個の要素から取り除きました。`,
  'embed-removed': (_target, count) =>
    `iframe・object・embedなどの埋め込みを${String(count)}件取り除きました。別のpageやpluginは埋め込めません。`,
  'inline-svg-removed': (_target, count) =>
    `文書に直接書かれたSVGを${String(count)}件取り除きました。SVGをfile（.svg）にして<img>で参照すると表示できます。`,
  'mathml-removed': (_target, count) => `MathMLを${String(count)}件取り除きました。`,
  'meta-refresh-removed': () => '自動で別のpageへ移動する指定（meta refresh）を取り除きました。',
  'base-removed': () => 'base要素を取り除きました。相対参照は、文書の位置を基準に解決します。',
  'network-hint-removed': (_target, count) =>
    `先読みの指定（prefetch・preconnectなど）を${String(count)}件取り除きました。`,
  'form-action-removed': () =>
    'formの送信先を取り除きました。formの部品は表示だけで、送信はできません。',
  'element-removed': (_target, count) =>
    `以降の表示を文字として扱う古い要素（plaintextなど）を${String(count)}件取り除きました。`,
  'media-blocked': (target) => `動画・音声（${target}）は表示できません。`,
  'remote-asset-blocked': (target) =>
    `外部のURL（${target}）は読み込みません。fileを文書と同じdirectoryの下へ置き、相対pathで参照すると表示できます。`,
  'asset-not-registered': (target) =>
    `${target} が見つかりません。fileが、文書を開いたときのassets-root（指定がなければ文書のあるdirectory）の中にあることを確かめてください。`,
  'asset-rejected': (target) =>
    `${target} は読み込めません。assets-rootの外を指す参照、file:のURL、encodeした区切り文字は使えません。範囲を広げるには、vo open <文書> --assets-root <dir> で開き直します。`,
  'asset-hidden': (target) =>
    `${target} は読み込みません。名前が「.」で始まるfileやdirectory（.env、.gitなど）は、文書から参照できません。`,
  'asset-unsupported': (target) =>
    `${target} は、この場所では使えない種類のfileです。使えるのは、画像（PNG・JPEG・WebP・GIF・AVIF・SVG）、CSS、font（WOFF・WOFF2）です。`,
  'data-url-blocked': (target) =>
    `data URL（${target}）は使えません。data URLで使えるのは、PNG・JPEG・WebP・GIF・AVIFの画像だけです。`,
  'css-invalid': (target) =>
    `${target === '' ? '文書内のCSS' : target} に解析できない部分があり、その部分を無効にしました。`,
  'link-disabled': (_target, count) =>
    `文書中のlink（${String(count)}件）は、表示の中では押せません。「文書中のlink」の一覧から開けます。`,
};

export function describeDiagnostic(diagnostic: RenderDiagnostic): string {
  const describe = DESCRIPTIONS[diagnostic.code];
  const target = diagnostic.target ?? '';
  if (!describe) return `${diagnostic.code}${target === '' ? '' : `: ${target}`}`;
  const text = describe(target, diagnostic.count);
  // 対象を名指しする種類で、同じ対象が複数回現れた場合は回数を添える。
  return diagnostic.target !== null && diagnostic.count > 1
    ? `${text}（${String(diagnostic.count)}か所）`
    : text;
}
