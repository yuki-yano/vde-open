# ADR-0005: runtimeの位置と、lockの所有者の判定

状態: 採用（P1）

## 背景

仕様6.1は、Unixのruntimeを所有者専用の短いpathに置くこと、state rootが長くてもsocketのpath長制限に収まることを求める。仕様6.2は、lockを更新時刻だけで壊さないこと、所有者が生きているか判定できない場合は壊さないこと、所有者が確実に停止している場合だけ回収することを求める。

## 決定

### runtimeの位置

- Unix: `/tmp/vde-open-<uid>/<state rootのsha256の先頭16桁>/`。socketは`ipc.sock`、IPCのkeyは`ipc.key`。
- Windows: named pipe `\\.\pipe\vde-open-<hash>`。keyは`<state root>/runtime/ipc.key`。
- 位置は環境変数に依存しない。CLIとdaemonの`TMPDIR`や`XDG_RUNTIME_DIR`が違っても、同じ位置になる。
- 親directoryとruntime directoryは0700で作り、使う前にsymlinkでないこと、所有者、権限を確かめる。他者が先に作ったdirectoryは使わない。
- daemonが実際に使っている位置は`runtime-pointer.json`に書く。CLIは接続前に、その位置が所有者専用であることを確かめる。

### lock

- `daemon.lock`: 単一writerのlock。`start.lock`: CLIがdaemonを起動するときに取り、起動を1つずつにする。
- lockは世代で管理する。fileは`<name>.<12桁の世代>`で、世代が最大のfileが現在のlock。内容は`{generation, pid, ownerId, startedAt, released}`。
- 取得は、次の世代のfileを排他的に作ることで行う。内容を書き終えた一時fileを`link()`で置くので、同じ世代を作れるのは1つのprocessだけで、読む側が書きかけのlockを見ることもない。
- 次の世代を作ってよいのは、現在のlockが解放済みか、所有者が停止済みのときだけ。所有者が生きているlockや、読めないlockは引き継がない。
- 解放は、自分のfileを`released: true`へ書き換える。fileは消さない。
- 取得した所有者は、自分より古い世代のfileを消す。最大の世代のfileは誰も消さない。
- 取得は「次の世代のfileを作れた」だけでは成立させない。作成後に一覧を読み直し、自分が最大の世代であることを確かめてから成立させる。古い観測にもとづいて、消された世代を作り直した場合は、必ずより新しい世代が存在するので、作ったfileを消して判定をやり直す。
- 既存のlockを外したり置き換えたりしないので、lockが存在しない瞬間はできない。
- 所有者の判定は次の順で行う。
  1. pidのprocessがない → 停止済み。
  2. processの起動時刻がlockの`startedAt`より2秒以上後 → pidが再利用されている。所有者は停止済み。
  3. それ以外（起動時刻を取得できない場合を含む） → 生存として扱い、lockを引き継がない。
- daemonは2秒ごとに自分のlockを確かめ、失っていたら書込みを止めて終了する。そのとき、自分のものと確かめられないruntime fileは消さない。
- daemonは停止時に、受付済みのrequestとcommitが終わってからlockを解放する。途中で解放すると、次のdaemonの書込みと重なるため。
- `doctor --repair`は、修復の間この`daemon.lock`を自分で取る。修復とdaemonの起動は同時に進まない。
- 他のprocessへsignalを送って止めることはしない。

### 採らなかった方式

最初の実装では、停止済みのlockをrenameで退避してから取り直していた。退避と取り直しの間にlockが存在しない瞬間ができ、別のprocessが取得できる。退避したものが生きているlockだった場合に元へ戻す処理も、その間に作られた別のlockを上書きし得る。レビューでこの経路を再現したため、世代方式へ変えた。

## 影響

- processの起動時刻は`ps -o lstart=`で取得する。Windowsでは取得しないので、processがある限り生存として扱う。
- pidが再利用され、かつ起動時刻も取得できない場合は、`doctor`でも回収できない。利用者がprocessを確認して対処する。
- 解放済みのlock file（`daemon.lock.<世代>`、`start.lock.<世代>`）が、state rootに1つずつ残る。
