# ADR-0017: PCの固定URLと、Tailscale経由のスマホ閲覧

PCで開いた文書を本人のスマホで読み、PCで許可したHTMLデモをスマホで操作できるようにする。PCとスマホのどちらのブックマークも、daemonの再起動をまたいで使えるようにする。

## 決定

### 待受とURL

- 待受は4つで、すべて`127.0.0.1`にbindする。PC管理43180、PCプレビュー43181、スマホ閲覧43182、スマホのプレビュー43183を既定とする。
- 設定は状態の保存先直下の任意の`listeners.json`一つ（`managementPort`・`previewPort`・`mobile`）。起動時に一度だけ読み、変更は再起動で反映する。`vo serve --port`・`--preview-port`はその起動だけの上書きで、設定に書き戻さない。
- ファイルがない場合は既定値を使う。読めない・JSONでない・PC部分が不正な場合は起動エラー（`E_DAEMON_START_FAILED`、`details.reason=listener-config`）。参照先のないsymlinkも不正として扱う。
- 待受の失敗は、用途・ポート・OSのエラーを付けた`E_DAEMON_START_FAILED`にする。先に開いた待受・lock・pointerは既存の終了処理で片付ける。空き番号への自動退避はしない。
- テストと開発では、絶対パスの`VDE_OPEN_HOME`があるときに限り、`VDE_OPEN_TEST_EPHEMERAL_PORTS=1`で未指定のポートをOSの割り当てにする。この場合、スマホの設定番号は公開HTTPSの番号としてだけ使い、ローカルの2ソケットはOSの割り当てにして、`daemon.diagnostics.mobileBoundPorts`だけで知らせる。
- PCの画面は、通知の`hello`と`status`のdaemonIdで起動世代を知る。表示の権限のキーに世代を含め、再起動すると古いiframe・画像・回答のMessagePortをすぐに外して取り直す。一覧の取得が再起動をまたいでも、通知が決めた世代を戻さない。

### スマホの閲覧

- `mobile`（`host`・`login`必須、`uiPort`・`previewPort`）があるときだけ有効にする。
  - `host`は小文字の完全なDNS名に正規化し、スキーム・ポート・パス・ユーザー情報を受け付けない。
  - `login`はASCIIで、カンマ・空白を含まない。
  - ポートは互いにもPCとも別の番号で、443は使えない。ブラウザが`Host`・`Origin`から既定のポートを省き、完全一致が成り立たないためである。
  - `mobile`部分の不正やスマホのポート競合ではPCを止めない。`daemon status`の`mobile`に`error`と理由を出す（停止中は`null`）。
- スマホの2つの待受は、両方を開けたときだけ配信し、片方の失敗で両方を閉じる。
- Tailscale Serveは`r.Out.Host = r.In.Host`で外部のHostを保つ（1.104.7、`ipn/ipnlocal/serve.go`）。両方の待受で、全ルート・資産・SSE・HEADについて次を求める。
  - 設定の`host:port`と一致する`Host`がちょうど1つあること
  - 設定の`login`と一致する`Tailscale-User-Login`がちょうど1つあること

  UIは403、プレビューは未知のgrantと同じ404で拒否する。
- スマホのAPIは`/_/mobile/v1`の一覧・Markdown本文・表示の権限の発行／返却／確認・linkの解決・通知だけとする。
  - 応答は項目を列挙したDTOで返し、パス・repository・key・質問IDを含めない。
  - errorは固定の文言とし、detailsを返さない。
  - 変更系はOriginが一致し、`application/json`の正しいJSONのときだけ受け付ける。
- cursorは用途名を分けて既存のcodecで包む。一覧のcursorはcatalogVersionに、本文のcursorは文書・版・表示世代に結び付ける。
- 表示の権限に発行先（`pc`・`mobile`）を持たせ、上限64件を発行先ごとに数える。別の発行先のキーは見えないものとし、照会しても失効させない。
- スマホの権限は、開いていること・openEpoch・許可の世代に加え、発行時の版と表示世代が現在と一致することを、配信・確認・link解決で毎回求める。発行は非同期処理の前後で照合する。
- 表示世代（`<openEpoch>.<世代>`）は、版か実効的なスクリプト許可が変わるたびに進む。daemonの通知のたびに全文書を照合するため、切断中にStatic→Interactive→Staticと変わっても前の値に戻らない。
- linkは既に開いている文書のIDだけに解決する。PCでの登録・確認token・focusは行わない。参照先の解決は`openLinked`と共有する。
- スマホの画面は`mobile.html`で、PCの`index.html`は返さない。未ビルド時は専用の503を返す。
  - スマホは一覧・閲覧・デモ操作だけを行い、選択をPCに伝えない。
  - Interactiveは`sandbox="allow-scripts"`で動かし、回答SDKを渡さない。
  - 切断・非表示・再検証中は、スクリプトを動かすInteractiveのiframeへの入力を止める。Staticのiframeはリンク中継しか動かないので止めずにスクロールでき、文書リンクのタップは再検証が終わるまで無視する。
  - 通知を35秒（heartbeat 2周期＋5秒）受け取らなければ切断として扱い、再接続して再検証する。
  - 一覧をホームとし、本文からは管理画面と同じドロワー部品で開いている文書を切り替える（一覧へ戻るボタンとは別）。画像の表示部分（`ImageCanvas`）は管理画面と共有する。
  - 再接続・`pageshow`・可視化のときに一覧と権限を確かめ直し、同じ版・表示世代・有効な権限のときだけ同じiframeで再開する。
  - 失効・close・daemonの交代では、新しい表示を待たずに古いiframeを外す。
  - 同じモードで版だけが変わったときは、新しい表示ができるまで古い表示を残す。

