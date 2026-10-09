# ADR-0008: 文書の表示は別のlistenerで行い、版ごとの権限で読める範囲を限る

状態: 採用（P3）。管理画面の認証・sessionへの結び付け・保持上限は[ADR-0014](0014-management-without-authentication.md)で更新。

## 背景

仕様10章は、開いた文書（特にHTML）の内容を、管理UIの権限やoriginと共有しないことを求める。防ぐ対象は、表示した文書からの管理APIの利用、他の文書や未登録のfileの読み取り、権限の自動的な拡大、任意のfileの公開である。

## 決定

- 文書を表示するlistenerを、管理UIとは別のport（`127.0.0.1`、OSが割り当てる。`serve --preview-port`で指定可）で動かす。受け付けるのは`GET`と`HEAD`の`/r/<grant>/files/<logical path>`だけ。それ以外は、理由を区別せず`404`（本文は固定の文字列）で応じ、管理API・UIのHTML・redirect・directoryの一覧は返さない。
- 表示には、管理APIで発行する権限（grant、256bitの乱数）が要る。権限は、発行したsession、文書、版、表示方法に結び付く。使えるのは、その版に登録したfileの配信だけで、管理APIの認証には使えない。
- 権限は、文書を閉じたとき、sessionを破棄したとき・期限が切れたとき、UIが返したとき、daemonを再起動したときに失効する。1つのsessionが持てる数は64で、超えた分は古いものから失効する。権限はmemoryにだけ置く。
- 権限は、発行した時点の「文書を閉じた回数」に結び付ける。閉じた文書の権限は、開き直しても戻らない。表示用の変換を待つ間に文書が閉じられた場合、閉じる前に始めた発行は成立させず、開き直されていれば、開いていることを確かめ直してから発行する。
- 変換結果は、版と文書の位置の組で保持する。版は内容で決まり文書の位置を含まないので、同じ内容の文書が別の位置にあるときに取り違えないようにする。
- 配信は、登録時に決めた「logical path → 保存済みの内容」の完全一致で引く。requestのpathをfilesystemへ解決することはしない。pathは、URLとして解決した後の形を、1回だけdecodeして調べ、区切りやNULをencodeした形は受け付けない。
- 応答のheaderは種類で分ける。HTML文書には仕様10.5のpolicy（`script-src 'none'`、`sandbox`、読み込み元は自分の権限の配下だけ、埋め込めるのは管理UIだけ）を付ける。それ以外のfileには`default-src 'none'; sandbox`を付け、直接開かれても何も実行されないようにする。`Access-Control-Allow-Origin: null`は、権限を確かめた後のfont・CSS・script・dataにだけ付ける（sandboxの中の文書はoriginを持たないため）。この`null`は読み込みの許可だけに使い、相手の確認には使わない。
- 管理UIのpolicyは、文書の表示（`frame-src`）と登録済みの画像（`img-src`）についてだけ、表示用のlistenerを許可する。
- HTML文書は`<iframe sandbox="">`（空のsandbox）で表示する。Markdownは本体で描画し、画像だけを表示用のlistenerから読む。
- logには、表示用URLのpathも権限も残さない。記録するのは、event名、status、byte数だけ。

## 影響

- 版が変わるたびに、UIは新しい権限を取得して表示を作り直す。前の版の権限は、UIが返すまで前の版を表示し続ける。
- 権限と変換結果はmemoryにあるので、daemonの再起動後は、UIが権限を取り直す。
- scriptを動かす表示（interactive）は、P6で、同じlistenerに別のpolicyを足して実装した（ADR-0012）。P3の時点の`--html-mode`は`static`だけを受け付けた。
