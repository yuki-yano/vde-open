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
| P4 | 完了報告済み | Agent検索benchmark fixtureと閉じた文書除外 |
| P5 | 完了報告済み | 保存前成功なし、タイムアウト・restart・二重送信テスト |
| P6 | 完了報告済み | HTML回答案→本体確認→CLI取得、偽submit拒否 |
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

レビュー: 1往復目でmust-fix 5件とshould-fix 3件、2往復目でmust-fix 2件とshould-fix 2件、3〜5往復目でmust-fix各1件。すべて修正した。5往復目の指摘への対応は、往復の上限（5回）に達した後、P3のcommit（`9cf2aab`）の後に再レビューを受け、指摘なしだった（StrictMode、版の切り替え後の取得失敗、表示する版の消失、差し替えの反映前のunmountも、レビュー側で確かめた）。以下は1往復目から順に、各往復の内容。

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

## P4の記録

レビュー: 1往復目でmust-fix 5件とshould-fix 4件、2往復目でmust-fix 4件、3往復目でmust-fix 1件とshould-fix 3件、4往復目でshould-fix 2件。すべて修正し、5往復目は指摘なし。以下は1往復目から順に、各往復の内容。

- 検索のcursorが一覧の版と位置だけを持ち、indexへの反映が進んで並びが変わっても続きを返した（同じhitが2回出た） → cursorを、全hitの並び（文書・版・節）のdigestにも固定した。
- 続きの検索を待っている間に一覧が変わっても、古い位置を新しい一覧へ当てはめた → 続きの検索では、検索の後にも一覧の版を確かめ、変わっていればやり直さずに`E_CURSOR_STALE`にした。
- 本文を変えずにtitleだけを変えると、検索とhitのtitleが古いままだった → title・path・順番の変化もindexへ反映するようにした（本文は入れ直さない）。
- indexを作っている間、検索がworkerの処理の後ろで待ち、反映を待つ上限（2秒）を超えた → 文書の解析を解析用のworkerへ移し、indexへは本文を小さく分けて入れるようにした。長い節は重ねながら分ける。
- 見出しの一覧を分けて返すようにしたのに、管理UIが最初の分しか取得せず、見出しが欠けた → UIが続きをcursorで最後まで取得するようにした。取得できなかったときは、空の一覧にせず、そのことを表示する。
- （should-fix）対象の文書がすべて解析できなくても、0件の成功として返した → 1件も検索できなければ`E_INDEX_NOT_READY`にし、内訳を返す。
- （should-fix）空の文書のhitの節を取得できなかった → 空の文書も空の序文（`sec_0000`）を持つようにした。
- （should-fix）綴りのゆらぎが語の長さに比例して2文字以上の違いを許し、1文字の英数が語の途中に一致した → ゆらぎは1文字まで、語の途中への一致は2文字以上だけにした。
- （should-fix）queryの連続した空白をそろえていたので、`exact`と`path`で空白を含む文字列を探せなかった → `exact`と`path`は指定どおりの文字列で照合する。
- （2往復目）長い節を分けて入れたことで、語の一致の判定が分けた部分ごとになり、離れた部分にある語の組み合わせを取りこぼした → 語ごとに一致を引き、節の単位で、すべての語が現れるかを判定するようにした。
- （2往復目）登録の途中でやめた版へ戻ると、「登録中」の記録が残ったまま入れ直されず、ずっと検索できなかった → やめた登録の記録を消し、残っている「登録中」の記録は終わらなかった登録として入れ直すようにした。
- （2往復目）titleの反映を待っている文書を、検索済みとして数え、一覧でも検索できる状態として示していた → 待機の判定、集計、一覧で、版と属性の両方を見る同じ判定を使うようにした。
- （2往復目）1回に送る量を本文の長さだけで数えていて、本文のない節が多い文書（長い見出しの下に多くの見出し）では、一度に全部を送ってworkerを塞いだ → 見出しを含めた長さと、部分の数で区切るようにした。長い見出しも分けて入れる。
- （3往復目）登録を中断したときに登録の記録を消したので、workerに残った前の確定済みの内容が、文書を閉じた後も消えなかった（検索が常に不完全になり、続きも取れなかった） → workerが内容を持ちうる文書を、登録の記録とは別に覚え、閉じた文書には必ず削除を送るようにした。
- （3往復目、should-fix）節の形（見出しの全文と上位の見出しの全文）を毎回送り、上限を超えてから区切っていたので、1回分が上限を大きく超えた → 見出しの全文はworkerが分けた部分から組み立て、上位の見出しは親の節の番号で持つようにした。上限は、超える前に区切る。
- （3往復目、should-fix）上位の見出しの先頭1Ki文字だけを文脈にしていたので、長い上位の見出しがあると、直近の上位の見出しの語で探せなかった → 上位の見出しを複製せず、上位の見出しにある語を配下の節の一致として数えるようにした。
- （3往復目、should-fix）見出しと本文に分かれて一致した節の抜粋が、見出しに一致した部分から取られ、本文の一致した位置を含まなかった → 本文に一致した部分を優先して抜粋に使うようにした。
- （4往復目、should-fix）見出しの連続した一致で一致の種類を上げるときに、抜粋に使う部分も見出しの部分へ置き換えていた → 抜粋に使う部分を一致の種類とは別に選び、本文に一致した部分を置き換えないようにした。
- （4往復目、should-fix）配下の節へ引き継ぐscoreに、上位の節のtitle・path・本文への一致の点数が混ざり、文書のtitleで順位が変わった → 見出しのfieldだけで引き直したscoreを引き継ぐようにした。

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1、Chromium（Playwright 1.63.0同梱のChrome Headless Shell 153）。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（44 files、394 tests） |
| `pnpm build` | exit 0（`dist/workers/search-worker.js`を追加） |
| `pnpm test:pack` | exit 0（手順6に、導入先だけで検索のworkerが動くことの確認を追加） |
| `pnpm test:e2e` | exit 0（Chromiumで18件。見出しの一覧を分けて返す文書の表示を追加） |

