# 依存の版と検証

確認日: 2026-10-02。版はnpm registryで実在を確認し、`package.json`に完全版番号で固定した。lockfileは`pnpm-lock.yaml`。

## 実行環境

| 対象 | 版 | 固定場所 |
|---|---|---|
| Node.js | 24.21.0（確認日時点の24系の最新） | `mise.toml` |
| pnpm | 12.8.1 | `package.json`の`packageManager` |
| npm（pack検証の導入に使用） | 11.19.0（Node 24.21.0同梱） | - |

## 直接依存

| package | 版 | 使う場所 | peer／enginesの確認 | 実施した検証 |
|---|---|---|---|---|
| typescript | 7.0.2 | 全workspace | Node >=16.20 | `tsc --noEmit`が5つのtsconfigで成功 |
| @types/node | 24.19.0 | root | - | 型検査。24.19.1は公開から1日未満でpnpmの`minimumReleaseAge`にかかるため、除外設定を足さずに1つ前を選んだ |
| vitest | 5.0.3 | root | vite ^8、@types/node >=24、Node ^24 | `vitest run`が成功 |
| oxlint | 1.86.0 | root | Node ^20.19 \|\| >=22.12 | `oxlint`が成功。type-aware lint（oxlint-tsgolint）は使わない。型検査は`tsc`で独立に行う |
| oxfmt | 0.71.0 | root | 同上 | `oxfmt --check`が成功 |
| tsdown | 0.23.0 | apps/cli | typescript ^7、Node ^24.11 | `dist/cli.js`をESMで生成し実行。`dts: false` |
| commander | 15.0.0 | apps/cli | Node >=22.12 | CLIのunit testとpack検証 |
| zod | 4.6.5 | packages/shared、apps/cli | - | envelopeのunit test |
| hono | 4.13.12 | apps/cli | Node >=16.9 | 契約テスト（SSE helper） |
| @hono/node-server | 2.1.3 | apps/cli | hono ^4、Node >=20 | 契約テスト（127.0.0.1、port 0でlisten） |
| minisearch | 7.2.0 | apps/cli | - | 契約テスト（tokenizer差し替え、boost、discard） |
| chokidar | 5.0.0 | apps/cli | Node >=20.19 | 契約テスト（add／changeの検知） |
| tinyglobby | 0.2.17 | apps/cli | - | 契約テスト（`**`、ignore、dotfile除外） |
| @tanstack/markdown | 1.0.0 | packages/document、apps/web | react >=18とoctaneが任意peer | 契約テスト（AST、`allowHtml: false`、危険なURL） |
| @tanstack/highlight | 1.0.0 | packages/document、apps/web | Node >=18 | 契約テスト（言語の明示登録、Markdown用adapter） |
| parse5 | 8.0.1 | packages/document | - | 契約テスト（解析と直列化） |
| css-tree | 3.2.1 | packages/document | - | 契約テスト（`url()`と`@import`の抽出） |
| @types/css-tree | 3.2.0 | packages/document | - | 型検査 |
| react / react-dom | 19.3.0 | apps/web | react-domはreact ^19.3 | `vite build`が成功 |
| @types/react / @types/react-dom | 19.3.0 | apps/web | - | 型検査 |
| vite | 8.3.2 | apps/web | Node ^20.19 \|\| >=22.12 | `vite build`が成功 |
| @vitejs/plugin-react | 6.1.1 | apps/web | vite ^8 | 同上 |

## 契約テストで確かめたこと

- `@tanstack/markdown`のASTはserializableで、nodeに原文位置を持たない。原文行の取得はsourceから直接切り出す（仕様8.3）。
- `allowHtml: false`では生HTMLがescapeされた文字として出力される。`javascript:`のURLはリンクにならない。
- `@tanstack/highlight`は、仕様8.2の基準言語（JS/JSX/TS/TSX/JSON/YAML/HTML/CSS/Bash/Markdown）を明示登録できる。Bashは独立したexportではなく、`shell`のaliasとして解決される。
- `@tanstack/highlight/markdown`の`createTanStackMarkdownHighlighter`を使うと、`<pre>`と`<code>`が二重にならない。
- Chokidarは、監視を始めた直後の変更を通知しないことがある。macOSで、`ready`の直後に作ったfileの`add`が届かない例を約35回に1回観測した。後続の変更があれば検知できる。P2の監視は通知だけに頼らず、登録時と再走査時にstatを照合して回復する（仕様8.5）。

## これから導入するもの

| package | 予定の版 | 導入するフェーズ | 備考 |
|---|---|---|---|
| @playwright/test | 1.63.0 | P2 | browserのdownloadを伴う。実ブラウザでの検証はP2以降 |

## 未検証のこと

- TanStack Markdown／HighlightのReact描画と、実文書に対する描画・抽出（P2）。
- Windows、Linuxでの導入とビルド。手元はmacOSのみ。
- 実ブラウザでのsandbox、CSP（P3、P6）。
