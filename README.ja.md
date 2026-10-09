# vde-open

[English](README.md)

Agentと人が同じ資料を見ながら作業するための、ローカルの文書viewerです。Markdown・HTML・画像を開いて、browserの管理画面で読み、Agentは同じ文書をCLIから検索・読み取りできます。Agentから人へ質問し、人が管理画面で回答を確定することもできます。

- 開いた文書だけを、Agentが検索・読み取りできます。
- 文書を保存すると、管理画面の表示が自動で更新されます。
- HTMLは、管理画面と分けた別のoriginで、scriptを動かさずに表示します（既定）。
- 状態はlocalのdaemonが持ち、外部のserviceへ送りません。

## 導入

Node.js 24以降が必要です。

```bash
bun add -g vde-open      # おすすめ
npm install -g vde-open  # これでも導入できる
```

- Bunは`vo`を`~/.bun/bin`へ入れるので、mise などでNode.jsの版を切り替えても使えます。`npm install -g`は、そのときに使っているNode.jsの版にだけ入ります。どちらの場合も、commandはPATHにあるNode.jsで動きます。
- projectごとに導入しないでください。daemonはuserごとに1つなので、projectごとに版が違うと、同じdaemonに違う版のCLIがつながります。
- 導入は、`.zshrc`などのshellの設定を変えず、buildやscriptも実行しません（依存はすべて同梱しています）。