実装したもの:

- 節の抽出（`packages/document/src/analysis.ts`）。Markdownはroot直下の見出しで、HTMLは見出し要素で区切る。序文は`sec_0000`。
- 検索（`apps/cli/src/search/`）。語への分割（`Intl.Segmenter`と英数identifier）、MiniSearchでの語の一致、正規化した本文への連続した文字列の一致、順位付け（ADR-0010）。indexは別のthread（`apps/cli/src/workers/search-worker.ts`）に置く。
- 検索と公開済みの版の対応（`apps/cli/src/search/search-service.ts`）。indexの反映を最大2秒待ち、返す前に、開いていて版・title・pathが一致するhitだけに絞る。検索できない文書はIDを示す。文書の解析は解析用のworkerで行い、indexへは本文を小さく分けて入れる。
- CLI。`search <query>`（`--mode text|exact|path`、`--limit`、`--document`、`--max-bytes`、`--cursor`）、`read --section <sectionId>`。見出しの一覧と検索結果は、`--max-bytes`の予算で要素を分割せずに返し、続きをcursorで取得できる。
- 管理API。`GET /search`、`GET /documents/:id/content`の`section`。一覧の`searchState`。
- `docs/agent-usage.md`（Agentからの使い方）。
- 検索用のfixture（`tests/fixtures/search/`）。

P4時点の制約:

- 管理UIの検索（`Cmd/Ctrl+K`）は未実装。P7で、この検索APIを使って実装する。
- 意味の近さでの検索はしない。綴りのゆらぎは、英数の4文字以上の語で1文字違いまで。
- 節の原文での位置（`sourceRange`）は返さない。原文の行は`read --lines`で取得する。
- HTMLの抽出は静的な解析。scriptが作る内容と、CSSでの表示の有無は反映しない。
- 100文書・1,000文書での所要時間とmemoryは、P7で測る。
- Windowsは未検証。

## P5の記録

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1、Chromium（Playwright 1.63.0同梱のChrome Headless Shell 153）。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（51 files、455 tests） |
| `pnpm build` | exit 0 |
| `pnpm test:pack` | exit 0（手順6に、導入先だけで質問の作成と取得が動くことの確認を追加） |
| `pnpm test:e2e` | exit 0（Chromiumで21件） |

実装したもの:

