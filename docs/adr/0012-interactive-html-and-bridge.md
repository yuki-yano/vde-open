# ADR-0012: scriptを動かすHTMLは明示的な許可でだけ表示し、HTMLからは回答案だけを受け取る

状態: 採用（P6）

## 背景

仕様10.2・11.6〜11.8は、利用者やAgentが用意したHTMLのscriptを、明示的に許可したときだけ動かし（interactive）、そのHTMLから回答案を受け取れることを求める。HTMLのscriptは信頼できないので、管理画面・管理API・fileへ触れさせず、回答の確定（送信）や、旧版への回答の確認をHTMLからできないようにする。

## 決定

- 表示方法は文書ごとの希望（`static`／`interactive`）としてstateに残す。scriptの実行の許可は、daemonのmemoryだけに持ち、文書を閉じた回数（open epoch）と、許可の世代に結び付ける。世代は許可するたびに新しくし、interactiveの表示の権限は発行したときの世代に結び付ける（外した後に許可し直しても、前の許可で発行した表示は戻らない。許可済みのまま同じ指定で開き直したときは、世代を変えない）。許可は、CLIの`--html-mode interactive`（`open`、`ask --view`）か、管理UIの確認つきの操作（`POST /documents/:id/html-mode`、`confirmed: true`）でだけ付ける。同じfileの開き直しと更新では保ち、`--html-mode static`、閉じる操作、stdinの同じkeyの更新（別の内容への置き換え）、daemonの再起動では外す。再起動の後は、希望がinteractiveの文書に「Enable Interactive view」を出し、静的表示にする。
- interactiveの変換は、staticと同じparse5の変換で、scriptとevent属性だけを残す。script fileは登録済みのものだけを読み込み、未登録・外部のものは要素ごと外す。埋め込み、base、自動の遷移、先読み、formの送信先、popup・download・ping、noscript、inlineのSVG・MathMLは外す。
- interactiveの文書は、CSPの`script-src 'unsafe-inline' GRANT_BASE`、`connect-src GRANT_BASE`、`sandbox allow-scripts`で配信し、iframeも`sandbox="allow-scripts"`にする。`allow-same-origin`、`unsafe-eval`、workerは許可せず、scriptの読み込みとfetchなどの通信先は、その表示に登録したfileだけにする（iframe自身の遷移は止めない）。scriptが実行時に読み込もうとした未登録のfileは404にし、表示ごとに記録して（32件まで）、`render-diagnostics`の通知（pathは含めない）で管理UIへ知らせる。管理UIは`POST /render-grants/missing`で取得し、`--asset`での登録を案内する。
- 回答待ちの質問の表示は、`POST /feedback/:id/render-grants`（仕様12.2）で発行する。版と表示方法はdaemonが質問から決める。表示方法は、質問を作ったときの表示方法（`renderMode`）が`interactive`で、いまもscriptの実行を許可しているときだけinteractive。staticで作った質問は、後から文書のscriptを許可しても、回答が終わるまで静的表示にする。文書の表示（`POST /documents/:id/render-grants`）では、質問を指定できない。
- 同梱SDKは、interactiveで作った（`renderMode: interactive`）回答待ちの質問を、その質問の版で表示するときだけ、headの最初のscriptとして入れる。変換を終えて表示の権限を登録する直前にも、質問が回答待ちで、版と表示方法が変わっていないかを確かめる。表示ごとの設定（識別子と、通信してよい親のorigin）は、配信のときに入れる（変換結果のcacheは、表示方法とSDKの有無で分ける）。SDKが提供するのは`window.vde.ready()`と`window.vde.feedback`（`updateDraft`、`onDraftChanged`）だけ。
- 通信の開始は、SDKが親へ識別子を送り、管理UIが`event.source`が表示中のiframeであることと識別子を確かめて、MessagePortを1回だけ渡す。iframeの読み直し・遷移（2回目以降の`load`）、iframeを画面から外したとき（原文の表示へ切り替えたときなど）、表示の差し替え、表示の権限の失効、質問の終わりで、portを閉じる。読み直した後の要求には、portを渡さない。原文からプレビューへ戻ったときは、新しい表示（新しい識別子）として発行し直す。
- HTMLからの操作は、管理UIが表示の権限（grant）とともにdaemonへ中継する（`POST /render-grants/bridge/ready`、`PUT /render-grants/bridge/draft`）。daemonは、権限が有効で、そのsessionのもので、SDKを入れた表示で、質問が回答待ちかを毎回確かめ、満たさなければ`E_RENDER_GRANT_INVALID`にする。管理UIは、その応答を返した後で通信を終える。 回答案の保存では、保存のtransactionの中でも確かめ直す（保存の順番を待つ間の、権限の返却・scriptの許可の取消・sessionの失効を反映する）。別の画面による回答案の変更をHTMLへ知らせるときも、同じ経路で回答案を取得し、権限が失効していれば知らせずに通信を終える。
- 管理UIは、HTMLから届くframeを、大きさ（128KiB）、件数（1秒に20件）、順番（sequenceが増え続ける）、識別子、protocolVersion、payloadの形で検証し、違反したら通信を終える。回答案は、受け取った値のまま、field名ごとの文字列・有限の数・真偽値・文字列の配列だけかを検証する（Date・undefined・非有限の数などを、JSONへの変換で型を変えたり落としたりして受け付けない）。操作は`ready`と`updateDraft`だけで、それ以外（送信、取得済みの印、中止、検索、読み取り、旧版の確認など）は`E_METHOD_NOT_ALLOWED`で拒否する。`updateDraft`の`baseDraftVersion`は、HTMLが渡した値をそのまま回答案の保存の前提に使う（読み替えない）。応答は256KiBまで。
- 回答の確定は、P5と同じく、管理UIの回答panelの「Send answers to the agent」だけで行う。旧版への回答の確認も、回答panelだけで行う。
- 回答待ちの質問がある文書は、質問を取得するまで表示する版を決めない（質問の版と違う版や、SDKのない表示を一度出さない）。

## 影響

- interactiveは、任意の敵対的なscriptを安全に動かす仕組みではない。iframe自身の遷移や、CPU・memoryの消費までは止めない（仕様10.1）。
- daemonの再起動の後は、interactiveの文書を一度静的表示にし、利用者が許可し直す必要がある。
- HTMLの中のscriptは、SDKへ渡したportを横取りできる。横取りしたportでも、行えるのは回答案の取得と置き換えだけで、確定はできない。

## DoD

機能完了条件:

- [x] `--html-mode interactive`（`open`、`ask --view`）と、管理UIでの確認つきの有効化・静的表示への切り替えが動く。再起動・閉じる操作・stdinの更新で許可が外れる。
- [x] interactiveの変換・CSP・sandboxで配信し、未登録のfileの読み込みを不足として示す。
- [x] SDKを、interactiveで作った回答待ちの質問の表示にだけ入れ、MessagePortで回答案の取得・置き換え・変更の通知ができる。

テスト完了条件:

- [x] P6担当の受け入れID（SEC-004・007・008・013、FB-003・007・008・009・010・011・015・016・022）を、unit・結合・e2eで検証して、すべて成功する。
- [x] `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:pack`、`pnpm test:e2e`がexit 0。

運用反映条件:

- [x] `docs/agent-usage.md`に、interactiveとSDKの使い方と限界を書く。
- [x] `docs/implementation-status.md`に、P6の記録と受け入れIDの状態を書く。
- [x] 配布物（`pnpm test:pack`）で、導入先だけでinteractiveの配信とSDKの注入が動く。
