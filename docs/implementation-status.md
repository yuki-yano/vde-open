# 実装状況

仕様は`tmp/vde-open-handoff/`の引き継ぎ一式 1.1.0（`IMPLEMENTATION_SPEC.md`、`ACCEPTANCE_TESTS.md`）。この文書は、フェーズの状態、受け入れテスト125 IDの対応、次のフェーズへの引継ぎを記録する。

## 進め方

- 実装はP0〜P7の順。フェーズごとにDoD（仕様17.2）を確認し、別Agentのレビューを受けてからcommitする。
- commitはフェーズごとに行う。pushはしない。`origin`は公開リポジトリのため。
- GitHub ActionsのCI定義は作るが実行しない。LinuxとWindowsのCI項目はNOT RUNとする。

## フェーズの状態

| Phase | 状態 | 完了ゲート（仕様15章） |
|---|---|---|
| P0 | 完了報告済み | clean buildと両help/version。依存版記録。125 IDの担当フェーズ割当 |
| P1 | 完了報告済み | restart復元、crash/disk error、同時起動テスト |
| P2 | 完了報告済み | 文書追加とatomic saveが実UIへ反映。raw HTMLが動かない。未認証では管理APIを読めない |
| P3 | 完了報告済み | security fixture、path traversal、他文書/API遮断 |
| P4 | 未着手 | Agent検索benchmark fixtureと閉じた文書除外 |
| P5 | 未着手 | 保存前成功なし、タイムアウト・restart・二重送信テスト |
| P6 | 未着手 | HTML回答案→本体確認→CLI取得、偽submit拒否 |
| P7 | 未着手 | 全必須受け入れ項目、最終実行結果、制約の説明 |

## P0の記録

レビュー: 2往復。1往復目のmust-fix 3件（Windowsでのscript起動、pack検証の後始末、受け入れIDの担当フェーズ）とshould-fix 1件（watcherの待機）を修正。2往復目はmust-fixなしで、should-fix 1件（watcherテストの期限）を修正した。

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1。

| command | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 成功。peer dependencyの警告なし |
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0（root、shared、document、cli、web） |
| `pnpm test` | exit 0（5 files、22 tests） |
| `pnpm build` | exit 0（`apps/cli/dist/cli.js`、`apps/cli/dist/web/`） |
| `pnpm test:pack` | exit 0（`artifacts/vde-open-0.1.0.tgz`を、空白と日本語を含む空のdirectoryへ導入し、両binのversion・helpが一致） |

実装したもの:

- pnpm workspace（`apps/cli`、`apps/web`、`packages/shared`、`packages/document`）と、Node 24.21.0の固定（`mise.toml`）。
- `vde-open`と`vo`の両bin。同じ`dist/cli.js`を指し、`--help`と`--version`を返す。
- CLI JSON envelopeとexit codeの定義（`packages/shared`）。
- 依存の契約テスト。TanStack Markdown／Highlight、parse5、css-tree、Hono、MiniSearch、Chokidar、tinyglobby、`Intl.Segmenter`について、前提にするAPIと挙動を固定した。
- build（tsdown → Vite → `dist/web`へcopy）と、pack検証（仕様14.4の手順1〜3）。

P0時点の制約:

- CLIはhelpとversionだけ。文書を開く機能はP1から。Web UIはビルド確認用の最小構成で、P2で実装する。
- `pnpm dev`と`pnpm test:e2e`はP2で追加する。Playwrightは未導入。
- pack検証は仕様14.4の手順1〜3まで。手順4以降はP1以降で足す。
- CI定義はP7で追加する。
- Windowsでのscript起動は未検証。`.cmd`のshimはquote済みのcommand lineを`cmd.exe`へ渡す実装で、文字列の組み立てだけをunit testで固定している（`tests/scripts/lib.test.ts`）。

## P1の記録

レビュー: 1往復目でmust-fix 7件とshould-fix 4件、2往復目でmust-fix 2件とshould-fix 1件、3往復目でmust-fix 1件（重複として除かれる指定の形式検査が抜けていた）。すべて修正した。以下は1往復目、その後に2往復目の内容。

