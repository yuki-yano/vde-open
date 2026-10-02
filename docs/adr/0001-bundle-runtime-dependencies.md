# ADR-0001: 配布物にruntime依存をbundleする

状態: 採用（P0）

## 背景

仕様14.2は、packed packageがdevDependenciesなしで動き、暗黙のroot hoistに依存しないことを求める。runtime依存は「すべてbundleする」か「dependenciesに正しく記載する」かを選べる。

## 決定

外部packageも`dist/`へbundleし、配布packageの`dependencies`を空にする。外部packageは`apps/cli/package.json`の`devDependencies`に置き、bundleしてよいものを`apps/cli/tsdown.config.ts`の`deps.onlyBundle`に列挙する。列挙にないpackageがbundleされるとビルドが失敗する。

## 理由

- tarballだけで導入でき、導入時にregistryへ問い合わせない。pack検証を`npm install --offline`で実行できる。
- 利用者の環境で依存の版がずれない。

## 影響

- bundleした依存のlicense noticeを配布物へ含める必要がある。P7で生成する。
- native addonを持つ依存は、この方式では採用できない。現時点の依存にnative addonはない。
