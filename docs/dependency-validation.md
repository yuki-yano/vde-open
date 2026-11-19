# 依存の版と検証

確認日: 2026-10-02。版はnpm registryで実在を確認し、`package.json`に完全版番号で固定した。lockfileは`pnpm-lock.yaml`。

## 実行環境

| 対象 | 版 | 固定場所 |
|---|---|---|
| Node.js | 24.22.3（2026-11-19時点の24系の最新。security release） | `flake.nix`（公式のbinary）と`package.json`の`engines.node` |
| pnpm | 12.9.0（`flake.lock`のnixpkgsの`pnpm_12`） | `flake.lock`と`package.json`の`packageManager` |
| npm（pack検証の導入と公開に使用） | 11.19.1（Node 24.22.3同梱） | - |

## 直接依存

| package | 版 | 使う場所 | peer／enginesの確認 | 実施した検証 |
|---|---|---|---|---|
| typescript | 7.0.2 | 全workspace | Node >=16.20 | `tsc --noEmit`が5つのtsconfigで成功 |
| @types/node | 24.19.2 | root | - | 型検査。24.19.1は公開から1日未満でpnpmの`minimumReleaseAge`にかかるため、除外設定を足さずに1つ前を選んだ |
| vitest | 5.1.1 | root | vite ^8、@types/node >=24、Node ^24 | `vitest run`が成功 |
| oxlint | 1.86.0 | root | Node ^20.19 \|\| >=22.12 | `oxlint`が成功。type-aware lint（oxlint-tsgolint）は使わない。型検査は`tsc`で独立に行う |
| oxfmt | 0.71.0 | root | 同上 | `oxfmt --check`が成功 |
| tsdown | 0.23.7 | apps/cli | typescript ^7、Node ^24.11 | `dist/cli.js`をESMで生成し実行。`dts: false` |
| commander | 15.1.0 | apps/cli | Node >=22.12 | CLIのunit testとpack検証 |
| zod | 4.6.7 | packages/shared、apps/cli | - | envelopeのunit test |
| hono | 4.13.19 | apps/cli | Node >=16.9 | 契約テスト（SSE helper） |
| @hono/node-server | 2.1.9 | apps/cli | hono ^4、Node >=20 | 契約テスト（127.0.0.1、port 0でlisten） |
| minisearch | 7.2.0 | apps/cli | - | 契約テスト（tokenizer差し替え、boost、discard） |
| chokidar | 5.0.0 | apps/cli | Node >=20.19 | 契約テスト（add／changeの検知） |
| tinyglobby | 0.2.17 | apps/cli | - | 契約テスト（`**`、ignore、dotfile除外） |
| @tanstack/markdown | 1.2.0 | packages/document、apps/web | react >=18とoctaneが任意peer | 契約テスト（AST、`allowHtml: false`、危険なURL） |
| @tanstack/highlight | 1.2.12 | packages/document、apps/web | Node >=18 | 契約テスト（言語の明示登録、Markdown用adapter） |
| parse5 | 8.1.1 | packages/document | - | 契約テスト（解析と直列化） |
| css-tree | 3.2.1 | packages/document | - | 契約テスト（`url()`と`@import`の抽出） |
| @types/css-tree | 3.2.0 | packages/document | - | 型検査 |
| react / react-dom | 19.3.1 | apps/web | react-domはreact ^19.3 | `vite build`が成功 |
| @types/react / @types/react-dom | 19.3.0 | apps/web | - | 型検査 |
| vite | 8.3.8 | apps/web | Node ^20.19 \|\| >=22.12 | `vite build`が成功 |
| @vitejs/plugin-react | 6.3.0 | apps/web | vite ^8 | 同上 |

## P2で追加した依存

| package | 版 | 使う場所 | 実施した検証 |
|---|---|---|---|
| tailwindcss / @tailwindcss/vite | 4.3.5 | apps/web | `vite build`でCSSを生成。`@tailwindcss/vite`のpeerはvite ^8 |
| shadcn（CLIと`shadcn/tailwind.css`） | 4.23.0 | apps/web（devDependencies） | `shadcn init -y -b base -t vite --no-monorepo -p nova`でBase UI版（style `base-nova`）を初期化。`add badge separator toggle-group`で部品を追加 |
| @base-ui/react | 1.9.0 | apps/web | shadcnの部品（button、toggle、toggle-group、separator）が使用。e2eで操作を確認 |
| class-variance-authority | 0.7.1 | apps/web | 同上 |
| cn | 0.4.0 | apps/web | shadcnが提供するclass結合。`src/lib/utils.ts`から再export |
| lucide-react | 1.75.0 | apps/web | icon |
| tw-animate-css | 1.4.0 | apps/web | shadcnのCSSが参照 |
| @fontsource-variable/geist | 5.3.0 | apps/web | fontをbundleへ同梱。外部のCDNは使わない |
| @playwright/test | 1.63.0 | root | Chromiumでe2e 17件 |
| parse5 | 8.1.1 | packages/document | HTMLの静的な表示への変換と、参照の収集。配布物へbundle |
| css-tree | 3.2.1 | packages/document | CSSの参照の検査。単体entryを使い、配布物へbundle（`source-map-js`を含む） |
| minisearch | 7.2.0 | apps/cli | 節の単位の検索index。別のthreadで使い、配布物へbundle |
| happy-dom | 21.0.4 | root（devDependencies） | 画面部品のhookを、実際のReact DOMで動かすテストの環境。配布物には含まれない |

shadcnのCLIが`package.json`へ書くrange指定（`^`）は、導入後に完全版番号へ直した。

