# ADR-0014: 管理画面は認証なしでURLから開く

同じ端末の別のbrowserやtabへURLを渡して、そのまま文書を表示できるようにする。管理画面と管理APIの認証を撤去し、CLIから取得したURLと文書を選択したURLを繰り返し利用できるものにする。一回限りのticket、session token、sessionStorageへの保存、認証の期限、sessionの破棄APIは設けない。

管理listenerと表示listenerは引き続き127.0.0.1だけで待ち受ける。Host・Origin・Sec-Fetch-Siteの確認、状態変更時のOriginとJSONの検証、文書のsandbox・CSPは維持する。外部のWebサイトと文書内のscriptからの管理操作を遮断するが、同じ端末から接続するprocessや別のOS userの本人確認は行わない。CLIとdaemonのIPCの鍵による相互確認は、今回の対象に含めない。

表示用の権限は文書・版・表示方法・閉じた回数・scriptの許可の世代に結び付け、閉じる操作・許可の取消・返却・daemonの再起動で失効させる。sessionには結び付けない。保持はdaemon全体で64件までで、超過した分は古いものから失効する。HTMLからの回答案は、有効な表示の権限と回答待ちの質問を、保存のtransaction内でも確認する。通知は認証なしで購読でき、書き込みの停止期限とdaemonの停止で接続を終了する。

ADR-0008とADR-0012のsessionへの結び付けと、ADR-0008のsessionごとの保持上限を、この決定で置き換える。旧認証方式との互換処理や設定による切り替えは用意しない。

## DoD

### 機能完了条件

- [x] 管理画面とAPIをトークンなしで利用でき、一回限りの認証URLと開き直し画面が存在しない。
- [x] `vo ui --print-url`が再利用できるURLを返し、`--json`と併用できる。
- [x] 文書・版の表示権限、HTMLの隔離、回答確定と競合検出が維持される。

### テスト完了条件

- [x] format・lint・typecheckとunit・結合テストが成功する。
- [x] Chromium・Firefox・WebKitで、認証なしの直接表示・独立したbrowser contextでの同一URLの利用・再読み込みが成功する。
- [x] 表示権限の返却・上限・文書close・再起動と、HTMLからの管理API遮断・回答案の保存時の再検証が成功する。

### 運用反映条件

- [x] 配布用buildが成功し、README・構成・セキュリティモデルに現在の仕様が記載される。
- [x] linked CLIの稼働中daemonを更新し、認証なしで文書一覧を取得できることを確認する。

検証: `pnpm check`（unit・結合902件）、配布用build、pack smoke、関連E2E110件、同一URLを別browserで開く試験3件が成功。ChromiumからFirefoxへ同じ文書・見出しのURLを渡して表示できる。linked CLIのdaemonを再起動し、開いていた8文書と並び順を維持して、認証なしの管理APIがHTTP 200を返すことを確認した。
