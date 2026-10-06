# ADR-0013: MarkdownのPDF出力は、利用者の環境のChrome・Edgeをdaemonから印刷に使う

状態: 採用（2026-10-06）

## 背景

管理画面で開いているMarkdownを、白背景の資料としてPDFへ出力できるようにする。要件は次のとおり。

- 印刷のdialogを挟まず、ボタンからPDFを直接保存する。
- 見た目を保証するbrowserはChrome・Edgeとする。
- 余白に文書名とpage番号を入れる。
- 管理画面の配色（Catppuccin）に合わせる必要はない。

候補として、ブラウザの印刷（`window.print()`）、daemonからのheadless Chromium、JSのPDF生成library（pdf-lib・pdfmake・React PDFなど）、外部command（pandocなど）を比べた。印刷のdialogは直接の保存に合わない。JSのlibraryは組版を作り直すことになり、日本語fontの同梱で配布が数MB〜十数MB増える。pandocは描画系が別で、導入も必要になる。

## 決定

- daemonが、利用者の環境に入っているGoogle Chrome・Microsoft Edge（131以降。page margin boxの対応から）をheadlessで起動して印刷する。Chromiumは同梱もdownloadもしない。探す場所はOSごとの通常の導入先（Linuxは`PATH`）で、`VDE_OPEN_BROWSER`（絶対path）で明示できる。出力のたびに探すので、daemonの起動後に入れたbrowserも使える。
- browserは`--remote-debugging-pipe`で操作し（portを開かない）、出力ごとの一時profile（`--user-data-dir`）で動かす。`Browser.getVersion`で版を確かめ、`Page.printToPDF`（`preferCSSPageSize`、背景あり、しおりとタグ付きPDF）で印刷し、`Browser.close`で閉じる。読み込みの完了は、`Page.navigate`が返す`loaderId`と一致する`load`の`Page.lifecycleEvent`で待つ（targetが最初に開くabout:blankの読み込みと取り違えない）。browserからのmessageは16MiBまでとし、読めないmessageはその出力だけを失敗にする（daemonは止めない）。`--print-to-pdf`は使わない。profileを指定すると書き出した後も終了せず、指定しないと既定の一時profileという文書化されていない挙動に頼るため。sandboxは外さない。
- 印刷用の文書は`packages/document/src/print.ts`で作る。表示と同じ解析の設定で、TanStack MarkdownのHTMLの描画器を使う（daemonにReactを入れない）。linkと画像の判定は、表示の`MarkdownView`と`rendering-rules.ts`の同じ関数で行う。画像は登録済みのものだけを、daemonがpageを書くときにdata URLで埋める（画像のbyteはworkerを通さない）。pageにはCSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`を付ける。
- 印刷用の文書は、解析とは別のworkerで作る（時間上限は10秒）。同じworkerでは、長い印刷の間に解析の2秒の時間上限が切れ、workerごと作り直されて両方が失敗するため。
- 紙の配色はCatppuccinを使わない（ADR-0006の配色の例外）。白背景で、構文の色はコードの背景（#f6f8fa）に対して4.5:1以上、キーワードは太字にする。書体は環境のもの（macOSはSan Franciscoとヒラギノ角ゴシック、WindowsはSegoe UIと游ゴシック、LinuxはNoto Sans CJK）で、fontは埋め込み用に同梱しない。文書の言語（`lang`）は、本文に仮名があれば`ja`、ハングルがあれば`ko`とし、どちらもなければ付けない（daemonのlocaleは文書の言語を表さないため）。A4、余白20mmで、`@top-left`に文書名（60字まで）、`@bottom-center`に「n / N」を出す。文書名はCSSの文字列として英数字と空白以外を16進でescapeする（`string-set`はChromeが対応していない）。
- APIは`POST /_/api/v1/documents/:id/pdf`（bodyは`{ "revision": "rev_…" }`）。成功はPDFそのもの（`application/pdf`、`Content-Disposition: attachment`）、失敗は既存のJSONのenvelope。file名は管理画面が`pdfFileName`（文書のfile名の拡張子を`.pdf`に、stdinの文書は文書名。UTF-8で200byteまで）で付ける。
- 出力は1件ずつ行い、待ちは4件まで（中断された要求は数えない）。1件の時間上限は60秒。時間切れ、requestの中断（管理画面を閉じた）、daemonの停止で、browserを補助processごと止め（POSIXはprocess group、Windowsは`taskkill /T /F`）、一時directoryを消す。消せなかったときは結果を変えずにlogへ残し、1時間より古い一時directory（daemonが強制終了された場合）は次のdaemonの起動時に消す（symlinkでない実directoryで、POSIXではその利用者が所有するものだけ。共有の`/tmp`を考えるため）。
- pageは画像を含めて256MiBまで。画像は参照ごとに書き込むので、同じ画像を何度も参照する文書でdiskを埋めないため。超えると`E_LIMIT_EXCEEDED`（`details.reason`は`page-size`。待ちの上限は`waiting`）。
- 管理画面は、出力の状態を文書ごとに表示の外で持つ。別の文書へ切り替えても出力を続けて保存し、失敗はその文書に戻ったときも表示する。同じ文書の出力中は、もう一度押せない。
- エラーコードを2つ足した。`E_BROWSER_NOT_FOUND`（終了コード3。browserがない、`VDE_OPEN_BROWSER`が使えない、131より古い）と`E_EXPORT_FAILED`（終了コード9。`details.reason`は`spawn`・`exit`・`timeout`・`output`・`load`・`protocol`）。

## 影響

- PDF出力には、Chrome・Edge（131以降）の導入が必要になる。ない環境では、案内のエラーを出す。
- 書体を同梱しないため、OSごとにPDFの字面が変わる。
- daemonが外部のprocessを起動する経路が増える。起動するのは人が「Export PDF」を押したときだけで、印刷するpageは何も読み込まない。browser自身の通信は、background networkingなどを無効にして起動するが、保証の外に置く（`docs/security-model.md`）。
- calloutは、現在の解析の設定（表示と同じ）では生成されないため、印刷でも普通の引用として出る。
- CLIからの出力（`vo export`など）は、このADRの範囲外。daemonの経路はそのまま使える。
- Windowsでは、実際のbrowserでの印刷を検証しないまま提供する（WindowsのCIはe2eを実行しない）。READMEの検証範囲に未検証と書き、印刷用の文書の描画までの経路はpack smokeで確かめる。

## DoD

機能完了条件:

- [x] Markdown文書の「Export PDF」で、印刷のdialogなしに、表示中の版のPDFが`<文書名>.pdf`で保存される。
- [x] PDFは白背景のA4で、全pageのheaderに文書名、footerに「n / N」が出て、見出しのしおりが付く。
- [x] 登録済みの画像はPDFに入り、未登録の画像は`[image: …]`、外部の画像は代替textになる。ローカル文書へのlinkは文字だけになる。
- [x] Chrome・Edgeが見つからない、131より古い、`VDE_OPEN_BROWSER`が使えないときは`E_BROWSER_NOT_FOUND`になり、管理画面に案内が出る。
- [x] HTML文書では、ボタンが出ず、APIは`E_UNSUPPORTED_FORMAT`を返す。

テスト完了条件:

- [x] unit: 印刷用の文書（CSP、文書名のescapeと切り詰め、画像とlinkの判定、表示との一致、敵対的な入力、短いコードの改ページ、`lang`）、browserの探索（OSごと、`VDE_OPEN_BROWSER`）、file名、PDFの出力（偽のbrowserでの成功・起動の失敗・古い版・時間切れ・異常終了・PDFでない出力・古い読み込みのevent・読めないmessage・閉じない・掃除の失敗・pageの上限・描画中の停止・中断・直列・待ちの上限と中断した待ち・停止・古い一時directoryの掃除）、管理画面のエラーの文言と文書ごとの出力の状態、TanStack Markdownの描画のhookの契約。
- [x] 結合: daemonの管理APIで、200と`application/pdf`、HTML文書・不正なbody・保持していない版・認証なし・別のOriginの拒否、使えないbrowserの`E_BROWSER_NOT_FOUND`、接続が切れたときにbrowserが止まること。
- [x] e2e（Chromium、実際のChrome）: ボタンからdownloadし、`%PDF-`〜`%%EOF`、A4、2page以上、しおり、文書名のtitle、画像、全pageのheaderの文書名とfooterの「n / N」（PDFの文字を取り出して確かめる）、本文の文字を確かめる。HTML文書にボタンがない。
- [x] pack smoke: 導入したtarballだけで、印刷用の文書の描画（遅延読み込みのchunk）まで動く（browserがないので`E_BROWSER_NOT_FOUND`になることで確かめる）。
- [x] `pnpm check`、`pnpm build`、`pnpm test:pack`、`pnpm test:e2e`がexit 0（macOS）。
- [x] 代表的な文書（日本語・表・コード・画像・脚注・タスクリスト）のPDFを、header・footer・改ページ・配色について目で確かめた（macOS、Chrome 154・Edge 154）。

運用反映条件:

- [x] README（日英）、`docs/architecture.md`（日英）、`docs/security-model.md`（日英）、このADR、`docs/implementation-status.md`を更新した。
- [x] 配布物に実行時の依存を足していない（`@tanstack/highlight`をbundleし、`THIRD_PARTY_NOTICES.md`はbuildが生成する）。
- [x] Linuxでの、実際のbrowserでの印刷の確認（CIの`ubuntu-latest`のe2eで、runnerのGoogle Chromeによる出力が成功した。run 37423651940）。