このrepositoryのcloneから導入するときは、次のとおりです（`mise.toml`でNode.js 24.21.0に固定しています）。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack                                   # artifacts/vde-open-<版>.tgz を作り、別のdirectoryへ導入して確かめる
bun add -g "$PWD/artifacts/vde-open-0.1.11.tgz"   # bun add -g には絶対pathで指定する
```

## `vde-open`と`vo`

同じCLIを、`vde-open`と短い名前の`vo`の2つで導入します。どちらで実行しても、同じstateとdaemonを使います。

既に別の`vo`がある場合（ほかのtoolのcommandやaliasなど）、導入でそれを上書きしたり消したりしません。

- npmのglobalのbinに別の`vo`があると、`npm install -g`は`EEXIST`で止まります。`--force`は既存の`vo`を置き換えるので、付けないでください。Bunで導入するか、別のprefix（`npm install -g --prefix ~/.local/vde-open vde-open`）へ導入して、そのbinの`vde-open`を使ってください。
- PATHで別の`vo`が先に見つかる場合は、`vde-open`を使うか、自分のshellで別名（例: `alias vdo=vde-open`）を設定してください。

## 基本の使い方

```bash
vo open README.md docs/design.md        # 文書を開く（daemonがなければ起動する）
vo open docs -w                          # directoryを開き、新しい文書も追う
vo ui                                    # 管理画面を開く（認証なし）
vo list --json                           # 開いている文書の一覧
vo search "認証の設計" --json            # 開いている文書を検索する
vo read <documentId> --section sec_0003 --json   # 節を読む
vo close docs/design.md                  # 一覧から外す（fileは消さない）
vo daemon stop                           # daemonを止める
```

管理画面は認証を行いません。`vo ui --print-url`で出るURLは、daemonが動いている間、同じ端末の別のbrowserやtabへコピーして開けます。文書を指定したURLも、そのまま開けます。配信は`127.0.0.1`だけで、別の端末からの閲覧には対応していません。

Agentからの検索・読み取り・質問の方法は [docs/agent-usage.ja.md](docs/agent-usage.ja.md) にあります。

## Agent向けのskill

[`skills/vde-open/SKILL.md`](skills/vde-open/SKILL.md) は、Agent（Claude Code、Codexなど`SKILL.md`を読むもの）に、`vo`をいつ・どう使うかを伝えるskillです（英語）。配布物に含めています。Agentのskillのdirectoryへlinkするかcopyして使います。

```bash
# Bunで導入したとき: skillはglobalのpackageのdirectoryにある。
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.claude/skills/vde-open   # Claude Code
ln -s ~/.bun/install/global/node_modules/vde-open/skills/vde-open ~/.codex/skills/vde-open    # Codex
# npmで導入したとき: 代わりに "$(npm root -g)/vde-open/skills/vde-open" を使う。
# このrepositoryのcloneから使うとき: 代わりに "$PWD/skills/vde-open" を使う。
```

## 検索の範囲

- 検索の対象は、**いま開いている文書だけ**です。閉じた文書、開いていないfile、directory全体は探しません。
- 日本語は`Intl.Segmenter`で語に分けます。語は、完全な一致、前方一致、英数字の語では1文字違いまでの一致で探します。
- 管理画面では`Cmd/Ctrl+K`で検索できます。

## HTMLの表示の制限

- 既定（static）では、scriptを動かしません。script、event属性、iframe・object・embed、base、自動の移動（meta refresh）、formの送信先、外部の画像・CSS・fontを取り除きます。linkは表示の中では押せず、「Links in this document」の一覧から開きます。
- 読み込めるのは、文書が参照する、assets-root（既定は文書のあるdirectory）の中のfileだけです。`.env`や`.git`など名前が「.」で始まるfileは読み込みません。範囲は`--assets-root`、個別のfileは`--asset`で指定します。
- `--html-mode interactive`を指定したHTMLだけ、scriptを動かします。自分やAgentが用意した、信頼できるHTMLだけで使ってください。scriptが読み込めるのは登録したfileだけで、管理画面・管理API・fileには触れられませんが、表示の中でのpageの移動など、すべての外部への通信を止めるものではありません。daemonを起動し直すと、管理画面で許可し直すまで静的表示になります。
- 元の文書と表示が違う点は、管理画面の「Differences from the original document」に、対象・理由・対処とともに表示します。

## Markdownの表示

管理画面のheaderにある「Color palette」で、Standard（初期値）、GitHub、Gruvbox、Catppuccin、GitHub High Contrastから配色を選べます。明るさは「Light」「Dark」「Match OS setting」で別に選びます。どちらの設定もbrowserに保存します。配色は管理画面とMarkdownの本文・コードに適用し、HTMLの独自の配色やPDFの印刷用の配色は変えません。

文書のheaderの「Wide view」で、本文を表示領域いっぱいに広げられます。もう一度押すと標準幅に戻ります。幅の設定はbrowserに保存します。表は列幅を確保し、表示領域に収まらないときは表の中を横にスクロールできます。keyboardでは表にfocusを合わせ、左右の矢印keyでスクロールできます。

### 表示の制限

Markdownは、TanStack Markdown 1.0.0で表示します。CommonMark・GFMの完全な互換ではありません。

- 生のHTMLは描画せず、文字として表示します。
- 外部の画像は読み込みません。文書と同じdirectoryの下の画像だけを表示します。
- コードの色付けは、JS・JSX・TS・TSX・JSON・YAML・HTML・CSS・Bash・Markdownだけです。256KiBを超えるコードと、それ以外の言語は色を付けません。
- 解析が2秒で終わらない文書や、要素が10万を超える・入れ子が64段を超える文書は、原文で表示します。

## 画像ファイル

```bash
vo diagram.png                          # 画像を直接開く
vo open photo.jpg animation.gif --focus  # 画像を開いて表示を切り替える
vo open images -w                        # 後から追加された画像も開く
```

PNG/APNG、JPEG（`jpg`・`jpeg`・`jpe`・`jif`・`jfif`・`pjpeg`・`pjp`）、GIF、WebP、AVIF、SVG、BMP、ICO/CUR、JPEG XL、TIFF、HEIC/HEIFを認識します。初期表示は画面に収まる大きさで、「Actual size」を押すと原寸で表示し、スクロールできます。fileを保存すると表示が更新され、更新を一時停止すると表示中の版を保ちます。同じ画像のURLを、同じ端末の別browserでも開けます。

画像は変換せず、元のfileをbrowserが読み込みます。表示できる形式はbrowserとOSによって異なり、特にJPEG XL・TIFF・HEIC/HEIFは対応環境が限られます。未対応の形式や壊れた画像はerrorを表示します。SVGも画像として表示し、scriptや外部参照は動かしません。

画像はtitleとpathで検索できます（`vo search diagram --mode path`）。文字の取り出し、`vo read`、PDF出力はMarkdownとHTMLが対象で、画像のOCRは行いません。画像にも既存の1fileあたり10MiBの上限を適用します。

## PDF出力

文書のheaderの「Export PDF」で、表示中の版を、印刷のdialogを挟まずにPDFとして保存します。

- MarkdownのPDFは白背景のA4です。全pageのheaderに文書名、footerにpage番号（「3 / 12」）を入れ、見出しをPDFのしおりにします。
- daemonが、その環境に入っているGoogle ChromeかMicrosoft Edge（131以降）で印刷します。何もdownloadしません。別のChromium系browserや、別の場所にあるbrowserを使うときは、daemonの環境変数`VDE_OPEN_BROWSER`に実行fileの絶対pathを指定し、`vo daemon restart`を実行します。
- Markdownは表示と同じ規則に従います。生のHTMLは文字として表示し、文書に登録された画像だけを入れ（それ以外は代替textを表示）、他のlocal文書へのlinkは文字だけにします。
- file名は、文書のfile名の拡張子を`.pdf`にしたものです（`README.md` → `README.pdf`）。stdinから開いた文書は文書名を使います。
- Markdownの書体や、HTMLで登録済みfontを指定していない部分の書体は、その環境に入っているものを使うため、OSごとに少し見た目が変わります。
- HTMLは静的表示と同じ規則で出力します。HTML自身のCSS（`@media print`・`@page`を含む）と登録済みのCSS・画像・fontを使います。用紙の指定がなければA4、余白20mmです。Markdown用の配色・header・footerは付けません。interactiveで表示している文書も、scriptを動かさず、保存されたHTMLから出力するため、操作後の状態は含みません。
- 印刷は60秒以内に終わる必要があります。

## 状態の保存先と停止

- 状態（開いている文書、版、質問と回答）は、次の場所に保存します。`VDE_OPEN_HOME`で変えられます。
  - macOS: `~/Library/Application Support/vde-open`
  - Linux: `$XDG_STATE_HOME/vde-open`（未設定なら`~/.local/state/vde-open`）
  - Windows: `%LOCALAPPDATA%\vde-open`
- daemonは`vo daemon stop`で止め、`vo daemon status`で状態を確かめます。
- 管理画面の配色・表示の切り替えなどはbrowserに保存します。

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
| daemonの再起動後、以前のURLで画面が開かない | `vo ui`で現在のURLを開く（再起動でportが変わる場合がある） |
| 終了コード8（daemonへ接続できない・起動できない） | `vo daemon status`で確かめ、`vo doctor`で残ったfileを調べる |
| 画像やCSSが表示されない | 「Differences from the original document」を開き、`--assets-root`・`--asset`で登録する |
| 検索で見つからない | `vo list --json`で、文書が開いていて`searchState`が`ready`かを確かめる |
| Export PDFで、Google ChromeかMicrosoft Edgeが必要と表示される | Chrome・Edgeの131以降を入れるか、`VDE_OPEN_BROWSER`にChromium系browserの絶対pathを指定して`vo daemon restart`を実行する |

## 検証した範囲

| 範囲 | 状態 |
|---|---|
| CIのLinuxとmacOS（GitHub Actionsの`ubuntu-latest`と`macos-latest`、Node.js 24.21.0） | 検証済み（format・lint・typecheck・unit／integration・build・pack・e2e。`.github/workflows/ci.yml`） |
| CIのWindows（`windows-latest`、Node.js 24.21.0） | 検証済み: build、pack smoke（導入、両bin、IPC、daemonの起動と停止、JSON出力、管理画面とworker）、daemonと文書の結合試験。そのほかの単体・結合試験とe2eは、Windowsでは実行していない |
| browser | Chromium（PlaywrightのChrome Headless Shell）は全件を検証済み。Firefox・WebKit（Playwright 1.63.0）は、表示の隔離・CSP・HTMLとの通信・URLからの表示の試験（`pnpm test:e2e:cross`）を検証済み。Firefox・WebKitのそれ以外の画面操作（検索、回答panel、狭い画面、1,000文書の一覧など）は未検証 |
| PDF出力 | macOS（開発機）で、Google Chrome 154とMicrosoft Edge 154での出力を検証済み。CIのLinuxで、runnerのGoogle Chromeでの出力を検証済み（e2e）。Windowsでの実際のbrowserでの印刷は未検証（印刷用の文書の描画はpack smokeで確かめる） |

性能の実測は [docs/performance.ja.md](docs/performance.ja.md)、設計は [docs/architecture.ja.md](docs/architecture.ja.md) と [docs/security-model.ja.md](docs/security-model.ja.md) にあります。開発の記録は [docs/implementation-status.md](docs/implementation-status.md)、[docs/dependency-validation.md](docs/dependency-validation.md)、[docs/adr/](docs/adr/) にあります。

## リンクしたCLIで開発する

repositoryのrootで一度buildし、CLI packageをglobalにlinkして、watcherを起動します。

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/cli
bun link
bun link -g vde-open
cd ../..
pnpm build:watch
```