- 質問定義と回答の契約（`packages/shared/src/feedback.ts`）。重複したkeyと`__proto__`を拒否するJSONの読み込み（`packages/shared/src/strict-json.ts`）。同梱のmeta-schema（`packages/shared/schemas/questionnaire.schema.json`）とのcontract test。
- 質問と回答（`apps/cli/src/feedback/service.ts`、ADR-0011）。作成（文書へ・文書を開いて・質問だけ）、Agent向けの取得（回答案を返さない）、待機、取得済みの印、中止、終わった質問の削除。管理UI向けの取得・回答案の保存・送信。
- stateに質問と回答を保存する。質問が固定した版は、文書の版の整理から外す。文書を閉じると、同じcommitで回答待ちの質問を中止する。
- CLI。`ask`、`feedback list|get|wait|ack|cancel|forget`。`wait`は、daemonの停止・再起動の間も最初の期限まで接続し直す。
- 管理API。`GET /feedback`、`GET /feedback/:id`、`PUT /feedback/:id/draft`、`POST /feedback/:id/submit`、`POST /feedback/:id/cancel`。通知`feedback-changed`。
- 管理UI。回答panel（native form、回答案の自動保存、回答の要約、送信、中止、旧版への回答の確認）。回答待ちの間は質問の版を表示する。一覧に「回答待ち」を表示する。
- `docs/agent-usage.md`に、質問と回答の使い方と、秘密の入力に使わないことを追記。

レビュー: 1往復目でmust-fix 4件とshould-fix 3件、2往復目でmust-fix 2件とshould-fix 1件、3往復目でshould-fix 1件（判定はマージ可）。すべて修正した。3往復目の指摘への対応は、P6のレビューで確認を受ける。以下は1往復目から順に、各往復の内容。

- 回答案の自動保存が成功した直後、まだ再取得していない古い質問の状態を「別の画面の更新」と扱い、入力と版を保存前へ戻していた → 保存した回答と版を組で覚え、それより古い取得結果は使わないようにした（版は増えるだけ）。保存の途中の入力は、未保存のまま残して続けて保存する。
- 回答待ちの間でも「更新を止める」が質問の版より優先され、押すと表示が現在の版へ変わった → 質問の版を最優先にし、回答待ちの間は「更新を止める」を操作できないようにした。
- 旧版への回答の確認をbooleanで持ち、確認した後に版がさらに変わっても、新しい版を確認済みとして送っていた → 確認したときの文書の版を覚え、現在の版と一致するときだけ確認済みとし、送信にもその版を使うようにした。
- `feedback wait`の期限が接続（daemonの起動）にかかる時間を含まず、接続の待ちも期限で打ち切っていなかった → 待機を`apps/cli/src/cli/wait-for-answer.ts`へ分け、接続・再接続・応答の待ちを、開始時に決めた期限で打ち切るようにした。daemonへは接続後の残り時間を渡す。期限の後に成立した接続は閉じる。
- （should-fix）通知の再接続・連番の欠け・`resync-required`で、一覧だけを取り直し、表示中の質問を取り直していなかった → どの場合も質問も取り直すようにした。
- （should-fix）空の文字列と空の配列を一律に未入力として扱い、schemaが許す空の回答（必須で`minLength`がない文字列、`minItems`が0の配列）を送れなかった。選択肢の空の文字列も、未選択と取り違えていた → 空の回答が有効な必須のfieldには「空欄のまま回答する」「どれも選ばずに回答する」の欄を出し、未入力と区別するようにした。選択肢は位置で指す。
- （should-fix）SYS-009は例外で止めて後始末を通っていた。FB-013は通信の切断を起こしていなかった。SYS-014は質問の文書ではない文書を閉じていた → 子processを、送信のcommitのfile操作ごとにkillする試験、commitの途中で管理APIの接続を切って同じ送信IDで再送する試験、質問の文書のcloseと送信を同時に行う試験を追加した。
- （2往復目）`feedback wait`の待機は期限で打ち切っていたが、打ち切った後もdaemonの起動の待ち（起動lockの待ち、起動完了の待ち）が動き続け、CLIのprocessが約10秒残った → 中断の合図（`AbortSignal`）を、daemonへの接続処理（`ensure`、`connectIpc`、起動の待ち、再接続の間隔）まで渡し、待機を終えたら止めるようにした。起動lockを別のprocessが持つ状態で、CLIのprocessが期限の直後に終わることを、実際の子processで確かめる。
- （2往復目）別の画面で回答が確定したとき、この画面の未保存の入力を、送信済みの回答のように表示していた → 確定・中止した質問は、serverの内容（確定した回答、なければ保存済みの回答案）を表示するようにした。
- （2往復目、should-fix）SYS-009の試験は送信だけで、送信は新しいblobを作らないため、blobの作成の直後でのkillを試していなかった → 質問だけの質問の作成（質問の文書のblobを同じcommitで作る）でも、file操作ごとにkillする試験を追加した。blobのrenameの直後（directoryのsyncの前）でkillした場合を明示的に確かめる。
- （3往復目、should-fix）IPCの接続に失敗したとき（接続の拒否、確認の期限切れ、認証の失敗）に、中断の合図のlistenerが残り、同じ合図で接続し直すたびに増えていた。中断済みの合図で呼んだときも、失敗の後にlistenerを登録していた → 接続の失敗でもlistenerを外し、中断済みなら登録しないようにした。

