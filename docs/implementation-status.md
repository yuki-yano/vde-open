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
| P2 | 未着手 | 文書追加とatomic saveが実UIへ反映。raw HTMLが動かない。未認証では管理APIを読めない |
| P3 | 未着手 | security fixture、path traversal、他文書/API遮断 |
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
| CLI-009 | P2 | 未着手 |  |  |
| CLI-010 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-011 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-012 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| CLI-013 | P7 | 未着手 |  |  |
| CLI-014 | P7 | 未着手 |  |  |
| CLI-015 | P7 | 未着手 |  |  |
| CLI-016 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| SYS-001 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| SYS-002 | P2 | 未着手 |  |  |
| SYS-003 | P5 | 未着手 |  | P1で部分検証済み（`tests/integration/daemon.test.ts`: 再起動後に文書IDと順序を復元）。watch suppressionはP2、質問・回答はP5で追加 |
| SYS-004 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-005 | P1 | PASS | `apps/cli/src/server/ipc.test.ts` |  |
| SYS-006 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-007 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/lock.test.ts` |  |
| SYS-008 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/daemon/secure-dir.test.ts` | Unixで検証。WindowsはDACLを検証しておらず、種別の確認だけ（実機では未検証） |
| SYS-009 | P5 | 未着手 |  | P1で部分検証済み（`apps/cli/src/persistence/state-store.test.ts`: commit途中のどのfile操作で止まっても、復元後は旧か新の整合したstate）。P5で回答のsubmitを含むcaseを足して完了 |
| SYS-010 | P1 | PASS | `apps/cli/src/persistence/state-store.test.ts`、`apps/cli/src/daemon/main.test.ts` |  |
| SYS-011 | P1 | PASS | `tests/integration/daemon.test.ts`、`apps/cli/src/persistence/state-store.test.ts` |  |
| SYS-012 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| SYS-013 | P5 | 未着手 |  | SSEはP2、waitはP5 |
| SYS-014 | P5 | 未着手 |  |  |
| SYS-015 | P5 | 未着手 |  |  |
| SYS-016 | P1 | PASS | `tests/integration/daemon.test.ts` |  |
| DOC-001 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-002 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-003 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-004 | P2 | 未着手 |  |  |
| DOC-005 | P2 | 未着手 |  |  |
| DOC-006 | P2 | 未着手 |  |  |
| DOC-007 | P2 | 未着手 |  |  |
| DOC-008 | P2 | 未着手 |  |  |
| DOC-009 | P2 | 未着手 |  |  |
| DOC-010 | P2 | 未着手 |  |  |
| DOC-011 | P3 | 未着手 |  |  |
| DOC-012 | P4 | 未着手 |  |  |
| DOC-013 | P2 | 未着手 |  |  |
| DOC-014 | P2 | 未着手 |  |  |
| DOC-015 | P1 | PASS | `tests/integration/documents.test.ts` |  |
| DOC-016 | P5 | 未着手 |  | P1で部分検証済み（`tests/integration/documents.test.ts`: close --all）。watch ruleはP2、回答履歴はP5 |
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
| MD-001 | P2 | 未着手 |  |  |
| MD-002 | P2 | 未着手 |  |  |
| MD-003 | P2 | 未着手 |  |  |
| MD-004 | P2 | 未着手 |  |  |
| MD-005 | P2 | 未着手 |  |  |
| MD-006 | P2 | 未着手 |  |  |
| SEC-001 | P2 | 未着手 |  |  |
| SEC-002 | P2 | 未着手 |  |  |
| SEC-003 | P2 | 未着手 |  |  |
| SEC-004 | P6 | 未着手 |  | iframe内でscriptを動かす検証が必要。P3でsandbox属性とCSPを部分検証 |
| SEC-005 | P3 | 未着手 |  |  |
| SEC-006 | P3 | 未着手 |  |  |
| SEC-007 | P6 | 未着手 |  | interactiveが必要なためP6 |
| SEC-008 | P6 | 未着手 |  | interactiveが必要なためP6 |
| SEC-009 | P3 | 未着手 |  |  |
| SEC-010 | P3 | 未着手 |  |  |
| SEC-011 | P3 | 未着手 |  |  |
| SEC-012 | P3 | 未着手 |  |  |
| SEC-013 | P6 | 未着手 |  | module importの実行にはinteractiveが必要。P3でmanifest外pathの404を部分検証 |
| SEC-014 | P3 | 未着手 |  |  |
| SEC-015 | P3 | 未着手 |  |  |
| SEC-016 | P3 | 未着手 |  |  |
| SEC-017 | P3 | 未着手 |  |  |
| SEC-018 | P5 | 未着手 |  | P1で部分検証済み（`tests/integration/daemon.test.ts`: logに本文・title・path・keyがない）。回答とdraftを含む操作はP5 |
| SEC-019 | P3 | 未着手 |  |  |
| SEC-020 | P3 | 未着手 |  |  |
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

- P2のUIは、利用者の指定でTailwind CSS、shadcn/ui、Base UIを使う。仕様2.1のUIの行も同じ内容へ書き換え済み。

- 次はP2。daemonのmethod表は`apps/cli/src/daemon/main.ts`、文書の操作は`apps/cli/src/documents/service.ts`、CLIのcommandは`apps/cli/src/cli/run.ts`。
- 未解決の不具合: なし。
- 未実行のtest: 上の表で「未着手」のもの。
- 配布物はruntime依存を持たない方針（ADR-0001）。外部packageを足したら`apps/cli/tsdown.config.ts`の`deps.onlyBundle`へ追加する。
- stdinを入力として扱うのは、shellのpipeかredirectのときだけ（ADR-0004）。
- 結合テストは`tests/integration/harness.ts`の`createTestHome()`で、試験専用のstate rootとruntimeを使う。
