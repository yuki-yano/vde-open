# セキュリティモデル

[English](security-model.md)

## 守るもの

- 管理の権限（文書を開く・閉じる、検索、質問と回答の確定）。
- 開いていない文書と、登録していないfile（秘密のfileを含む）。
- 回答の確定。人が管理画面で送信したときだけ確定する。

## 信頼の境界

| 主体 | 扱い |
|---|---|
| CLI・Agent（同じOSのuser） | IPCの鍵（runtime directoryの中、本人だけが読める）で、daemonと相互に確かめる |
| 管理画面 | 一回限りのURL（bootstrap ticket、60秒）で作ったsession token。Host・Origin・`Sec-Fetch-Site`を確かめる。状態を変えるrequestはJSONだけ |
| 文書の表示（iframe） | 信頼しない。管理画面と別のport（origin）で配信し、`sandbox`とCSPで制限する。管理のtokenを持たない |
| 文書の中のscript（interactive） | 信頼しない。利用者が明示的に許可したHTMLだけで動かす。読み込めるのは登録したfileだけ。HTMLから行えるのは回答案の取得と置き換えだけで、確定はできない |
| PDF出力のbrowser | 人が「Export PDF」を押したときだけ、daemonが起動する。通常の場所に入っているGoogle Chrome・Microsoft Edgeか、`VDE_OPEN_BROWSER`で指定した実行file。一時profileでheadlessに動かし、pipeで操作する（portを開かない）。印刷するpageはdaemonが書いたもので、何も読み込まない |
| 外部のnetwork | daemonは外部へ通信しない。外部の画像・CSS・fontを読み込まない |

## 主な対策

- 表示の権限（256bitの乱数）は、文書・版・表示方法・session・閉じた回数・scriptの許可の世代に結び付き、閉じる操作・sessionの失効・許可の取消・返却で失効する（ADR-0008、0012）。
- 配信するfileは、登録したlogical pathとの完全一致だけ。symlinkや「..」でassets-rootの外へ出る参照、名前が「.」で始まるfile、種類の合わないfileを拒否する（ADR-0009）。
- staticのHTMLは、parse5の構文木で、script・event属性・埋め込み・base・自動の移動・formの送信先・外部の参照を取り除き、出力を解析し直して確かめる。CSSはcss-treeで、外部の参照とescapeによる回避を無効にする。
- interactiveのHTMLは、CSPの`script-src`と`connect-src`を表示の権限の中に限り、`allow-same-origin`を付けない。MessagePortは表示したiframeへ1回だけ渡し、frameの大きさ・件数・順番・形を検証する。HTMLからの回答案の保存は、表示の権限を保存のtransactionの中でも確かめる（ADR-0012）。
- 回答は、管理画面の送信buttonでだけ確定する。確定する内容は、serverが保存済みの回答案から取る。送信はIDで冪等にし、条件が違えば競合にする（ADR-0011）。
- PDF出力の印刷用の文書は、表示と同じ規則で作る。生のHTMLはescapeし、linkは文書の中の見出し・http(s)・mailtoだけを残し、画像はその版に登録したものだけをdata URLで入れる。pageにはCSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`を付け、scriptを動かさず、通信もしない。page headerの文書名はCSSの文字列としてescapeする。page（画像を含めて256MiBまで）とbrowserのprofileは、出力ごとに消す非公開の一時directory（0700）に置く。daemonが強制終了されて残ったものは、次にdaemonが起動したときに、1時間より古ければ消す（実directoryで、その利用者が所有するものだけ）。browserのsandboxは外さない。出力は1件ずつ、60秒以内に行い、時間切れ・requestの中断・daemonの停止で、browserを補助processごと止める（POSIXはprocess group、Windowsはprocess tree）。browserから読めないmessageが届いたときは、その出力だけを終え、daemonは止めない（ADR-0013）。
- logには、token・ticket・表示の権限・回答・本文を残さない。
- 文書がどのrepoに属するかを示すため、daemonは開いている文書の近くのGitのmetadata（`.git`ファイル、`commondir`、`HEAD`、worktreeの`gitdir`の逆向きのlink）を読む。これはそのdirectoryの持ち主が自由に書けるので、信頼できない入力として扱う。通常のfileだけを、最後のsymlinkをたどらず、FIFOで止まらないように開き、それぞれ4KiBまで読む。`git`は起動しない（そのdirectoryのGitの設定を読ませないため）。別のrepoを指す`.git`ファイルやsymlinkで、そのrepoに入れることはできない（worktreeはrepoから指し返されている必要があり、symlinkの`.git`と`commondir`のない`.git`ファイルはcheckout自体をrepoにする）。Windowsでは、metadataから得たpathのrootがdrive文字でなく（UNC、device path）、文書のrootと違うとき、filesystemに触れる前に拒否する。metadataに直接書いて、daemonを別のhostへ接続させることはできない。UIとCLIに渡すのは、repoとcheckoutのpath、worktreeの名前、branch名、文書のcanonical pathだけ（すでに渡している絶対pathと同じ種類の情報）。

## 守らないもの

- 同じOSのuserとして動く悪意のあるprocess（鍵とstateを読める）。
- browser自体の脆弱性。
- PDF出力のために起動したbrowserが自分で行う通信。background networking・component update・sync・拡張機能を無効にして起動し、印刷するpageは通信しない。
- interactiveのHTMLの中のscriptによる、iframe自身の移動、CPU・memoryの消費。interactiveは、任意の敵対的なscriptを安全に動かす仕組みではない。
- Gitのmetadataを読む途中で、間接的に別のhostへ届くこと（途中のdirectoryがUNCを指すsymlink（reparse point）の場合や、drive文字を持つnetwork drive）。そうした場所に置いた文書を開くのと同じ扱い。

## 検証

受け入れテスト（SEC-001〜020、FB-007〜011、FB-022など）の対応は`docs/implementation-status.md`にあります。