P5時点の制約:

- HTMLの中からの回答（interactiveの表示とSDK）は未実装。P6で実装する。`POST /feedback/:id/render-grants`もP6。
- `--view`は、文書を開くcommitと質問を作るcommitが別（ADR-0011）。
- Windowsは未検証。

## P6の記録

実行環境: macOS（Darwin 25.6.0、arm64）、Node.js 24.21.0、pnpm 12.8.1、Chromium（Playwright 1.63.0同梱のChrome Headless Shell 153）。

| command | 結果 |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0（53 files、505 tests） |
| `pnpm build` | exit 0 |
| `pnpm test:pack` | exit 0（手順6に、導入先だけでscriptを動かす表示とSDKの注入が動くことの確認を追加） |
| `pnpm test:e2e` | exit 0（Chromiumで38件） |

実装したもの:

- scriptを動かす表示（interactive）。文書ごとの希望をstateに残し、scriptの実行の許可はdaemonのmemoryだけに持つ（ADR-0012）。CLIの`--html-mode interactive`（`open`、`ask --view`）と、管理UIの確認つきの操作（`POST /documents/:id/html-mode`）で許可する。再起動・閉じる操作・stdinの更新・`--html-mode static`で外れる。
- interactiveの変換（scriptとevent属性を残し、登録済みのscriptだけを読み込む）、CSP（`script-src 'unsafe-inline' GRANT_BASE`、`connect-src GRANT_BASE`、`sandbox allow-scripts`）、iframeの`sandbox="allow-scripts"`。回答待ちの質問の表示の権限（`POST /feedback/:id/render-grants`）と、HTMLからの操作の中継（`POST /render-grants/bridge/ready`、`PUT /render-grants/bridge/draft`）。未登録のfileの読み込みの記録と、管理UIでの案内（`POST /render-grants/missing`、通知`render-diagnostics`）。
- 同梱SDK（`window.vde.ready()`、`window.vde.feedback.updateDraft`・`onDraftChanged`）と、MessagePortでの通信（`apps/cli/src/render/bridge-sdk.ts`、`apps/web/src/lib/bridge-host.ts`、`apps/web/src/lib/use-bridge.ts`）。SDKは、interactiveで作った回答待ちの質問を、その版で表示するときだけ入れる。
- 管理UI。表示方法の表示（「scriptを動かす表示」「静的表示」）、再起動の後の再有効化、静的表示への切り替え、HTMLとの通信の状態と「表示し直す」。回答待ちの質問がある文書は、質問を取得するまで表示する版を決めない。
- `docs/agent-usage.md`に、interactiveとSDKの使い方と限界を追記。

レビュー: 1往復目でmust-fix 4件とshould-fix 3件、2往復目でmust-fix 2件とshould-fix 1件、3往復目でshould-fix 1件（判定はマージ可）。すべて修正した。3往復目の指摘への対応は、P7のレビューで確認を受ける。P5の3往復目の指摘への対応も、1往復目で確認を受けた（指摘なし）。以下は1往復目から順に、各往復の内容。

