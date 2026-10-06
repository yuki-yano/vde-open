# vde-open

[English](README.md)

Agentと人が同じ資料を見ながら作業するための、ローカルの文書viewerです。MarkdownとHTMLの文書を開いて、browserの管理画面で読み、Agentは同じ文書をCLIから検索・読み取りできます。Agentから人へ質問し、人が管理画面で回答を確定することもできます。

- 開いた文書だけを、Agentが検索・読み取りできます（閉じた文書やdirectory全体は探しません）。
- 文書を保存すると、管理画面の表示が自動で更新されます。
- HTMLは、管理画面と分けた別のoriginで、scriptを動かさずに表示します（既定）。
- 状態はlocalのdaemonが持ち、外部のserviceへ送りません。

## 導入

Node.js 24以降が必要です。

```bash
bun add -g vde-open      # おすすめ: userごとに ~/.bun/bin へ導入する
npm install -g vde-open  # これでも導入できる
```

- Bunで、userごとに1回導入するのがおすすめです。`~/.bun/bin`は、使っているNode.jsの版に左右されないので、mise などでNode.jsの版を切り替えても`vo`が消えません。Bunは導入に使うだけで、commandはNode.jsで動きます（`#!/usr/bin/env node`）。PATHにNode.js 24以降が必要です。Bunのruntimeでの実行（`bun --bun`）は試していません。
- `npm install -g`は、そのときに使っているNode.jsの版の場所へ入ります。
- projectごとの導入はおすすめしません。daemonはuserごとに1つなので、projectごとに版が違うと、同じdaemonに違う版のCLIがつながります。

導入は、`.zshrc`などのshellの設定を変えません。導入時にbuildやscriptも実行しません（packageは依存をすべて同梱しています）。公開は、GitHub Actionsからprovenance付きで行います（「公開の手順」を参照）。

このrepositoryのcloneから導入するときは、次のとおりです（`mise.toml`でNode.js 24.21.0に固定しています）。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack                              # artifacts/vde-open-<版>.tgz を作り、別のdirectoryへ導入して確かめる
bun add -g "$PWD/artifacts/vde-open-0.1.4.tgz"   # 絶対pathで指定する（bun add -g は相対pathを、今のdirectoryではなくglobalの導入先から解決する）
```

## リンクしたCLIで開発する

repositoryのrootで一度buildし、CLI packageをglobalにlinkします。

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/cli
bun link
bun link -g vde-open
cd ../..
pnpm build:watch
```

`build:watch`は起動時にbuildし、その後はCLI・UI・共有source・build設定・同梱fileの変更を監視します。連続した保存をまとめ、buildを1つずつ実行します。両appと同梱fileを一時directoryで用意してから配布物を更新するので、buildが失敗しても直前に成功した出力が残ります。次のCLI実行から、link先の更新が反映されます。

watcherはdaemonを起動・再起動しません。buildが成功したら`vo daemon restart`、続けて`vo ui`で更新した管理画面を開きます。登録した文書と保存済みの回答は引き継ぎますが、UIのURLが変わり、以前のbrowser sessionとinteractive HTMLの許可は失効します。watcherはCtrl+Cで終了します。build中ならそのprocessも止め、一時出力を削除します。

UIを頻繁に調整するときは`pnpm dev`を使います。別の`.dev-home`でsourceのdaemonを動かし、Vite HMRでUIの変更を反映します。link先のCLIはbuildせず、backendのsourceを変更しても自動再起動しません。この環境へCLIでつなぐときは、同じ絶対pathの`VDE_OPEN_HOME`を指定します（repositoryのrootなら`VDE_OPEN_HOME="$PWD/.dev-home" vo list`）。

## `vde-open`と`vo`

同じCLIを2つの名前で導入します。どちらで実行しても、同じstateとdaemonを使います。

- `vde-open` … 正式な名前。
- `vo` … 短い名前。

既に別の`vo`がある場合（ほかのtoolのcommandやaliasなど）は、導入でそれを上書きしたり消したりしません。

- 導入先のbin（`npm install -g`ならnpmのglobalのbin）に別の`vo`のfileがあると、npmは`EEXIST`で導入をやめます。`--force`を付けると既存の`vo`を置き換えるので、付けないでください。Bunで導入するか、別のprefix（例: `npm install -g --prefix ~/.local/vde-open ./artifacts/vde-open-0.1.4.tgz`）へ導入して、そのbinの`vde-open`を使ってください。
- 別の場所の`vo`やaliasは、PATHの順番で先に見つかったものが動きます。その場合は`vde-open`を使ってください。短い名前を使いたいときは、自分のshellで別名（例: `alias vdo=vde-open`）を設定してください。

## 基本の使い方