- 停止時に実行中のcommitを待たずlockを解放していた → 受付停止、実行中の処理とcommitの完了、lock解放の順にした。
- 停止済みlockの回収で、lockが存在しない瞬間ができていた → lockを世代方式へ変えた。
- 安全でないと判定したruntimeの中身を後始末で消していた → 自分が検査・作成したものだけ消すようにした。
- `doctor --repair`がdaemonの起動と排他されていなかった → 修復の間、daemonと同じlockを取るようにした。
- 既存のdaemonへの接続と修復が、state rootの安全性検査を通っていなかった → 接続前と修復前に検査するようにした。
- `close <path>`が、cwdの違う同名のfileを閉じていた → canonical pathだけで照合するようにした。
- IPCのrequestに期限がなく、closeしても待機が終わらなかった → 期限を設け、close・切断でrejectするようにした。
- client側の認証前frame上限、保存結果が不明な状態でのGC、読み込み前の件数・容量の検査、option値の取り違えも修正した。
- （2往復目）世代lockで、古い世代のfileが消された後に同じ世代を作り直せていた → 作成後に自分が最大の世代であることを確かめ、違えば取得を成立させないようにした。
- （2往復目）clientの`close()`が相手の切断を待ち、daemonが応答不能だとCLIが終了しなかった → 相手に依存せず接続を破棄するようにした。
- （2往復目）文書数の上限を、重複を除く前の候補数に適用していた → canonical pathで重複を除いてから数えるようにした。

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（18 files、175 tests） |
| `pnpm build` | exit 0（`dist/cli.js`、`dist/daemon.js`、`dist/web/`） |
| `pnpm test:pack` | exit 0（仕様14.4の手順1〜5と7。空白と日本語を含むpathへ導入） |

実装したもの:

- state store（`apps/cli/src/persistence/`）。checksum付きの`state.json`、`state.prev.json`、内容アドレスのblob。変更は直列のcommit queueを通る。`state.json`の置換前の失敗は元stateのまま運転を続け、置換後の失敗は`E_COMMIT_INDETERMINATE`を返して書込みを止める（仕様7.2）。
- IPC（`apps/cli/src/server/`）。Unix domain socket／named pipe上のNDJSON。HMACによる相互確認の後だけmethodを受ける。認証前のframeは4KiBまで。
- daemon（`apps/cli/src/daemon/`）。state rootごとに1つ。世代で管理するlockで単一writerにする。所有者が生きているlockは引き継がず、解放済みか、所有者の停止（processの不在、または「lockより後に起動したprocess」＝pidの再利用）を確かめたときだけ、次の世代を排他的に作って引き継ぐ（ADR-0005）。停止時は、受付済みのrequestとcommitが終わってからlockを解放する。
- CLI。`open`（file、directory、`-R`、glob、stdin、`--format`、`--title`、`--key`）、`list`、`read`（原文、`--lines`、`--revision`、`--max-bytes`、`--cursor`）、`close`（ID、path、`--all`）、`daemon start|status|stop|restart`、`serve`、`doctor`（`--repair --yes`）。最上位のfile引数は`open`として扱う。
- 版の保持。直近2版と、5分以内に作られた版を残す。保持していない版は`E_REVISION_UNAVAILABLE`で、現在の版で代用しない。

P1時点の制約:

- 文書の更新は、開き直したときに読み直す。fileの監視と自動反映はP2。
- `read`は原文の取得だけ。`--outline`はP2、`--section`はP4で足す。検索はP4。
- 管理UIとHTTP listenerはP2。`--open`／`--no-open`／`--focus`、`ui`、`focus`、`refresh`、`watch`はP2で足す。
- `--html-mode`、`--assets-root`、`--asset`はP3。HTMLは登録できるが、表示はP3から。
- titleの推定は、sourceの先頭64KiBだけを解析する。P2で解析workerへ移す。
- blobのGCは実装済みだが、定期実行はしていない。P5でpinと合わせて組み込む。
- Windowsは未検証。named pipeとDACLの確認は実装上の分岐だけで、実機で動かしていない。

## P2の記録

レビュー: 1往復目でmust-fix 8件とshould-fix 2件、2往復目でmust-fix 2件とshould-fix 1件。すべて修正し、3往復目で指摘なし。以下は1往復目、その後に2往復目の内容。