- 許可を外した後に許可し直すと、前の許可で発行したinteractiveの表示が使えるようになった → 許可に世代を持たせ、表示の権限を発行したときの世代に結び付けた。
- 表示の権限を返却・失効した後も、表示中のHTMLから回答案を保存できた（管理UIが、自分のsessionで管理APIを呼んでいた） → HTMLからの操作を、表示の権限とともに中継する専用の経路（`POST /render-grants/bridge/ready`、`PUT /render-grants/bridge/draft`）にし、daemonが権限・session・質問を毎回確かめる。失効の応答の後に通信を終える。
- 質問の表示方法が、質問に固定した表示方法ではなく、いまの文書の表示方法で決まっていた（staticで作った質問に、後から許可したscriptが動いた） → 仕様12.2の`POST /feedback/:id/render-grants`を実装し、版と表示方法をdaemonが質問から決めるようにした。文書の表示の発行では、質問を指定できない。
- 原文の表示からプレビューへ戻ると、新しいiframeとの通信が始まらないのに、通信中と表示していた → iframeを画面から外したら通信を終え、プレビューへ戻ったら新しい表示として発行し直すようにした。
- （should-fix）HTMLから届いた回答案を、JSONへ変換してから検証していて、Dateが文字列になり、undefinedのfieldが消えたまま受け付けていた → 受け取った値のまま検証するようにした。
- （should-fix）仕様12.2の`POST /feedback/:id/render-grants`がなかった → 上記のとおり実装した。
- （should-fix）scriptを動かす表示の説明で「外部へは通信できません」と断定していた → 登録したfileへの読み込みと通信に限ることと、iframe自身の遷移などすべての外部への通信を止めるものではないことを分けて書いた。
- （2往復目）表示の権限が失効した後も、別の画面による回答案の変更を、表示中のHTMLへ知らせていた（HTMLから要求しない限り、通信も終わらなかった） → 知らせる回答案も、表示の権限を確かめる経路で取得し、失効していれば知らせずに通信を終えるようにした。
- （2往復目）入口で権限を確かめた後、保存の順番を待つ間に、権限の返却・scriptの許可の取消・sessionの失効が起きても、HTMLからの回答案を保存していた → 保存のtransactionの中でも権限を確かめ直すようにした。
- （2往復目、should-fix）変換を待つ間に質問が終わっても（中止・確定・削除）、SDKを入れた表示を発行していた → 変換を終えて登録する直前に、質問を確かめ直すようにした。
- （3往復目、should-fix）保存の待ち行列の途中で権限を失効させる試験が、HTMLからの保存が並んだことを固定50msの待ちで推定していた（処理が遅れると、入口での拒否だけでも成功してしまう） → stateの更新の登録を数え、並んだことを確かめてから失効させるようにした（入口で拒否されると、並ばないので試験が終わらずに失敗する）。
- この対応の検証中に、全体の試験の負荷の下で、P3の表示の権限のhookのDOMテスト（固定30msの待ち）が1回失敗した → 起きることを確かめる箇所は、条件が成り立つまで待つ形に直した（P3で確かめた修正を外すと、今も失敗する）。

P6時点の制約:

