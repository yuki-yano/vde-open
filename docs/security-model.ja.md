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
| 外部のnetwork | daemonは外部へ通信しない。外部の画像・CSS・fontを読み込まない |

## 主な対策

- 表示の権限（256bitの乱数）は、文書・版・表示方法・session・閉じた回数・scriptの許可の世代に結び付き、閉じる操作・sessionの失効・許可の取消・返却で失効する（ADR-0008、0012）。
- 配信するfileは、登録したlogical pathとの完全一致だけ。symlinkや「..」でassets-rootの外へ出る参照、名前が「.」で始まるfile、種類の合わないfileを拒否する（ADR-0009）。
- staticのHTMLは、parse5の構文木で、script・event属性・埋め込み・base・自動の移動・formの送信先・外部の参照を取り除き、出力を解析し直して確かめる。CSSはcss-treeで、外部の参照とescapeによる回避を無効にする。
- interactiveのHTMLは、CSPの`script-src`と`connect-src`を表示の権限の中に限り、`allow-same-origin`を付けない。MessagePortは表示したiframeへ1回だけ渡し、frameの大きさ・件数・順番・形を検証する。HTMLからの回答案の保存は、表示の権限を保存のtransactionの中でも確かめる（ADR-0012）。
- 回答は、管理画面の送信buttonでだけ確定する。確定する内容は、serverが保存済みの回答案から取る。送信はIDで冪等にし、条件が違えば競合にする（ADR-0011）。
- logには、token・ticket・表示の権限・回答・本文を残さない。

## 守らないもの

- 同じOSのuserとして動く悪意のあるprocess（鍵とstateを読める）。
- browser自体の脆弱性。
- interactiveのHTMLの中のscriptによる、iframe自身の移動、CPU・memoryの消費。interactiveは、任意の敵対的なscriptを安全に動かす仕組みではない。

## 検証

受け入れテスト（SEC-001〜020、FB-007〜011、FB-022など）の対応は`docs/implementation-status.md`にあります。
