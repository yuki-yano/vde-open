# 性能の実測

[English](performance.md)

仕様16.1の性能目標に対する実測です。値は設計目標であり、約束した値ではありません。CIでは環境に依存するms値をassertionにせず、hang・件数の上限・資源の増加を検査します（`tests/integration/resources.test.ts`）。

## 測定の方法

`pnpm build && pnpm perf`（`scripts/perf.ts`）。配布物（`apps/cli/dist`）を、一時の`VDE_OPEN_HOME`で動かします。fixtureは決まった内容のMarkdown（日本語と英語、8行ごとに見出し）を、指定の件数と合計の大きさで作ります。

- cold open: daemonの起動から、directoryの全文書を開き終えるまで（CLIの`open docs --recursive`）。
- 索引: 開いた後、全文書が検索の対象になるまで。
- warm検索: 10種類のqueryを5回ずつ（50回）、IPCで実行した時間のp50・p95。
- list・read: 一覧（500件ずつcursorで全件）と、1文書のreadの時間。
- 更新の公開: fileを書き換えてから、IPCの一覧の版が変わるまで（監視からdaemonが新しい版を公開するまで）。
- 管理画面（PlaywrightのChromium、headless、1280×800）:
  - 一覧: 一回限りのURLを開いてから、一覧に全文書が出るまで（件数の見出しと行の数で確かめる）。
  - 選択: 一覧の末尾の文書を押してから、その文書の見出しが表示されるまで。
  - 保存から表示の反映: 表示中の文書のfileへ行を足してから、その行が画面（DOM）に出るまで。
- 待機中のCPU: 最後の操作の後の5秒間に、daemonのprocessが使ったCPU時間の割合。操作が止まった後に各threadが1回行うGCを含む（下を参照）。
- daemonのprocessのmemory（解析と検索のworker threadを含む）。GCを強制せず、daemon自身が残す値を測る。
  - 最大のRSS: daemonに接続してから、管理画面の最後の操作までの最大値（`ps`で200msごとに測る）。
  - 最後の操作の0・5・20・60秒後のRSS。
  - 最後の操作の60秒後のphysical footprint（`vmmap --summary`、macOSだけ。アクティビティモニタの「メモリ」の値）。RSSは、他のprocessと共有するcodeも数える。
  - 最後の操作の60秒後の、各threadの使用中のheap（`daemon.diagnostics`、GCなし）。
  - どれも1回だけの測定で、memoryが増え続けるかどうかは、これらの値では判断しない（下の「資源の検査」で確かめる）。

## 結果（2026-10-04）

環境: macOS（darwin arm64）、Apple M5 Max（18コア）、Node.js v24.21.0、Chromium（Playwright 1.63.0、headless）。

daemonとIPC:

| fixture | 文書数 | cold open | 索引 | 検索 p50 | 検索 p95 | list | read | 更新の公開 | 待機中のCPU |
|---|---|---|---|---|---|---|---|---|---|
| standard（100文書／10MiB） | 100 | 720.4ms | 1473.5ms | 32.0ms | 80.7ms | 0.9ms | 1.4ms | 245.8ms | 1.2% |
| load（1,000文書／50MiB） | 1000 | 5074.6ms | 8311.1ms | 216.6ms | 532.8ms | 4.5ms | 1.1ms | 334.1ms | 3.1% |

memory:

| fixture | 最大のRSS | 操作の0秒後のRSS | 5秒後 | 20秒後 | 60秒後 | footprint（60秒後） | heap 本体／検索／解析（60秒後） |
|---|---|---|---|---|---|---|---|
| standard（100文書／10MiB） | 754.0MiB | 754.3MiB | 715.9MiB | 295.3MiB | 296.0MiB | 204.9MiB | 16.5／116.9／6.0MiB |
| load（1,000文書／50MiB） | 2798.5MiB | 2620.8MiB | 2444.5MiB | 835.7MiB | 841.4MiB | 654.7MiB | 25.7／489.4／6.1MiB |

管理画面:

| fixture | 一覧に全件が出るまで | 末尾の文書の選択 | 保存から表示の反映（DOM） |
|---|---|---|---|
| standard（100文書／10MiB） | 140.8ms | 101.0ms | 308.8ms |
| load（1,000文書／50MiB） | 239.5ms | 432.9ms | 350.3ms |

## 目標との比較