- 遅れて終わった古い読み直しが、新しい内容を上書きしていた → 同じfileの「読む→公開する」を1件ずつ行うようにした（2往復目で方式を変更。下記）。
- 監視ruleの走査が、走査の間に明示的に開かれた文書を、通知なしで走査時の内容へ戻していた → commitの時点の状態で、すでに開いている文書を対象から外すようにした。
- daemonが止まっている間のfileの変更を、再起動後に取り込んでいなかった → 起動後にまだ読んでいない文書は、読み直して保存済みの内容と照合するようにした。照合に使うfileの状態は、実際に読み取った内容に対応するものだけにした（読み直した後のstatを使わない）。
- 監視ruleの走査が、件数と合計の大きさを確かめる前に全候補を読み込んでいた → 件数は読み込む前に、合計の大きさは読み込みながら確かめ、上限に達したら残りを読まないようにした。
- sessionを破棄しても、接続済みのSSEへ通知が流れ続けていた → 破棄と期限切れで、そのsessionのSSEを閉じるようにした。接続を保つだけでは期限を延ばさない。
- UIの一覧の再取得が並行し、遅れて届いた古い一覧が新しい一覧を上書きできた → 再取得を1つずつ行うようにした。
- titleだけの変更や、同じ内容のままの状態回復で、通知が出ていなかった → 本文以外の変更も通知するようにした。
- 前の版の見出しを、文書の現在の形式で解析していた → 版ごとに形式を記録し、その形式で解析するようにした。
- （should-fix）`--open`と`--no-open`の競合の検査が、`--`より後のfile名やoptionの値も数えていた → parserがoptionとして認識した指定だけを数えるようにした。
- （should-fix）SYS-002のテストが、既定のbrowser起動の条件（端末からの実行で、daemonを新しく起動したとき）を通っていなかった → stdoutが端末である条件で、指定なしの初回と2回目を検証するテストを足した。
- （2往復目）1往復目の修正は、読み込みを始めた順番で新旧を決めていた。先に始めた読み込みが後から新しい内容を読むことがあり、巻き戻りが残っていた → 順番での判定をやめ、canonical pathごとの待ち行列で、読み込みから公開までを1件ずつ行うようにした。明示的なopen、読み直し、監視の走査のすべてが同じ待ち行列を通る。複数のfileを扱うときは決まった順に取得する。
- （2往復目）UIの一覧の再取得で、取得が終わってから次の取得が始まるまでの間に依頼が入ると、取得が並行していた → 単一の実行loopで依頼を処理する形に直した。
- （2往復目、should-fix）sessionの期限が切れた後も、次の定期確認までは通知を送っていた → 通知を書き込む直前にも、期限を延ばさない確認を行うようにした。

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1、Chromium（Playwright 1.63.0同梱のChrome Headless Shell 153）。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（32 files、259 tests） |
| `pnpm build` | exit 0（`dist/cli.js`、`dist/daemon.js`、`dist/workers/parse-worker.js`、`dist/web/`） |
| `pnpm test:pack` | exit 0（仕様14.4の手順1〜7。手順6は同梱UIの配信と解析workerまで） |
| `pnpm test:e2e` | exit 0（Chromiumで9件。`pnpm build`の出力を使う） |

実装したもの:

- 管理listener（`apps/cli/src/server/http/management.ts`）。`127.0.0.1`のOS割当port。Hostは実際のlisten先だけ、Originは管理UIのoriginだけを受け付ける。状態を変えるrequestはOrigin必須でbodyはJSON。CORSは許可しない。
- 認証（`session-service.ts`）。CLIが一回限りのticket（60秒）をURLのfragmentで渡し、UIがsession tokenへ交換する。fragmentは読んだ直後に履歴から消す。tokenはtabのmemoryとsessionStorageだけ。sessionはidle 12時間で、daemonの再起動で失効する。
- 更新通知（`event-hub.ts`、`GET /_/api/v1/events`）。Bearer付きのfetchで読むSSE。IDと版だけを流す。UIは接続のたびと通知のたびに一覧を取り直す。
- file監視（`apps/cli/src/watch/watch-service.ts`）。開いている文書の親directoryと、監視ruleの起点だけを監視する。通知は200msまとめ、通知が欠けた場合に備えて定期的にstatで照合する。`--watch`のruleは、通知を契機に登録時と同じ規則で再走査する。
- 解析worker（`apps/cli/src/workers/`）。見出しの構造を別threadで解析する。2秒で終わらなければworkerを止めて作り直す。結果は解析した版にだけ結び付ける。
- Markdownの描画（`packages/document`）。生HTMLは無効。linkはhttp(s)・mailto・文書内の見出しだけ。画像は読み込まない（localの画像はP3）。highlightは明示登録した言語だけで、256KiBを超えるblockと未知の言語は色付けしない。
- 管理UI（`apps/web`）。Tailwind CSS、shadcn/ui（Base UI版）で構成。文書の一覧（順番／階層、並べ替え、一覧から外す）、プレビュー／原文、更新を止める／再開、見出しの一覧、配色（ライト／ダーク／OS追従）、一覧の幅変更。
- CLI。`ui`（`--print-url`）、`focus`、`refresh`、`watch list|remove`、`read --outline`、`open`の`--watch`・`--open`・`--no-open`・`--focus`、`serve --port`。引数なしは`ui`。
- `pnpm dev`（`scripts/dev.ts`）。専用のstate home（`.dev-home`）でdaemonを前景起動し、ViteのHMRで開発用UIを配信する。開発用originの許可は、sourceから実行したdaemonだけが受け付ける。