### 設定コマンド（後から追加）

- 手動でJSONを書かずに済むよう、`vo mobile enable` / `disable` / `status`を追加した。当初は設定編集CLIとCLIからのServe操作を対象外にしていたが、利用者の求めで変更した。
- `enable`は`tailscale status --json`から完全なDNS名とログイン名を読み、`listeners.json`の`mobile`に書く。他のキーは残し、0600で原子的に置き換える。続けてdaemonを再起動し、スマホの閲覧が`ready`になってからServeの2件を追加する。
- tailscaledが動いていない場合とタグ付き端末の場合は拒否する。タグ付き端末にはServeが本人のヘッダーを付けないためである。
- Serveは、このreaderの転送（`127.0.0.1`の同じポートへの1件だけで、Funnelなし）だけを自分のものとして扱う。追加の前に状態を確かめ、どちらかのポートが別の用途なら何も変えずに止める。2件目の追加に失敗したら、その回に追加した1件目を外す。`--no-serve`で設定とdaemonの再起動だけにできる。
- `disable`は自分の転送だけを外し、`mobile`を取り除く（ファイルが空になれば削除する）。動いていたdaemonは再起動する。
- QRコード（後から追加）: 端末で実行した`enable`と`status`は、Serveの2件が自分の転送のときだけURLのQRコードも出す（`--json`・パイプでは出さない）。daemonの起動・再起動では出さない。URLは固定で、一度ブックマークすれば足りるためである。管理画面の`status`は、スマホの閲覧が`ready`のときだけ`phoneUrl`を返し、文書のヘッダーにその文書を開くQRコード（`?document=<ID>`）のボタンを出す。URLに秘密は含まれず、本人の照合はServeが行う。端末のQRは、設定ではなく稼働中のreader（daemonが正規化したホスト名とUI・プレビューの両ポート）について、Serveの2件が自分の転送のときだけ出す。
- 引っ張ってリロード（後から追加）: ホーム画面から開いたとき（`display-mode: standalone`または`navigator.standalone`）だけ、画面の上端から72px以上下に引っ張って離すと再読み込みする。ブラウザのタブでは、ブラウザ自身の機能に任せる。iframeの中のタッチは親に届かないため、HTMLではヘッダーから引っ張る。
- コマンドは`tailscale`（PATH、またはmacOSアプリ同梱のCLI）を実行する。`VDE_OPEN_TAILSCALE`（絶対パス）で明示できる。daemon自身はTailscaleを呼ばない。

## 既存のADRへの変更

- ADR-0008・0014: 表示の権限の上限64件は、PCとスマホそれぞれの枠に変える。権限に発行先と（スマホのみ）表示世代を加える。
- ADR-0014: PCの管理は引き続き認証なし。スマホの入口だけに、Serveの本人照合とHost照合を加える。
- PCの管理・プレビューのポートは、OSの割り当てから固定の既定値に変える（変更は設定ファイルで行う）。

## 採らなかった案

- PCの管理画面をそのまま転送する案。文書を閉じる・回答・許可などの操作もスマホに届いてしまう。
- 同じHTTPSポートのパスで画面とデモを分ける案。同一originになり、HTML隔離が崩れる。
- スマホ用に文書を複製して同期する案。open・版・許可を二重に追跡することになる。
- 環境変数での公開切り替え。daemonからServe設定を操作すること（Serveの追加・削除は利用者が実行する`vo mobile`コマンドだけが行う）。

## 検証

- 自動試験:
  - `pnpm check`
  - `tests/integration/mobile-reader.test.ts`（本人・Host・発行先・表示世代・ページング・link・通知・待受失敗）
  - `tests/e2e/mobile-reader.spec.ts`（ローカルのHTTPS転送でChromium・Firefox・WebKit）
  - `tests/e2e/restart.spec.ts`（PCの再起動復帰）
  - `pnpm test:pack`（両画面の同梱）
- 実機（iPhone／Android、セルラー回線、実際のServe）での確認は、導入時に別途記録する。