| 目標（仕様16.1） | 結果 |
|---|---|
| 標準fixtureでwarm検索p95 300ms以内 | 達成（80.7ms） |
| 通常の保存から表示の反映まで1秒程度 | 達成（画面の表示まで308.8ms、負荷でも350.3ms） |
| 待機時にCPUが回り続けない | 達成（最初の5秒で1.2%、3.1%。操作の後の1回のGCを含む。下を参照） |

## memory

- **常に持つのは検索の索引。** 検索workerは、開いている文書の索引を持ちます。heapは、10MiBのfixtureで約117MB、50MiBで約489MBです。`node_modules`内のMarkdown 452件（7.6MiB、実際の文章）では、daemonの検索workerのheapが80MB、daemonはRSS約263MiB、footprint 191MiBで落ち着き、検索p95は14msでした。同じ索引をdaemonの外のscriptで作り、GCの後のheapの差で測ると、主な部分は、MiniSearchの転置索引が約44MB、抽出した節の元の本文が約9.8MB、連続一致のための正規化した写しが約7.7MBです（後の2つは、文字列だけでなく、それを持つ配列やobjectも含む）。このscriptの数字は、80MBの内訳ではありません。
- **最大値は一時的。** 操作の間、RSSは標準で約750MiB、負荷で約2.8GiBに達し、操作が終わると20秒以内に下がります。最大値の多くは検索workerです。MiniSearchは、語に一致したentryごとに結果のobjectを作ります。fixtureは同じ7つの文の繰り返しなので、ほとんどのqueryが、ほとんどの節に一致します（負荷で114,000 entry）。上の実際のMarkdownでは、最大値は約610MiBでした。
- **操作の後のGC。** Node.jsのthreadは、待機中に自分から完全なGCを行わないので、解析・索引・検索で出たごみがheapとRSSに残っていました。今は、各threadが操作の止まった後に1回GCを行います。検索と解析のworkerは依頼が2秒途切れた後、daemonの本体は、heapが8MiB以上増え、2秒の間ほぼ何もしていなかったときです（`apps/cli/src/diagnostics/idle-collect.ts`）。workerのGCの間に届いた依頼は、GCの終わりを待ってから送ります。この待ちは、GCの開始から最大10秒まで、依頼の期限に数えません。10秒を過ぎたら待たずに送り、通常の期限とworkerの回収が適用されます。依頼の処理中にGCの時期が来たときは、捨てずに次の空きで行います。この変更の前は、実際のMarkdownでGCを強制しないと、60秒後もRSS約500MiB、footprint 445MiBのままでした（解析workerがheap 67MB、GCの後は8MB。本体が約50MB、GCの後は16MB）。
- **このページの以前の版**は、操作の直後のRSS（1.0GBと2.8GB）を載せていました。これは最大値に近い値で、daemonが持ち続ける量ではありません。
- **結果を変えない検索の処理の削減。** 強い段階（完全一致、前方一致、綴りの違いの順）で見つかった節と、検索対象の外の項目は、MiniSearchが結果のobjectを作る前に除きます（文書のboostを0にする）。MiniSearchへの問い合わせは、前の段階と同じになる段階も含めて、以前と同じものを同じ順に行います。MiniSearchは、置き換えた項目や消した項目のpostingを、語をたどるときに片付け、それまではscoreの計算に数えます。1回のたどりで片付け残すこともあるので、問い合わせを省くと、索引が片付くまで後のscoreが変わるためです。抜粋は、連続一致のために持っている正規化した本文を使います。hit・一致の種類・score・抜粋はすべて同じです。`apps/cli/src/search/search-ranking.test.ts`が、56件のqueryの全hitを、作ったばかりの索引と、置き換え・削除・途中で破棄した項目が片付いていない索引（2回ずつ）で記録しています（記録は変更前のcodeで作った）。変更前後の索引を、実際のMarkdownと10MiBのfixtureでそれぞれ220件のqueryで比べて、差はありませんでした。検索p95は、標準で175.7msから80.7ms、負荷で1200.2msから532.8msになりました。
- **行っていないこと。** 索引そのものを小さくする（MiniSearchの入れ子のMapを、詰めたposting形式に置き換える）には、scoreの計算・前方一致・綴りの違いの一致を自前で持つ必要があり、効果はJavaScriptのheapの外のmemoryも含めて測る必要があります。最大値をさらに下げるには、MiniSearchの検索の中身（entryごとの結果objectを作らずにscoreを集める）を変える必要があります。workerのheapの上限（`resourceLimits`）は、索引に必要な量を減らさず、上限に達するとworkerと索引を失います。