P2時点の制約:

- HTML文書は原文の表示だけ。sandboxでのプレビューはP3。
- Markdown中の画像は表示しない（代替textを表示）。localの画像はP3の限定asset経由で表示する。相対linkは無効（localの文書linkの確認はP3）。
- 検索（`Cmd/Ctrl+K`）はP4。質問と回答はP5。
- e2eはChromiumだけ。FirefoxとWebKitでは実行していない（NOT RUN）。
- Setext見出し、indent code、裸URLは変換しない（TanStack Markdownの対応範囲。`packages/document/tests/react.test.tsx`で挙動を固定）。
- Windowsは未検証。browserの起動は`rundll32`を使う分岐だけで、実機で動かしていない。

テスト中に見つけて直した不具合:

- daemon停止の通知（`daemon-stopping`）がUIへ届かなかった。通知の書き込みが終わる前にstreamを閉じていた。書き込みを順に待ってから閉じるようにした。
- TanStack Markdownの`urlTransform`は解析時のoptionで、描画時に渡しても効かなかった。危険でないURLだけを残す処理を解析時へ移し、描画側でも画像を読み込まない部品に置き換えた。

## P3の記録

レビュー: 1往復目でmust-fix 5件とshould-fix 3件、2往復目でmust-fix 2件とshould-fix 2件、3〜5往復目でmust-fix各1件。すべて修正した。5往復目の指摘への対応は、レビューの往復の上限（5回）に達したため、再レビューを受けていない。P4のレビューで合わせて確認する。以下は1往復目から順に、各往復の内容。

- 画像などの名前を付けたsymlinkで、assets-rootの中の秘密のfile（`.env`など）を登録できた → 登録できるかの検査を、symlinkを解決した後の実体にも適用した。
- 表示用の変換を待つ間に文書が閉じられると、閉じた後から表示の権限が発行された → 権限を、発行時点の「文書を閉じた回数」に結び付け、変換の後に確かめ直すようにした。
- linkから文書を開く確認が、確認した版と行き先に固定されていなかった → serverが発行する1回限りの識別子で、確認した文書・版・link・行き先に結び付けた。行き先が変わっていたら確認し直す。
- 参照の走査の失敗を「参照なし」として公開し、assetと監視対象を失っていた → 走査の失敗を区別して記録し、調べ終えたassetを持つ文書は前の版を保つようにした。
- 名前をescapeで書いた`@import`や、変数からURLを差し込む`image-set()`が、CSSの変換を通過した → 何を取得するか判定できない規則・宣言を無効化するようにした。
- （should-fix）`--watch`で後から見つけた文書に`--assets-root`が引き継がれなかった → ruleにassets-rootを保持するようにした。
- （should-fix）同じ内容の文書が別の位置にあるとき、変換結果のcacheが先の文書の位置を返した → cacheを版と文書の位置の組で引くようにした。
- （should-fix）assets-rootのないstdinの文書への`--asset`が、黙って無視された → errorにした。
- （2往復目）CSSの走査だけが失敗したとき、追うfileは空にしたのに、照合用の状態には捨てたCSSの状態が残り、変更がなくても読み直しが続いた → 追うfileと照合用の状態を、同じ採用結果から作るようにした。
- （2往復目）同じkeyのstdinを並行して開くと、調べ終えたassetを、後から終わった「調べられなかった結果」が置き換えた → 同じkeyの更新は、走査から登録までを1件ずつ行うようにした。登録の時点の状態でも確かめる。
- （2往復目、should-fix）linkの確認の識別子が、表示の切り替えで終わった場合に消費されず、後で再利用できた → どの結果になっても、渡された時点で使い終えるようにした。
- （2往復目、should-fix）参照のない文書で、版が同じまま走査が成功へ変わっても、UIの注意書きが残った → 走査に失敗している間は、文書の状態が更新されるたびに、UIが表示の情報を取り直すようにした。
- （3往復目）2往復目の修正は、取得した結果そのものを理由に取り直していた。初回の取得の直後にも取り直しが起き、表示中の権限を返していた → 取り直すかどうかを「取得した時点の更新時刻」と「いま届いている更新時刻」の比較で決めるようにした。権限を返すのは、表示を差し替えた後と、表示をやめたときだけにした。取り直しに失敗したときは、表示中の権限と内容を保つ。
- （4往復目）3往復目の修正は、画面の差し替えを予約した直後に前の権限を返していて、前の表示が画面に残っている間に権限が失効しえた → 表示から外す権限をいったん退避し、画面の更新が反映された後で返すようにした（仕様10.2「古いiframeを外した後」）。
- （5往復目）4往復目の修正は、どの描画のeffectでも、退避した権限をすべて返していた。新しい権限を受け取ってから、それを使う描画が反映されるまでの間に、前の描画のeffectが動くと、画面に出ている権限を返した → effectが属する描画で画面に出している権限は返さずに残し、次の描画のeffectで返すようにした。実際のReact DOMで、この順序を制御して確かめるテストを足した。

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1、Chromium（Playwright 1.63.0同梱のChrome Headless Shell 153）。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（40 files、339 tests） |
| `pnpm build` | exit 0 |
| `pnpm test:pack` | exit 0（手順6に、導入先だけでHTMLの静的変換と表示用のlistenerが動くことの確認を追加） |
| `pnpm test:e2e` | exit 0（Chromiumで17件） |

