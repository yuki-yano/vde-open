# vde-open

Agentと人が同じ資料を見ながら作業するための、ローカルの文書viewerです。MarkdownとHTMLの文書を開いて、browserの管理画面で読み、Agentは同じ文書をCLIから検索・読み取りできます。Agentから人へ質問し、人が管理画面で回答を確定することもできます。

- 開いた文書だけを、Agentが検索・読み取りできます（閉じた文書やdirectory全体は探しません）。
- 文書を保存すると、管理画面の表示が自動で更新されます。
- HTMLは、管理画面と分けた別のoriginで、scriptを動かさずに表示します（既定）。
- 状態はlocalのdaemonが持ち、外部のserviceへ送りません。

## 導入

Node.js 24が必要です（このrepositoryは`mise.toml`で24.21.0に固定しています）。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:pack          # artifacts/vde-open-0.1.0.tgz を作り、別のdirectoryへ導入して確かめる
npm install ./artifacts/vde-open-0.1.0.tgz   # 使うproject（またはglobal）へ導入する
```

導入は、`.zshrc`などのshellの設定を変えません。導入時にbuildやscriptも実行しません（tarballは依存をすべて同梱しています）。npmへの公開はしていません。

## `vde-open`と`vo`

同じCLIを2つの名前で導入します。どちらで実行しても、同じstateとdaemonを使います。

- `vde-open` … 正式な名前。
- `vo` … 短い名前。

既に別の`vo`がある場合（ほかのtoolのcommandやaliasなど）は、導入でそれを上書きしたり消したりしません。

- 導入先のbin（`npm install -g`ならnpmのglobalのbin）に別の`vo`のfileがあると、npmは`EEXIST`で導入をやめます。`--force`を付けると既存の`vo`を置き換えるので、付けないでください。projectへ導入して`npx vde-open`で使うか、別のprefix（例: `npm install -g --prefix ~/.local/vde-open ./artifacts/vde-open-0.1.0.tgz`）へ導入して、そのbinの`vde-open`を使ってください。
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

Agentからの使い方は [docs/agent-usage.md](docs/agent-usage.md) にあります（検索→見出しの一覧→節の順に読む、回答の往復、HTMLから回答案を受け取る方法）。

## 検索の範囲

- 検索の対象は、**いま開いている文書だけ**です。閉じた文書、開いていないfile、directory全体は探しません。
- 結果は、検索した時点の公開済みの版です。結果の`revision`を指定して読むと、検索したときと同じ内容を返します。
- 日本語は`Intl.Segmenter`で語に分けます。完全な一致、前方一致、1文字違いまでの英数字の語の一致（fuzzy）を使います。
- 管理画面では`Cmd/Ctrl+K`で検索できます。

## HTMLの表示の制限

- 既定（static）では、scriptを動かしません。script、event属性、iframe・object・embed、base、自動の移動（meta refresh）、formの送信先、外部の画像・CSS・fontを取り除きます。linkは表示の中では押せず、「文書中のlink」の一覧から開きます。
- 読み込めるのは、文書が参照する、assets-root（既定は文書のあるdirectory）の中のfileだけです。`.env`や`.git`など名前が「.」で始まるfileは読み込みません。範囲は`--assets-root`、個別のfileは`--asset`で指定します。
- `--html-mode interactive`を指定したHTMLだけ、scriptを動かします。scriptが読み込めるのは登録したfileだけで、管理画面・管理API・fileには触れられません。ただし、表示の中でのpageの移動などを含め、すべての外部への通信を止めるものではありません。自分やAgentが用意した、信頼できるHTMLだけで使ってください。daemonを起動し直すと、管理画面で許可し直すまで静的表示になります。
- 元の文書と表示が違う点は、管理画面の「元の文書と表示が異なる点」に、対象・理由・対処とともに表示します。

## Markdownの表示の制限

Markdownは、TanStack Markdown 1.0.0で表示します。CommonMark・GFMの完全な互換ではありません。

- 生のHTMLは描画せず、文字として表示します。
- 外部の画像は読み込みません。文書と同じdirectoryの下の画像だけを表示します。
- コードの色付けは、JS・JSX・TS・TSX・JSON・YAML・HTML・CSS・Bash・Markdownだけです。256KiBを超えるコードと、それ以外の言語は色を付けません。
- 解析が2秒で終わらない文書や、要素が10万を超える・入れ子が64段を超える文書は、原文で表示します。

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

人は管理画面の回答panelで回答し、「Agentへ回答を送信」を押したときだけ回答が確定します。送信の前の入力（回答案）はAgentへ返しません。passwordやAPI keyなどの秘密を入力してもらう用途には使わないでください。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `vo`で別のcommandが動く | `vde-open`を使うか、PATHの順番を確かめる |
| 管理画面が「CLIから開き直してください」になる | `vo ui`で新しいURLを開く（URLは一回限り。daemonを起動し直すと前の画面は使えない） |
| 終了コード8（daemonへ接続できない・起動できない） | `vo daemon status`で確かめ、`vo doctor`で残ったfileを調べる |
| 画像やCSSが表示されない | 「元の文書と表示が異なる点」を開き、`--assets-root`・`--asset`で登録する |
| 検索で見つからない | `vo list --json`で、文書が開いていて`searchState`が`ready`かを確かめる |

## 検証した範囲

| 範囲 | 状態 |
|---|---|
| macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0 | 検証済み（format・lint・typecheck・unit／integration・build・pack・e2e） |
| Linux、Windows | 未検証（CI定義は`.github/workflows/ci.yml`にあるが、未実行） |
| browser（macOS） | Chromium（PlaywrightのChrome Headless Shell）は全件を検証済み。Firefox 155・WebKit 26.6（Playwright 1.63.0）は、表示の隔離・CSP・HTMLとの通信・認証の試験（`pnpm test:e2e:cross`）を検証済み |
| browser（未検証） | Firefox・WebKitのそれ以外の画面操作（検索、回答panel、狭い画面、1,000文書の一覧など）は未検証 |
| Markdownの構文 | 上の「Markdownの表示の制限」のとおり。CommonMark・GFMの全体は検証していない |

詳しい記録は [docs/implementation-status.md](docs/implementation-status.md)、性能の実測は [docs/performance.md](docs/performance.md)、設計は [docs/architecture.md](docs/architecture.md) と [docs/security-model.md](docs/security-model.md) にあります。

## License

UNLICENSED（非公開）。同梱した依存のlicenseは、それぞれのpackageに従います。一覧とlicenseの本文は、配布物の`THIRD_PARTY_NOTICES.md`にあります（`pnpm build`がbundleの内容から作ります）。