```bash
vo open README.md docs/design.md        # 文書を開く（daemonがなければ起動する）
vo open docs -w                          # directoryを開き、新しい文書も追う
vo ui                                    # 管理画面を開く（一回限りのURL）
vo list --json                           # 開いている文書の一覧
vo search "認証の設計" --json            # 開いている文書を検索する
vo read <documentId> --section sec_0003 --json   # 節を読む
vo close docs/design.md                  # 一覧から外す（fileは消さない）
vo daemon stop                           # daemonを止める
```

Agentからの使い方は [docs/agent-usage.ja.md](docs/agent-usage.ja.md) にあります（検索→見出しの一覧→節の順に読む、回答の往復、HTMLから回答案を受け取る方法）。

## Agent向けのskill

[`skills/vde-open/SKILL.md`](skills/vde-open/SKILL.md) は、Agent（Claude Code、Codexなど`SKILL.md`を読むもの）に、`vo`をいつ・どう使うかを伝えるskillです（英語）。配布物にも含めています。使うときは、Agentのskillのdirectoryへlinkするかcopyします。

```bash
# Bunで導入したとき: skillはglobalのpackageのdirectoryにある。
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.claude/skills/vde-open   # Claude Code
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.codex/skills/vde-open    # Codex
# npmで導入したとき: 代わりに "$(npm root -g)/vde-open/skills/vde-open" を使う。
# このrepositoryのcloneから使うとき: 代わりに "$PWD/skills/vde-open" を使う。
```

## 検索の範囲

- 検索の対象は、**いま開いている文書だけ**です。閉じた文書、開いていないfile、directory全体は探しません。
- 結果は、検索した時点の公開済みの版です。結果の`revision`を指定して読むと、検索したときと同じ内容を返します。
- 日本語は`Intl.Segmenter`で語に分けます。完全な一致、前方一致、1文字違いまでの英数字の語の一致（fuzzy）を使います。
- 管理画面では`Cmd/Ctrl+K`で検索できます。

## HTMLの表示の制限

- 既定（static）では、scriptを動かしません。script、event属性、iframe・object・embed、base、自動の移動（meta refresh）、formの送信先、外部の画像・CSS・fontを取り除きます。linkは表示の中では押せず、「Links in this document」の一覧から開きます。
- 読み込めるのは、文書が参照する、assets-root（既定は文書のあるdirectory）の中のfileだけです。`.env`や`.git`など名前が「.」で始まるfileは読み込みません。範囲は`--assets-root`、個別のfileは`--asset`で指定します。
- `--html-mode interactive`を指定したHTMLだけ、scriptを動かします。scriptが読み込めるのは登録したfileだけで、管理画面・管理API・fileには触れられません。ただし、表示の中でのpageの移動などを含め、すべての外部への通信を止めるものではありません。自分やAgentが用意した、信頼できるHTMLだけで使ってください。daemonを起動し直すと、管理画面で許可し直すまで静的表示になります。
- 元の文書と表示が違う点は、管理画面の「Differences from the original document」に、対象・理由・対処とともに表示します。

## Markdownの表示の制限

Markdownは、TanStack Markdown 1.0.0で表示します。CommonMark・GFMの完全な互換ではありません。

- 生のHTMLは描画せず、文字として表示します。
- 外部の画像は読み込みません。文書と同じdirectoryの下の画像だけを表示します。
- コードの色付けは、JS・JSX・TS・TSX・JSON・YAML・HTML・CSS・Bash・Markdownだけです。256KiBを超えるコードと、それ以外の言語は色を付けません。
- 解析が2秒で終わらない文書や、要素が10万を超える・入れ子が64段を超える文書は、原文で表示します。

## MarkdownのPDF出力

Markdown文書のheaderの「Export PDF」で、表示中の版を、印刷のdialogを挟まずにPDFとして保存します。

- PDFは白背景のA4の資料です（管理画面の配色は使いません）。全pageのheaderに文書名、footerにpage番号（「3 / 12」）を入れ、見出しをPDFのしおりにします。
- daemonが、その環境に入っているGoogle ChromeかMicrosoft Edge（131以降）を、使い終えたら消す一時profileでheadlessに起動して印刷します。何もdownloadしません。別のChromium系browserや、別の場所にあるbrowserを使うときは、daemonの環境変数`VDE_OPEN_BROWSER`に実行fileの絶対pathを指定します（変えたら`vo daemon restart`を実行します）。
- 表示と同じ規則に従います。生のHTMLは文字として表示し、文書に登録された画像だけを入れ（それ以外は代替textを表示）、他のlocal文書へのlinkは文字だけにします。
- file名は、文書のfile名の拡張子を`.pdf`にしたものです（`README.md` → `README.pdf`）。stdinから開いた文書は文書名を使います。
- 書体はその環境に入っているもの（macOSはSan Franciscoとヒラギノ角ゴシック、WindowsはSegoe UIと游ゴシック、LinuxはNoto Sans CJK）を使うため、OSごとに少し見た目が変わります。
- HTML文書は出力できません。印刷は60秒以内に終わる必要があります。