実装したもの:

- assetの登録（`apps/cli/src/assets/`）。文書を開くときに、HTML・CSS・Markdownが実際に参照するlocal fileだけを集め、内容を保存する。assets-rootの外、symlinkで外へ出るfile、`.`で始まる名前のfile、対応外の種類は登録しない。版は、本文とassetの内容から計算する（ADR-0009）。
- 静的な表示への変換（`packages/document/src/html-static.ts`、`css-transform.ts`）。parse5とcss-treeの構文木を書き換える。script、event属性、埋め込み、自動の遷移、外部への要求につながる指定、文書に直接書かれたSVGとMathMLを取り除く。出力をもう一度解析して確かめる。
- 表示用のlistener（`apps/cli/src/server/http/preview.ts`）と、表示の権限（`apps/cli/src/render/render-service.ts`）。管理UIとは別のportで、発行した権限のURL（`/r/<grant>/files/<path>`）に、その版に登録したfileだけを配信する（ADR-0008）。
- 管理API。`POST /documents/:id/render-grants`（権限の発行）、`POST /render-grants/release`（返却）、`POST /documents/:id/links/:linkId/open`（文書中のlinkから文書を開く。未登録の文書は確認が必要）。`GET /status`に表示用のlistenerのoriginを追加。
- 管理UI。HTMLは空のsandboxのiframeで表示する。枠の中が文書の内容であることと表示の種類を常に示す。取り除いたものの種類・対象・対処の一覧、文書中のlinkの一覧、未登録の文書を開く前の確認。Markdownは登録済みの画像を表示し、相対linkは確認してから開く。
- CLI。`open`に`--html-mode static`、`--assets-root <dir>`、`--asset <path>`（複数回）。`serve --preview-port <n>`。
- 監視。文書が参照しているfile（存在しない参照先を含む）の変更も追う。

管理認証の異常系（仕様15章のP3の項）の検証箇所:

- 期限: ticket 60秒とsession 12時間（`apps/cli/src/server/session-service.test.ts`）、期限切れでSSEを閉じる（`apps/cli/src/server/http/management.test.ts`）、表示の権限がsessionとともに失効（`tests/integration/preview.test.ts`）。
- 再利用: ticketの2度目の交換を拒否（`tests/integration/http.test.ts`、`tests/e2e/viewer.spec.ts`）。
- rebinding: 管理listenerと表示用のlistenerの両方で、実際のlisten先以外のHostを拒否（`tests/integration/http.test.ts`、`tests/integration/preview.test.ts`）。
- logの秘匿: ticket、token、表示の権限、表示用URLのpathがlogに無い（`tests/integration/http.test.ts`、`tests/integration/preview.test.ts`）。

P3時点の制約:

- HTMLの表示は静的な表示だけ。scriptを動かす表示（interactive）はP6。`--html-mode interactive`はerrorになる。
- 文書に直接書いたSVGとMathMLは表示しない。SVGはfileにして`<img>`で参照すれば表示できる。動画と音声は表示しない。
- HTML文書の見出しの一覧から、表示の中の見出しへ移動する操作は未実装（P7のUI仕上げで扱う）。
- 表示用の変換と参照の走査は解析worker（2秒で打ち切り）で行う。変換が打ち切られた文書は原文を表示する。走査が打ち切られた文書は、assetなしで登録して警告と表示で知らせる（調べ終えたassetを持つ文書の更新では、前の版を保つ）。大きい文書での所要時間はP7で測る。
- stdinから開いた文書のassetは、開いた時点の内容で固定される（監視しない）。
- e2eはChromiumだけ。FirefoxとWebKitでは実行していない（NOT RUN）。Windowsは未検証。

## 受け入れテストの対応

状態は「未着手／PASS／FAIL／NOT RUN」。担当は、そのIDが最後に必要とする機能がそろうフェーズ。IDをPASSにするのは担当フェーズで全条件を検証したときだけで、先行フェーズで一部だけ検証したものは備考に部分検証として書く。

| ID | 担当 | 状態 | test | 備考（部分検証を含む） |
|---|---|---|---|---|
| CLI-001 | P7 | 未着手 |  |  |
| CLI-002 | P0 | PASS | `apps/cli/src/cli/run.test.ts`、`scripts/pack-smoke.ts`（手順3） |  |
| CLI-003 | P1 | PASS | `tests/integration/documents.test.ts`、`scripts/pack-smoke.ts`（手順4） |  |
| CLI-004 | P1 | PASS | `tests/integration/documents.test.ts`、`scripts/pack-smoke.ts`（手順5） |  |
| CLI-005 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-006 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-007 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-008 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-009 | P2 | PASS | `tests/integration/browser.test.ts` |  |
| CLI-010 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-011 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-012 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-013 | P7 | 未着手 |  | P2で部分検証済み（`scripts/pack-smoke.ts`手順6: repo外のcwdから同梱UIを配信し、cwdのfileは配信しない） |
| CLI-014 | P7 | 未着手 |  |  |
| CLI-015 | P7 | 未着手 |  |  |
| CLI-016 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| SYS-001 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| SYS-002 | P2 | PASS | `tests/integration/browser.test.ts` | 既定のbrowser起動は、stdoutが端末である条件をCLIへ直接渡して検証（子processでは端末を再現できないため） |
| SYS-003 | P5 | 未着手 |  | P1・P2で部分検証済み（再起動後に文書ID・順序、監視ruleと「閉じた文書を復帰させない」扱いを復元）。質問・回答はP5で追加 |
| SYS-004 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-005 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-006 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-007 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-008 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/secure-dir.test.ts` | Unixで検証。WindowsはDACLを検証しておらず、種別の確認だけ（実機では未検証） |
| SYS-009 | P5 | 未着手 |  | P1で部分検証済み（`apps/cli/src/persistence/state-store.test.ts`: commit途中のどのfile操作で止まっても、復元後は旧か新の整合したstate）。P5で回答のsubmitを含むcaseを足して完了 |
| SYS-010 | P1 | PASS | `apps/cli/src/persistence/state-store.test.ts`、`apps/cli/src/daemon/main.test.ts` |  |
| SYS-011 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/persistence/state-store.test.ts` |  |
| SYS-012 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| SYS-013 | P5 | 未着手 |  | P2で部分検証済み（`tests/integration/http.test.ts`: SSEのhello・変更通知・停止通知、本文を含まない）。waitはP5 |
| SYS-014 | P5 | 未着手 |  |  |
| SYS-015 | P5 | 未着手 |  |  |
| SYS-016 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| DOC-001 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-002 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-003 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-004 | P2 | PASS | `tests/integration/watch.test.ts` |  |
| DOC-005 | P2 | PASS | `tests/integration/watch.test.ts` |  |
| DOC-006 | P2 | PASS | `tests/integration/watch.test.ts` |  |
| DOC-007 | P2 | PASS | `apps/web/src/lib/tree.test.ts`、`tests/e2e/workspace.spec.ts` |  |
| DOC-008 | P2 | PASS | `tests/integration/http.test.ts`、`tests/e2e/workspace.spec.ts` |  |
| DOC-009 | P2 | PASS | `tests/integration/watch.test.ts`、`tests/e2e/viewer.spec.ts` |  |
| DOC-010 | P2 | PASS | `apps/cli/src/documents/service-analysis.test.ts` |  |
| DOC-011 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| DOC-012 | P4 | 未着手 |  |  |
| DOC-013 | P2 | PASS | `tests/e2e/workspace.spec.ts` |  |
| DOC-014 | P2 | PASS | `tests/e2e/workspace.spec.ts`、`tests/e2e/viewer.spec.ts` |  |
| DOC-015 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-016 | P5 | 未着手 |  | P1・P2で部分検証済み（close --allで文書と監視ruleをすべて外す）。回答履歴はP5 |
| SRCH-001 | P4 | 未着手 |  |  |
| SRCH-002 | P4 | 未着手 |  |  |
| SRCH-003 | P4 | 未着手 |  |  |
| SRCH-004 | P4 | 未着手 |  |  |
| SRCH-005 | P4 | 未着手 |  |  |
| SRCH-006 | P4 | 未着手 |  |  |
| SRCH-007 | P4 | 未着手 |  |  |
| SRCH-008 | P4 | 未着手 |  |  |
| SRCH-009 | P4 | 未着手 |  |  |
| SRCH-010 | P4 | 未着手 |  |  |
| SRCH-011 | P4 | 未着手 |  |  |
| SRCH-012 | P4 | 未着手 |  |  |
| SRCH-013 | P4 | 未着手 |  |  |
| SRCH-014 | P4 | 未着手 |  |  |
| SRCH-015 | P4 | 未着手 |  |  |
| SRCH-016 | P4 | 未着手 |  |  |
| MD-001 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-002 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-003 | P2 | PASS | `packages/document/tests/react.test.tsx`、`tests/e2e/viewer.spec.ts` |  |
| MD-004 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-005 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-006 | P2 | PASS | `packages/document/src/analysis.test.ts`、`apps/cli/src/workers/parse-service.test.ts`、`tests/e2e/workspace.spec.ts` |  |
| SEC-001 | P2 | PASS | `tests/integration/http.test.ts`、`apps/cli/src/server/session-service.test.ts`、`tests/e2e/viewer.spec.ts` |  |
| SEC-002 | P2 | PASS | `tests/integration/http.test.ts` |  |
| SEC-003 | P2 | PASS | `tests/integration/http.test.ts`、`tests/e2e/viewer.spec.ts` |  |
| SEC-004 | P6 | 未着手 |  | iframe内でscriptを動かす検証が必要。P3で部分検証済み（`tests/e2e/html.spec.ts`: 空のsandbox、別origin、`allow-same-origin`なし、管理のtokenと表示の権限が互いに使えない） |
| SEC-005 | P3 | PASS | `packages/document/src/html-static.test.ts`、`tests/e2e/html.spec.ts` |  |
| SEC-006 | P3 | PASS | `packages/document/src/html-static.test.ts`、`tests/e2e/html.spec.ts` | 外部への要求は、browserのrequestと、記録用のserverの両方で0件を確認 |
| SEC-007 | P6 | 未着手 |  | interactiveが必要なためP6 |
| SEC-008 | P6 | 未着手 |  | interactiveが必要なためP6 |
| SEC-009 | P3 | PASS | `packages/document/src/references.test.ts`、`tests/integration/preview.test.ts` |  |
| SEC-010 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-011 | P3 | PASS | `tests/integration/preview.test.ts` | 別のprocessが同時にpathを差し替える攻撃までは防いでいない |
| SEC-012 | P3 | PASS | `packages/document/src/css-transform.test.ts`、`tests/integration/preview.test.ts` | 外部への通信は、応答のpolicy（CSP）でも止める。変換は、それに頼らずに取り除く |
| SEC-013 | P6 | 未着手 |  | module importの実行にはinteractiveが必要。P3で部分検証済み（`tests/integration/preview.test.ts`: 登録していないpathは404で、同じdirectoryのfileも公開されない） |
| SEC-014 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-015 | P3 | PASS | `tests/integration/preview.test.ts`、`apps/cli/src/render/render-service.test.ts`、`apps/web/src/lib/use-render-grant.dom.test.tsx`、`tests/e2e/html.spec.ts` | UIが権限を返す順序についての最後の修正は、再レビューを受けていない |
| SEC-016 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-017 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-018 | P5 | 未着手 |  | P1〜P3で部分検証済み（`tests/integration/daemon.test.ts`: logに本文・title・path・keyがない。`tests/integration/preview.test.ts`: 表示の権限と表示用URLのpathがない）。回答とdraftを含む操作はP5 |
| SEC-019 | P3 | PASS | `tests/integration/preview.test.ts`、`tests/e2e/html.spec.ts` |  |
| SEC-020 | P3 | PASS | `tests/e2e/release.spec.ts` | 配布物（`apps/cli/dist`）を対象に確認 |
| FB-001 | P5 | 未着手 |  |  |
| FB-002 | P5 | 未着手 |  |  |
| FB-003 | P6 | 未着手 |  | draft検証はP5、SDKの最大サイズはP6 |
| FB-004 | P5 | 未着手 |  |  |
| FB-005 | P5 | 未着手 |  |  |
| FB-006 | P5 | 未着手 |  |  |
| FB-007 | P6 | 未着手 |  |  |
| FB-008 | P6 | 未着手 |  |  |
| FB-009 | P6 | 未着手 |  |  |
| FB-010 | P6 | 未着手 |  |  |
| FB-011 | P6 | 未着手 |  | 2つのUIの競合はP5、SDKのbaseDraftVersionはP6 |
| FB-012 | P5 | 未着手 |  |  |
| FB-013 | P5 | 未着手 |  |  |
| FB-014 | P5 | 未着手 |  |  |
| FB-015 | P6 | 未着手 |  |  |
| FB-016 | P6 | 未着手 |  |  |
| FB-017 | P5 | 未着手 |  |  |
| FB-018 | P5 | 未着手 |  |  |
| FB-019 | P5 | 未着手 |  |  |
| FB-020 | P5 | 未着手 |  |  |
| FB-021 | P5 | 未着手 |  |  |
| FB-022 | P6 | 未着手 |  |  |
| UX-001 | P7 | 未着手 |  |  |
| UX-002 | P7 | 未着手 |  |  |
| UX-003 | P7 | 未着手 |  |  |
| UX-004 | P7 | 未着手 |  |  |
| UX-005 | P7 | 未着手 |  |  |
| UX-006 | P7 | 未着手 |  |  |
| UX-007 | P7 | 未着手 |  |  |
| UX-008 | P7 | 未着手 |  |  |
| PERF-001 | P7 | 未着手 |  |  |
| PERF-002 | P7 | 未着手 |  |  |
| PERF-003 | P7 | 未着手 |  |  |
| PERF-004 | P7 | 未着手 |  |  |
| PERF-005 | P7 | 未着手 |  |  |

