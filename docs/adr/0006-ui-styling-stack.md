# ADR-0006: UIのスタイルにTailwind CSS・shadcn/ui・Base UIを使う

状態: 採用（P2、利用者の指定）

## 背景

引き継ぎ一式の1.1.0では、UIのスタイルにCSS ModulesとCSS custom propertiesを使うとしていた。P2の着手前に、利用者から「スタイルにはTailwind、shadcn、Base UIを使う」との指定があった。

## 決定

- スタイルはTailwind CSS 4（`@tailwindcss/vite`）で書く。
- 部品はshadcn/uiを使う。primitiveはBase UI（`@base-ui/react`）を選ぶ（`shadcn init -b base`、style `base-nova`）。
- shadcnの部品は、CLIが`apps/web/src/components/ui/`へ生成するsourceとして持つ。生成後のfileはこのrepositoryの整形とlintの対象にする。
- 配色などの値は、shadcnが`apps/web/src/index.css`に定義するCSS custom propertiesで持つ。ライト／ダークは`html`の`dark` classで切り替える。
- 配色はCatppuccinを使う。ライトはLatte、ダークはMocha。shadcnの各役割（`--primary`など）とコードの色付けへの割り当ては、Catppuccinのstyle guideに従う。
- fontは`@fontsource-variable/geist`をbundleへ同梱する。外部のCDNやfont配信は使わない。
- 引き継ぎ一式の仕様2.1のUIの行も、この内容へ書き換えた。

## 影響

- 管理UIのCSPは`style-src 'self' 'unsafe-inline'`にしている。Base UIが位置決めなどでinline styleを使うため。scriptは`'self'`だけで、inline scriptは許可しない。
- shadcnのCLIは依存をrange指定で追加する。追加のたびに、完全版番号へ直す。
- Markdown本文の見た目は、Tailwindのtypography pluginを使わず、`index.css`の`.markdown-body`で定義している。