- interactiveは、任意の敵対的なscriptを安全に動かす仕組みではない。iframe自身の遷移、CPU・memoryの消費までは止めない。
- 管理UIから、staticの文書をinteractiveへ変える操作は、再有効化（希望がinteractiveの文書）だけ。新しくinteractiveにするときは、CLIで指定する。
- Windowsは未検証。e2eはChromiumだけ。

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
| SYS-003 | P5 | PASS | `tests/integration/feedback.test.ts`（再起動後も質問と回答が残る）、`tests/integration/daemon.test.ts` | 再起動の前のtokenが使えないことも確認 |
| SYS-004 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-005 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-006 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-007 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-008 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/secure-dir.test.ts` | Unixで検証。WindowsはDACLを検証しておらず、種別の確認だけ（実機では未検証） |
| SYS-009 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`（commitの途中でのprocessの停止）、`apps/cli/src/persistence/state-store.test.ts` | 子processで、送信と、質問だけの質問の作成を行い、commitのfile操作ごとに、その直前で後始末をせずにkillする。送信はmetadataのrenameとdirectoryのsyncの前後、作成はblobの作成の直後（blobのrenameの後、directoryのsyncの前）も含む。復元後は旧か新の整合したstateで、半分だけ確定した回答や、blobのない質問はない |
| SYS-010 | P1 | PASS | `apps/cli/src/persistence/state-store.test.ts`、`apps/cli/src/daemon/main.test.ts` |  |
| SYS-011 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/persistence/state-store.test.ts` |  |
| SYS-012 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| SYS-013 | P5 | PASS | `tests/integration/feedback.test.ts`（daemonの停止・再起動と待機）、`apps/cli/src/cli/wait-for-answer.test.ts`、`tests/integration/http.test.ts`（SSE）、`apps/web/src/components/workspace.dom.test.tsx` | 待機は最初の期限の範囲で接続し直す。接続にかかる時間も期限に含め、期限は延ばさない。期限の後に起動の待ちが残らず、CLIのprocessが期限の直後に終わる（起動lockを別のprocessが持つ状態で計測）。管理UIは再接続・連番の欠けで一覧と質問を取り直す |
| SYS-014 | P5 | PASS | `tests/integration/feedback.test.ts`（同時の操作） | 回答案の保存・2つの送信・並べ替え・closeを同時に実行し、送信は1回だけ、再起動後も整合。質問の文書のcloseと送信を、順番を入れ替えて同時に実行し、確定か中止（`document_closed`）のどちらか一方だけになる |
| SYS-015 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`（保存容量の上限と固定した版） | 上限は試験用に小さくした（`StateStore`の`blobStoreBytes`） |
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
| DOC-012 | P4 | PASS | `tests/integration/search.test.ts`、`apps/cli/src/search/search-service.test.ts` |  |
| DOC-013 | P2 | PASS | `tests/e2e/workspace.spec.ts` |  |
| DOC-014 | P2 | PASS | `tests/e2e/workspace.spec.ts`、`tests/e2e/viewer.spec.ts` |  |
| DOC-015 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-016 | P5 | PASS | `tests/integration/feedback.test.ts`（close --all）、`tests/integration/watch.test.ts` | 回答の履歴と原本は残り、回答待ちは中止になる |
| SRCH-001 | P4 | PASS | `tests/integration/search.test.ts`、`apps/cli/src/search/search-index.test.ts` |  |
| SRCH-002 | P4 | PASS | `tests/integration/search.test.ts`、`apps/cli/src/search/search-index.test.ts`、`apps/cli/src/search/search-service.test.ts` |  |
| SRCH-003 | P4 | PASS | `apps/cli/src/search/search-index.test.ts`、`apps/cli/src/search/tokenize.test.ts`、`tests/integration/search.test.ts` |  |
| SRCH-004 | P4 | PASS | `apps/cli/src/search/search-index.test.ts`、`tests/integration/search.test.ts` |  |
| SRCH-005 | P4 | PASS | `apps/cli/src/search/search-index.test.ts` |  |
| SRCH-006 | P4 | PASS | `apps/cli/src/search/search-index.test.ts` |  |
| SRCH-007 | P4 | PASS | `tests/integration/search.test.ts` |  |
| SRCH-008 | P4 | PASS | `tests/integration/search.test.ts`、`apps/cli/src/search/search-service.test.ts` |  |
| SRCH-009 | P4 | PASS | `tests/integration/search.test.ts`、`apps/cli/src/documents/cursor.test.ts` |  |
| SRCH-010 | P4 | PASS | `tests/integration/search.test.ts` |  |
| SRCH-011 | P4 | PASS | `tests/integration/search.test.ts`、`packages/document/src/source-lines.test.ts`、`apps/cli/src/search/search-service.test.ts` |  |
| SRCH-012 | P4 | PASS | `tests/integration/search.test.ts` |  |
| SRCH-013 | P4 | PASS | `tests/integration/search.test.ts`、`packages/document/src/analysis.test.ts` |  |
| SRCH-014 | P4 | PASS | `packages/document/src/analysis.test.ts`、`tests/integration/search.test.ts` |  |
| SRCH-015 | P4 | PASS | `apps/cli/src/search/search-service.test.ts`、`tests/integration/search.test.ts` |  |
| SRCH-016 | P4 | PASS | `apps/cli/src/search/search-index.test.ts`、`tests/integration/search.test.ts` |  |
| MD-001 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-002 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-003 | P2 | PASS | `packages/document/tests/react.test.tsx`、`tests/e2e/viewer.spec.ts` |  |
| MD-004 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-005 | P2 | PASS | `packages/document/tests/react.test.tsx` |  |
| MD-006 | P2 | PASS | `packages/document/src/analysis.test.ts`、`apps/cli/src/workers/parse-service.test.ts`、`tests/e2e/workspace.spec.ts` |  |
| SEC-001 | P2 | PASS | `tests/integration/http.test.ts`、`apps/cli/src/server/session-service.test.ts`、`tests/e2e/viewer.spec.ts` |  |
| SEC-002 | P2 | PASS | `tests/integration/http.test.ts` |  |
| SEC-003 | P2 | PASS | `tests/integration/http.test.ts`、`tests/e2e/viewer.spec.ts` |  |
| SEC-004 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`tests/e2e/html.spec.ts`、`tests/integration/preview.test.ts` | scriptを動かす表示のiframeから、管理画面のDOM・sessionStorage・localStorage・cookie・管理APIに触れられない。`allow-same-origin`なし。staticでの検証はP3 |
| SEC-005 | P3 | PASS | `packages/document/src/html-static.test.ts`、`tests/e2e/html.spec.ts` |  |
| SEC-006 | P3 | PASS | `packages/document/src/html-static.test.ts`、`tests/e2e/html.spec.ts` | 外部への要求は、browserのrequestと、記録用のserverの両方で0件を確認 |
| SEC-007 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`tests/integration/preview.test.ts` | `--asset`で登録したJSON（inline scriptの`fetch('./data.json')`）とmodule（inline moduleの相対import）を読める。未登録の相対pathは404。管理APIと外部へのfetchはCSPの`connect-src`で拒否 |
| SEC-008 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`packages/document/src/html-static.test.ts` | popup・上位の画面の移動・formの送信・download・worker（data:・blob:）が起きない。iframe自身の遷移までは止めない（仕様10.1） |
| SEC-009 | P3 | PASS | `packages/document/src/references.test.ts`、`tests/integration/preview.test.ts` |  |
| SEC-010 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-011 | P3 | PASS | `tests/integration/preview.test.ts` | 別のprocessが同時にpathを差し替える攻撃までは防いでいない |
| SEC-012 | P3 | PASS | `packages/document/src/css-transform.test.ts`、`tests/integration/preview.test.ts` | 外部への通信は、応答のpolicy（CSP）でも止める。変換は、それに頼らずに取り除く |
| SEC-013 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`tests/integration/preview.test.ts`、`apps/cli/src/render/render-service.test.ts` | 未登録のmoduleのimportは404で、rootを公開しない。読み込もうとしたfileを表示ごとに記録し、管理UIで`--asset`での登録を案内する |
| SEC-014 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-015 | P3 | PASS | `tests/integration/preview.test.ts`、`apps/cli/src/render/render-service.test.ts`、`apps/web/src/lib/use-render-grant.dom.test.tsx`、`tests/e2e/html.spec.ts` | UIが権限を返す順序についての最後の修正は、commit後の再レビューで指摘なし |
| SEC-016 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-017 | P3 | PASS | `tests/integration/preview.test.ts` |  |
| SEC-018 | P5 | PASS | `tests/integration/feedback.test.ts`（log）、`tests/integration/daemon.test.ts`、`tests/integration/preview.test.ts`、`tests/integration/http.test.ts` | 回答・回答案・質問のtitle・tokenがlogにない |
| SEC-019 | P3 | PASS | `tests/integration/preview.test.ts`、`tests/e2e/html.spec.ts` |  |
| SEC-020 | P3 | PASS | `tests/e2e/release.spec.ts` | 配布物（`apps/cli/dist`）を対象に確認 |
| FB-001 | P5 | PASS | `tests/e2e/feedback.spec.ts`、`apps/web/src/components/feedback-panel.dom.test.tsx` | 回答案の保存の応答と再取得の順番、空の回答の明示 |
| FB-002 | P5 | PASS | `packages/shared/src/feedback.test.ts`、`apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` | Zodのrecordが`__proto__`を黙って捨てるので、JSONの読み込みで拒否する（ADR-0011） |
| FB-003 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`packages/shared/src/feedback.test.ts`、`apps/web/src/lib/bridge-host.test.ts` | 質問定義と回答案がともに最大に近い大きさ（日本語で各60KiB程度）でも、SDKのready（2回）とupdateDraftが成立する。64KiBを超える回答案、Date・undefined・非有限の数などの値は、変換せずに拒否 |
| FB-004 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` |  |
| FB-005 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` |  |
| FB-006 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` |  |
| FB-007 | P6 | PASS | `tests/e2e/interactive.spec.ts` | HTMLのupdateDraft→回答panelでの送信→CLIのwaitで、回答・質問・版・submissionが一致する |
| FB-008 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`apps/web/src/lib/bridge-host.test.ts` | HTMLが横取りしたportから送ったsubmit・ack・cancel・search・read・open・confirmOlderRevisionは`E_METHOD_NOT_ALLOWED`。質問は回答待ちのまま |
| FB-009 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`apps/web/src/lib/bridge-host.test.ts`、`tests/integration/preview.test.ts`、`apps/cli/src/render/render-service.test.ts` | portは表示したiframe（`event.source`で確認）へ1回だけ渡す。管理UIのwindowからの要求、読み直した後の要求には渡さない。古いinstanceのframeは通信を終える。原文の表示へ切り替えたら通信を終え、プレビューへ戻ったら新しい表示として始める。表示の権限の返却・失効の後は、daemonがHTMLからの操作を拒否し、通信を終える |
| FB-010 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`apps/web/src/lib/bridge-host.test.ts` | 形の違うframe、128KiBを超えるframe、1秒に20件を超えるframeで通信を終え、管理UIからの回答とdaemonは動き続ける |
| FB-011 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`apps/web/src/lib/bridge-host.test.ts`、`apps/cli/src/feedback/service.test.ts` | 別の画面の更新をHTMLが`onDraftChanged`で受け取った後でも、古い`baseDraftVersion`でのupdateDraftは`E_DRAFT_CONFLICT`で、上書きしない。SDKは版を読み替えない |
| FB-012 | P5 | PASS | `apps/cli/src/feedback/service.test.ts` |  |
| FB-013 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`apps/cli/src/server/http/feedback-http.test.ts` | commitの途中で管理APIの接続を切り、同じ送信IDで再送しても1回だけ確定する。保存できなかった送信には成功を返さず、回答待ちのまま |
| FB-014 | P5 | PASS | `apps/cli/src/feedback/service.test.ts` |  |
| FB-015 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`tests/e2e/feedback.spec.ts`、`apps/web/src/components/workspace.dom.test.tsx`、`apps/cli/src/render/render-service.test.ts`、`tests/integration/preview.test.ts` | 質問の間にHTMLとCSSが更新されても、質問の版（scriptとCSSを含む）を表示し続け、新しい版の警告を出す。SDKに旧版の確認はない。質問の表示方法は質問に固定し、staticで作った質問は、後から許可してもscriptを動かさない |
| FB-016 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`apps/cli/src/feedback/service.test.ts`、`apps/web/src/components/feedback-panel.dom.test.tsx` | 旧版の確認は回答panelだけで行い、確認した版を送る。確認後に版が変われば確認し直し |
| FB-017 | P5 | PASS | `tests/integration/feedback.test.ts`、`apps/cli/src/feedback/service.test.ts` | browserを閉じる操作は、管理UIのsessionの終了で確認 |
| FB-018 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts`、`tests/e2e/feedback.spec.ts` |  |
| FB-019 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts`、`tests/e2e/feedback.spec.ts` |  |
| FB-020 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` |  |
| FB-021 | P5 | PASS | `apps/cli/src/feedback/service.test.ts`、`tests/integration/feedback.test.ts` |  |
| FB-022 | P6 | PASS | `tests/e2e/interactive.spec.ts`、`tests/integration/preview.test.ts`、`apps/cli/src/documents/service-html-mode.test.ts`、`apps/cli/src/render/render-service.test.ts` | 再起動の後、確定・回答待ちの内容は残る。前の画面のportからは回答案を変えられない。scriptの実行は、管理UIで許可し直すまで静的表示。許可し直しても、前の許可で発行した表示は戻らない |
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