`build:watch`は、source・build設定・同梱fileが変わるとbuildし直します。buildが失敗しても、直前に成功した出力が残ります。次のCLI実行から新しいbuildが使われますが、watcherはdaemonを再起動しません。`vo daemon restart`、続けて`vo ui`を実行します。登録した文書と保存済みの回答は引き継ぎますが、UIのURLが変わり、以前の表示用URLとinteractive HTMLの許可は失効します。

UIを頻繁に調整するときは`pnpm dev`を使います。別の`.dev-home`でsourceのdaemonを動かし、Vite HMRでUIの変更を反映します。link先のCLIはbuildせず、backendのsourceを変更しても自動再起動しません。この環境へCLIでつなぐときは、`VDE_OPEN_HOME`に`.dev-home`の絶対pathを指定します（repositoryのrootなら`VDE_OPEN_HOME="$PWD/.dev-home" vo list`）。

## 公開の手順

npmへの公開は、GitHub Actionsがtrusted publishing（OIDC）とprovenance付きで行います。npmのtokenはどこにも置きません。npmjs.comのtrusted publisherはこのrepositoryの`publish.yml`で、tokenでの公開は禁止しています。

1. `apps/cli/package.json` の `version` を上げ、`main` へcommitする。
2. その版のtagをpushする: `git tag v<版> && git push origin v<版>`。
3. `.github/workflows/publish.yml` が、tagと版の一致を確かめ、検査とpack smokeを通してから、tarballを公開する。

## License

[MIT](LICENSE)。同梱した依存のlicenseは、それぞれのpackageに従います。一覧とlicenseの本文は、配布物の`THIRD_PARTY_NOTICES.md`にあります（`pnpm build`がbundleの内容から作ります）。