## 文書一覧の並べ替えで追加した依存

2026-10-06に追加。完全版番号で固定し、React 19.3.0で型検査とビルドを確認した。

| package | 版 | 使う場所 | peer／enginesの確認 | 実施した検証 |
|---|---|---|---|---|
| @dnd-kit/react | 0.5.3 | apps/web | react／react-dom ^18.0.0 または ^19.0.0 | Chromium・Firefox・WebKitで行全体からのドラッグ、挿入位置、キャンセル、キーボード操作、自動スクロールを確認。Chromiumではタッチ操作も確認 |
| @dnd-kit/dom | 0.5.3 | apps/web | peer／engines指定なし | ポインター移動距離とタッチ長押しの開始条件に使用。削除ボタンの操作と短いタッチスクロールで並べ替えが始まらないことを確認 |

## 2026-11-19の更新

実行環境をmiseからNix（`flake.nix`とdirenv）へ移し、Node.jsを24系の最新の24.22.3へ上げた。依存は、`pnpm audit`の指摘と、majorを変えない更新を対象にした。上の表の版は更新後のもの。

- 配布物へbundleする依存の脆弱性を直した: hono 4.13.19、@hono/node-server 2.1.9、zod 4.6.7。
- 開発用の依存の脆弱性を直した: vite 8.3.8、happy-dom 21.0.4、shadcn 4.23.0。shadcnの配下の依存（undici、systeminformation、zod、fast-uri、ip-address）は、rangeの中の修正版へlockfileだけを更新した。
- happy-dom 21は、既定でiframeのpageを読み込まない。20では`127.0.0.1:1`への接続を試みて失敗のlogを出していたが、21では読み込まない旨のerrorをiframeごとにlogへ出す。テストの結果は変わらない。
- 残る指摘: shadcn → ts-morph → minimatch 10.2.6（moderate）。修正版の11.0.1はts-morphのrangeの外で、開発用のCLIだけが使うので、overrideは足していない。
- 上げなかった依存: chokidar 6（major）、@types/node 26（Node 24と合わない）、cn 0.5（0.xのminorは破壊的変更を含みうる）、oxlint 1.94・oxfmt 0.79（lintとformatの差分がrepository全体に出る）、@playwright/test 1.65（browserを入れ直し、READMEの検証範囲を更新する必要がある）。
- 検証: Nixの環境の `pnpm check`（unit／integration 1011件）、`pnpm build`、`pnpm test:pack`、`pnpm test:e2e`（Chromium 117件）、`pnpm test:e2e:cross`（Firefox・WebKitで140件成功、6件はChromiumだけの試験でskip）が成功。

## 契約テストで確かめたこと

- `@tanstack/markdown`のASTはserializableで、nodeに原文位置を持たない。原文行の取得はsourceから直接切り出す（仕様8.3）。
- `allowHtml: false`では生HTMLがescapeされた文字として出力される。`javascript:`のURLはリンクにならない。
- `@tanstack/highlight`は、仕様8.2の基準言語（JS/JSX/TS/TSX/JSON/YAML/HTML/CSS/Bash/Markdown）を明示登録できる。Bashは独立したexportではなく、`shell`のaliasとして解決される。
- `@tanstack/highlight/markdown`の`createTanStackMarkdownHighlighter`を使うと、`<pre>`と`<code>`が二重にならない。
- `@tanstack/markdown`の`urlTransform`は解析時のoptionである。描画時に渡しても適用されない。`headingIds`の関数へ渡される番号は、見出しの連番ではない（一意ではある）。
- `@tanstack/markdown`は、`allowHtml: false`でも`javascript:`などのURLを既定で取り除く。相対URLと画像は残すので、解析時の`urlTransform`で絞っている。
- parse5は、既定（`scriptingEnabled: true`）では`noscript`の中身を文字として保持し、そのまま出力する。scriptを動かさない表示では、中身が要素として解釈されるので、`scriptingEnabled: false`で解析して中身を取り除く対象に含める（`packages/document/src/html-static.test.ts`）。
- css-treeの本体のentryは、構文data（`mdn-data`）を`createRequire`でfilesystemから読むため、配布物へbundleできない。解析・走査・出力の単体entry（`css-tree/parser`・`css-tree/walker`・`css-tree/generator`）は読まないので、こちらを使う。単体entryには型宣言がないため、本体の型を当てている。
- css-treeは、escapeで書いた`url`（`u\72l(...)`）を構文木にせず、解析できない値として残す。関数やescapeを含む「解析できない値」は、宣言ごと取り除く。custom propertyの値は、`parseCustomProperty: true`で構文木にする（`packages/document/src/css-transform.test.ts`）。
- Playwright（Chromium）は、空のsandbox（scriptなし）のiframeの中の要素も、`frameLocator`で読める。
- Chokidarは、監視を始めた直後の変更を通知しないことがある。macOSで、`ready`の直後に作ったfileの`add`が届かない例を約35回に1回観測した。後続の変更があれば検知できる。P2の監視は通知だけに頼らず、登録時と再走査時にstatを照合して回復する（仕様8.5）。

## 確認日の時点で未検証だったこと

現在の検証範囲は、READMEの「Verified scope」にある。

- Windows、Linuxでの導入とビルド。確認はmacOSだけで行った。
- scriptを動かす表示（interactive）のsandboxとCSP（P6で実装）。静的な表示は、Chromiumで確認した（`tests/e2e/html.spec.ts`）。
- FirefoxとWebKitでのe2e。