## 未達・未調査の点

- 負荷fixtureでの検索p95は532.8msでした。負荷fixtureには時間の目標はありませんが、文書が多いと検索が遅くなります。
- 表の値は1回の測定です。同じ機械でのほかの測定では、cold open・索引・検索・更新の公開の差は15%以内でした。管理画面の項目はbrowserを含むので、ばらつきが大きくなります（標準で一覧104〜176ms、選択90〜144ms。保存から表示の反映は、2026-10-04の3回のうち1回で839.5msでした。その回はlistも約1msではなく4.1msでした）。list・readは値が数msなので、割合では大きく変わります。最大のRSSも測定ごとに変わります（標準で945MiBと755MiB）。
- 診断（`daemon.diagnostics`）は、回収を求めないときは索引の同期などの処理を起こしません。診断のたびに索引の同期を行う形にしていたときは、待機中のCPUが0.9%（標準）と出ました（待機の後の診断の処理が含まれたため）。
- Linux・Windows、Firefox・WebKitでは測っていません。

## 資源の検査（PERF-002〜005）

`tests/integration/resources.test.ts`で、daemonの診断（IPCの`daemon.diagnostics`。監視しているdirectoryの数と、作ったwatcher・閉じ終えたwatcherの数、通知の購読数、通知の接続ごとの書き終わっていない通知の数、表示の権限の数、各serviceが保持している項目の数、検索と解析のworkerのheapと、検索のindexが保持している項目の数、Nodeの有効な資源の種類ごとの数、RSS、heap、CPU時間）を使って検査します。`collectGarbage: true`を渡すと、検索のindexを今の文書の状態に合わせ終え、消した項目を片付けて（MiniSearchのvacuum）から、daemonの本体と各workerのthreadでGCを1回行い、heapを測ります。診断の最中にdaemonの停止が始まったら、同期を待たずに`E_DAEMON_STOPPING`で終えます（停止を待たせない）。

- 1,000文書を開いても、管理画面の一覧に全件が出て、末尾の文書を選んで表示でき、保存が表示に反映される（PERF-002。`tests/e2e/ux.spec.ts`）。
- 100回の開閉と、監視ruleの追加・解除20回の後でも、監視しているdirectoryの数と有効な資源の数が増えず、外したwatcherはすべて閉じ終えている（作った数－閉じた数＝監視中のdirectoryの数）（PERF-003）。
- memoryの継続増加（PERF-003、仕様16.1）: 約40KiBの文書を「書き換える・開く・読む・検索する・表示の権限を取って返す・閉じる」を30回行った後、40回ずつ3区間を繰り返し、区間の終わりごとに、daemonの本体・検索のworker・解析のworkerのGCの後のheapと、保持している項目の数を測る（決まった時間は待たず、上の診断が同期と片付けを待つ）。
  - 本体が保持している項目（解析の結果、版の記録、表示の権限と変換の結果、索引の記録、待っている処理、session）と、検索のindexが保持している項目（確定・途中の文書、索引の項目、語、片付け前の項目）の数は、3区間で同じ。
  - heapの区間ごとの増え方は、本体・各workerとも1MiB未満（macOSの実測で、本体は+0.3MiB、+0.1MiB程度、workerは+0.1MiB未満）。
  - 漏れを作ると失敗することを確かめた: 本体でreadのたびに約40KiBを残すと1区間で約2.0MB、検索のworkerでindexの確定のたびに8,192要素の配列を残すと1区間で約2.6MB増える。
  - 閉じた文書の記録（stateに残り、開き直すと同じIDを使う）に付く項目は、開いたことのある文書の数までで止まる。
- 通知を読まないclientがいても、50回の連続した更新と、ほかのclientの操作が終わる（PERF-004）。書き込みが詰まった接続の検査は`apps/cli/src/server/http/management.test.ts`にあります。受け手のsocketが埋まるまで通知を出した後、さらに5万件を出しても、接続ごとの待ち行列は上限（256件と取り直しの合図1つ）を超えません。読む接続には取り直しの合図とその後の通知が届き、書き込みが進まない接続は期限（既定60秒）の後に切って購読を外します。
- 通知の接続と切断を30回繰り返しても購読が残らず、3秒の待機で使うCPU時間が150ms未満（PERF-005）。
