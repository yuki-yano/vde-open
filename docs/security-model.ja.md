# セキュリティモデル

[English](security-model.md)

## 守るもの

- 外部のWebサイトや表示した文書から、管理API（文書の操作・検索・回答の確定）を利用されること。
- 開いていない文書と、登録していないfile（秘密のfileを含む）。
- 回答の確定。人が管理画面で送信したときだけ確定する。

## 信頼の境界

| 主体 | 扱い |
|---|---|
| CLI・Agent（同じOSのuser） | IPCの鍵（state root配下、本人だけが読める）で、daemonと相互に確かめる |
| 管理画面 | 認証なし。`127.0.0.1`のURLを直接開く。Host・Origin・`Sec-Fetch-Site`を確かめる。状態を変えるrequestはJSONだけ |
| 文書の表示（iframe） | 信頼しない。管理画面と別のport（origin）で配信し、`sandbox`とCSPで制限する。管理APIを直接利用できない |
| 文書の中のscript（interactive） | 信頼しない。利用者が明示的に許可したHTMLだけで動かす。読み込めるのは登録したfileだけ。回答の連携では回答案を取得・置換できる。確定は管理画面で行う |
| PDF出力のbrowser | 人が「Export PDF」を押したときだけ、daemonが起動する。通常の場所に入っているGoogle Chrome・Microsoft Edgeか、`VDE_OPEN_BROWSER`で指定した実行file。一時profileでheadlessに動かし、pipeで操作する（portを開かない）。印刷するpageはdaemonが書いたもの。HTMLのCSSは登録済みのものを安全化した一時fileだけを読み込む |
| 外部のnetwork | daemonは外部へ通信しない。外部の画像・CSS・fontを読み込まない |

単体画像にも同じ表示の権限とsourceのsize上限を適用する。SVGを含む元のbytesは画像assetとして配信し、管理画面では`<img>`で表示する。assetのCSP（`default-src 'none'; style-src 'unsafe-inline'; sandbox`）は、SVGのURLを直接開いた場合もscriptと外部参照を遮断する。未登録fileは配信しない。

## 主な対策

- 表示の権限（256bitの乱数）は、文書・版・表示方法・閉じた回数・scriptの許可の世代に結び付き、閉じる操作・許可の取消・返却・daemonの再起動で失効する。保持はdaemon全体で64件までで、超過した分は古いものから失効する（ADR-0008、0012、0014）。
- 配信するfileは、登録したlogical pathとの完全一致だけ。symlinkや「..」でassets-rootの外へ出る参照、名前が「.」で始まるfile、種類の合わないfileを拒否する（ADR-0009）。
- Static の HTML は、parse5の構文木で文書のscript・event属性・埋め込み・base・自動の移動・formの送信先・外部の参照を取り除き、出力を解析し直して確かめる。CSSはcss-treeで外部の参照を取り除き、escapeを処理する。
- 両方の表示モードで、iframeは不透明なオリジンを持つ。ローカル文書へのリンクは、先頭に挿入するアプリのscriptが実際のクリックを受け、非公開の片方向MessagePortでリンクIDだけを送る。Static の CSP は、このscriptをハッシュで指定して許可する。管理画面は送信元のiframeを確認し、表示中の版とモードでIDを照合する。未登録の文書を開くには管理画面での確認が必要になる。
- Interactive の HTML は、CSPの`script-src`でinlineと登録済みのscript、`connect-src`で表示の権限内の通信を許可する。回答の連携ではMessagePortをiframeへ1回だけ渡し、messageの大きさ・件数・順番・形を検証する。HTMLからの回答案の保存は、表示の権限を保存のtransactionの中でも確かめる（ADR-0012）。
- 回答は、管理画面の送信buttonでだけ確定する。確定する内容は、serverが保存済みの回答案から取る。送信はIDで冪等にし、条件が違えば競合にする（ADR-0011）。
- MarkdownのPDF出力の印刷用の文書は、表示と同じ規則で作る。生のHTMLはescapeし、linkは文書の中の見出し・http(s)・mailtoだけを残し、画像はその版に登録したものだけをdata URLで入れる。pageにはCSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`を付け、scriptを動かさず、通信もしない。page headerの文書名はCSSの文字列としてescapeする。HTMLのPDFも静的表示と同じ安全化を行い、scriptは動かさない。登録済みのCSSだけを名前を付け直した一時fileにし、画像とfontはdata URLで入れる。CSPは`default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' file:; base-uri 'none'; form-action 'none'`で、元文書が参照した未登録file・外部URLは静的変換で取り除く。HTMLとCSS（埋め込んだ画像・fontを含めて256MiBまで）とbrowserのprofileは、出力ごとに消す非公開の一時directory（0700）に置く。daemonが強制終了されて残ったものは、次にdaemonが起動したときに、1時間より古ければ消す（実directoryで、その利用者が所有するものだけ）。browserのsandboxは外さない。出力は1件ずつ、60秒以内に行い、時間切れ・requestの中断・daemonの停止で、browserを補助processごと止める（POSIXはprocess group、Windowsはprocess tree）。browserから読めないmessageが届いたときは、その出力だけを終え、daemonは止めない（ADR-0013）。
- logには、IPCの鍵・表示の権限・回答・本文を残さない。
- 文書がどのrepoに属するかを示すため、daemonは開いている文書の近くのGitのmetadata（`.git`ファイル、`commondir`、`HEAD`、worktreeの`gitdir`の逆向きのlink）を読む。これはそのdirectoryの持ち主が自由に書けるので、信頼できない入力として扱う。通常のfileだけを、最後のsymlinkをたどらず、FIFOで止まらないように開き、それぞれ4KiBまで読む。`git`は起動しない（そのdirectoryのGitの設定を読ませないため）。別のrepoを指す`.git`ファイルやsymlinkで、そのrepoに入れることはできない（worktreeはrepoから指し返されている必要があり、symlinkの`.git`と`commondir`のない`.git`ファイルはcheckout自体をrepoにする）。Windowsでは、metadataから得たpathのrootがdrive文字でなく（UNC、device path）、文書のrootと違うとき、filesystemに触れる前に拒否する。metadataに直接書いて、daemonを別のhostへ接続させることはできない。UIとCLIに渡すのは、repoとcheckoutのpath、worktreeの名前、branch名、文書のcanonical pathだけ（すでに渡している絶対pathと同じ種類の情報）。

## 守らないもの

- 同じ端末から管理listenerへ接続するprocessや別のOS user。管理画面/APIは本人確認をせず、ローカルの接続から文書や回答を読み、操作できる。
- browser自体の脆弱性。
- PDF出力のために起動したbrowserが自分で行う通信。background networking・component update・sync・拡張機能を無効にして起動し、印刷するpageは通信しない。
- interactiveのHTMLの中のscriptによる、iframe自身の移動、CPU・memoryの消費。interactiveは、任意の敵対的なscriptを安全に動かす仕組みではない。
- Gitのmetadataを読む途中で、間接的に別のhostへ届くこと（途中のdirectoryがUNCを指すsymlink（reparse point）の場合や、drive文字を持つnetwork drive）。そうした場所に置いた文書を開くのと同じ扱い。

## 検証

受け入れテスト（SEC-001〜020、FB-007〜011、FB-022など）の対応は`docs/implementation-status.md`にあります。