## 引継ぎ事項

- 次はP4（検索、section、read cursor、revision整合）。文書の構造の解析は`packages/document/src/analysis.ts`、解析workerは`apps/cli/src/workers/`、文書の操作は`apps/cli/src/documents/service.ts`。
- 管理HTTPは`apps/cli/src/server/http/management.ts`、表示用のlistenerは`apps/cli/src/server/http/preview.ts`、UIは`apps/web/src/`、Markdownの描画は`packages/document/src/react.tsx`、HTMLの静的変換は`packages/document/src/html-static.ts`。
- stateの形式に項目を足した（版ごとのassetと文書の位置、文書ごとのassets-root）。P2までの開発用state（`.dev-home`）は読めないので、消して作り直す。
- P3のレビュー5往復目の指摘への対応（`apps/web/src/lib/use-render-grant.ts`、`apps/web/src/lib/use-render-grant.dom.test.tsx`）は、再レビューを受けていない。P4のレビュー依頼に含める。
- 画面部品のhookは、happy-domの上で実際のReact DOMを動かしてテストできる（file先頭に`// @vitest-environment happy-dom`）。
- 未解決の不具合: なし。
- 未実行のtest: 上の表で「未着手」のもの。e2eのFirefox／WebKit。
- 配布物はruntime依存を持たない方針（ADR-0001）。外部packageを足したら`apps/cli/tsdown.config.ts`の`deps.onlyBundle`へ追加する。
- stdinを入力として扱うのは、shellのpipeかredirectのときだけ（ADR-0004）。
- UIはTailwind CSS、shadcn/ui、Base UIで作る（利用者の指定、ADR-0006）。部品は`pnpm dlx shadcn@4.21.1 add <name>`で`apps/web/src/components/ui/`へ追加する。
- 結合テストは`tests/integration/harness.ts`の`createTestHome()`、e2eは`tests/e2e/harness.ts`の`createE2eHome()`で、試験専用のstate rootとruntimeを使う。browserは`BROWSER`環境変数で差し替えられる。
- e2eは配布物（`apps/cli/dist`）を試す。先に`pnpm build`が必要。