## 状態の保存先と停止

- 状態（開いている文書、版、質問と回答）は、次の場所に保存します。`VDE_OPEN_HOME`で変えられます。
  - macOS: `~/Library/Application Support/vde-open`
  - Linux: `$XDG_STATE_HOME/vde-open`（未設定なら`~/.local/state/vde-open`）
  - Windows: `%LOCALAPPDATA%\vde-open`
- daemonは`vo daemon stop`で止めます。どちらの名前で起動したdaemonも止められます。`vo daemon status`で状態を確かめられます。
- 管理画面の配色・表示の切り替えなどはbrowserに保存します。開いている文書はdaemonの状態に従います。

## 人への質問と回答

```bash
vo ask questions.json --view review.md --json    # 文書を開いて質問する
vo feedback wait <requestId> --timeout 120 --json
vo feedback ack <requestId> --submission-id <id> --json
```

人は管理画面の回答panelで回答し、「Send answers to the agent」を押したときだけ回答が確定します。送信の前の入力（回答案）はAgentへ返しません。passwordやAPI keyなどの秘密を入力してもらう用途には使わないでください。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `vo`で別のcommandが動く | `vde-open`を使うか、PATHの順番を確かめる |
| 管理画面が、CLIから開き直すよう表示する | `vo ui`で新しいURLを開く（URLは一回限り。daemonを起動し直すと前の画面は使えない） |
| 終了コード8（daemonへ接続できない・起動できない） | `vo daemon status`で確かめ、`vo doctor`で残ったfileを調べる |
| 画像やCSSが表示されない | 「Differences from the original document」を開き、`--assets-root`・`--asset`で登録する |
| 検索で見つからない | `vo list --json`で、文書が開いていて`searchState`が`ready`かを確かめる |
| Export PDFで、Google ChromeかMicrosoft Edgeが必要と表示される | Chrome・Edgeの131以降を入れるか、`VDE_OPEN_BROWSER`にChromium系browserの絶対pathを指定して`vo daemon restart`を実行する |

## 検証した範囲

| 範囲 | 状態 |
|---|---|
| macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、手元 | 検証済み（format・lint・typecheck・unit／integration・build・pack・e2e） |
| CIのLinuxとmacOS（GitHub Actionsの`ubuntu-latest`と`macos-latest`、Node.js 24.21.0） | 検証済み（format・lint・typecheck・unit／integration・build・pack、Chromium・Firefox・WebKitのe2e。`.github/workflows/ci.yml`） |
| CIのWindows（`windows-latest`、Node.js 24.21.0） | 検証済み: build、pack smoke（導入、両bin、IPC、daemonの起動と停止、JSON出力、管理画面とworker）、daemonと文書の結合試験。そのほかの単体・結合試験とe2eは、Windowsでは実行していない |
| browser（macOS） | Chromium（PlaywrightのChrome Headless Shell）は全件を検証済み。Firefox 155・WebKit 26.6（Playwright 1.63.0）は、表示の隔離・CSP・HTMLとの通信・認証の試験（`pnpm test:e2e:cross`）を検証済み |
| browser（未検証） | Firefox・WebKitのそれ以外の画面操作（検索、回答panel、狭い画面、1,000文書の一覧など）は未検証 |
| Markdownの構文 | 上の「Markdownの表示の制限」のとおり。CommonMark・GFMの全体は検証していない |
| PDF出力 | macOS（手元）で、Google Chrome 154とMicrosoft Edge 154での出力を検証済み。LinuxとWindowsでの実際のbrowserでの印刷は未検証 |

詳しい記録は [docs/implementation-status.md](docs/implementation-status.md)、性能の実測は [docs/performance.ja.md](docs/performance.ja.md)、設計は [docs/architecture.ja.md](docs/architecture.ja.md) と [docs/security-model.ja.md](docs/security-model.ja.md) にあります。

## 公開の手順

npmへの公開は、GitHub Actionsがtrusted publishing（OIDC）で行います。npmのtokenはどこにも置きません。npmjs.comのtrusted publisherは、このrepositoryとworkflow file `publish.yml` に設定してあり、tokenでの公開は禁止しています。

1. `apps/cli/package.json` の `version` を上げ、`main` へcommitする。
2. その版のtagをpushする: `git tag v0.1.0 && git push origin v0.1.0`。
3. `.github/workflows/publish.yml` が、tagと版の一致を確かめ、検査とpack smokeを通してから、provenance付きでtarballを公開する。

## License

[MIT](LICENSE)。同梱した依存のlicenseは、それぞれのpackageに従います。一覧とlicenseの本文は、配布物の`THIRD_PARTY_NOTICES.md`にあります（`pnpm build`がbundleの内容から作ります）。