- 次はP7（UI仕上げ（`Cmd/Ctrl+K`の検索UIを含む）、負荷、cross-platform、pack-install、README、CI定義、全体DoD）。interactiveとSDKはADR-0012、HTMLの変換は`packages/document/src/html-static.ts`、SDKの本体は`apps/cli/src/render/bridge-sdk.ts`、本体側の通信は`apps/web/src/lib/bridge-host.ts`と`use-bridge.ts`。質問と回答は`apps/cli/src/feedback/service.ts`、回答panelは`apps/web/src/components/feedback-panel.tsx`。
- stateの形式に質問と回答（`feedbackRequests`）を足した。P4までの開発用state（`.dev-home`）は読めないので、消して作り直す。
- 管理HTTPは`apps/cli/src/server/http/management.ts`、表示用のlistenerは`apps/cli/src/server/http/preview.ts`、UIは`apps/web/src/`、Markdownの描画は`packages/document/src/react.tsx`、HTMLの静的変換は`packages/document/src/html-static.ts`。
- stateの形式に項目を足した（版ごとのassetと文書の位置、文書ごとのassets-root）。P2までの開発用state（`.dev-home`）は読めないので、消して作り直す。
- 画面部品のhookは、happy-domの上で実際のReact DOMを動かしてテストできる（file先頭に`// @vitest-environment happy-dom`）。
- 未解決の不具合: なし。
- 未実行のtest: 上の表で「未着手」のもの。e2eのFirefox／WebKit。
- 配布物はruntime依存を持たない方針（ADR-0001）。外部packageを足したら`apps/cli/tsdown.config.ts`の`deps.onlyBundle`へ追加する。
- stdinを入力として扱うのは、shellのpipeかredirectのときだけ（ADR-0004）。
- UIはTailwind CSS、shadcn/ui、Base UIで作る（利用者の指定、ADR-0006）。部品は`pnpm dlx shadcn@4.21.1 add <name>`で`apps/web/src/components/ui/`へ追加する。
- 結合テストは`tests/integration/harness.ts`の`createTestHome()`、e2eは`tests/e2e/harness.ts`の`createE2eHome()`で、試験専用のstate rootとruntimeを使う。browserは`BROWSER`環境変数で差し替えられる。
- e2eは配布物（`apps/cli/dist`）を試す。先に`pnpm build`が必要。
