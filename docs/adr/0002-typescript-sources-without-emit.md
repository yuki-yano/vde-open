# ADR-0002: TypeScriptのsourceを変換なしで実行できる書き方にそろえる

状態: 採用（P0）

## 背景

仕様2.2は、内部packageがTSソースを参照してアプリへbundleされること、公開用の`.d.ts`を作らないことを定める。ビルドや検証のscript、integration testからのprocess起動でも、同じsourceをそのまま使いたい。

## 決定

- import指定子に`.ts`拡張子を書く（`allowImportingTsExtensions`）。
- 型を消すだけで実行できる構文に限る（`erasableSyntaxOnly`）。enum、namespace、parameter propertyを使わない。
- 内部packageは`exports`でTSソースを指す。

## 理由

Node.js 24は型を取り除くだけでTSを実行できるので、`scripts/*.ts`を変換なしで起動できる。配布物はtsdownとViteがbundleするので、利用者の環境でTSを実行することはない。

## 影響

- 配布物は必ず`pnpm build`の出力を使う。sourceを直接起動するのは開発と検証だけ。
