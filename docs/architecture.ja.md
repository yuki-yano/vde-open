# 構成

[English](architecture.md)

vde-openは、CLI、localのdaemon、browserの管理画面の3つで動きます。状態はdaemonだけが持ち、CLIと管理画面はdaemonへ依頼します。

```text
CLI（vde-open／vo） ──IPC（Unix socket、鍵で相互確認）──▶ daemon ──▶ state（state.json、blobs/）
                                                          │
管理画面（React） ◀──管理listener（127.0.0.1、認証なし）──┤
                                                          │
文書の表示（iframe） ◀──表示listener（127.0.0.1、別port、表示の権限）──┘
```

## workspaceの構成

| path | 役割 |
|---|---|
| `apps/cli` | CLIとdaemon。`dist/`へbundleし、両binと同梱UIを配布する |
| `apps/web` | 管理画面（React、Tailwind CSS、shadcn/ui、Base UI）。buildして`apps/cli/dist/web`へ同梱する |
| `packages/shared` | CLI・daemon・管理画面で共有する契約（Zodのschema、error code、上限） |
| `packages/document` | 文書の解析（見出し、節、title）、HTML・CSSの変換、Markdownの描画。fileやdaemonを知らない |

## daemon

- 起動: CLIが必要なときに起動する（`apps/cli/src/cli/daemon-control.ts`）。state rootごとに1つだけ動く（世代つきのlock。ADR-0005）。
- state: `apps/cli/src/persistence/state-store.ts`。変更はtransactionで1件ずつ行い、blobを書いてから`state.json`をatomicに置き換える。
- 文書: `apps/cli/src/documents/service.ts`。開く・閉じる・読む・版（revision）・監視rule。版は本文と参照するassetの内容から決まる。
- 監視: `apps/cli/src/watch/watch-service.ts`（Chokidar）。開いている文書の親directoryだけを監視し、保存を反映する。
- 解析と検索: worker thread（`apps/cli/src/workers/`）。解析は時間と構造の上限つき。検索はMiniSearchで、節ごとに索引する（ADR-0010）。
- 表示: `apps/cli/src/render/render-service.ts`が、文書・版・表示方法に結び付いた表示の権限を発行し、`apps/cli/src/server/http/preview.ts`が配信する（ADR-0008、0009、0012）。
- 質問と回答: `apps/cli/src/feedback/service.ts`（ADR-0011）。
- PDF出力: `apps/cli/src/export/pdf-service.ts`（ADR-0013）。`POST /documents/:id/pdf`で、専用のworkerが版を1つの印刷用の文書にする（`packages/document/src/print.ts`。TanStack MarkdownのHTMLの描画器と、表示と共有するlink・画像の規則`rendering-rules.ts`を使う）。daemonは、登録済みの画像をdata URLで埋めながら非公開の一時directoryへ書き、`apps/cli/src/export/browser.ts`で見つけたGoogle Chrome・Microsoft Edgeで印刷する。browserは一時profileでheadlessに動かし、`--remote-debugging-pipe`で操作する（`apps/cli/src/export/cdp.ts`、`Page.printToPDF`）。出力は1件ずつ行う。HTMLは同じ印刷workerの`html-print.ts`で静的表示の変換を使い、登録済みのCSSを安全化した一時file、画像とfontをdata URLにして渡す。CSSの`@import`・`@media print`・`@page`は保ち、印刷用fontの読み込みを待つ。
- repo: `apps/cli/src/documents/repository.ts`が、file文書のpathから上へ最も近い`.git`を探し、属するGitのrepoとcheckoutを決める。`git`は起動しない。repoの鍵はcommon git dir（`.git`がsymlinkのときと、`commondir`のない`.git`ファイルのときは、つながりを確かめられないのでcheckoutのdirectory）。linked worktreeは、管理directoryが`<common>/worktrees/<name>`で、その`gitdir`がcheckoutを指し返すときだけ認める。確かめられないものは`unresolved`とし、親のrepoには入れない。`apps/cli/src/documents/repository-tracker.ts`が結果をdaemonのmemoryだけに持つ（pathから決まり、古くなりうる値なのでstateには書かない）。判定するのは、daemonの起動時（受け付けの前）、open、reopen、明示的なrefresh、監視ruleでの追加のとき。保存の後の自動の再読み込みでは判定しない。各操作は判定を最大2秒待ち、終わらない文書は前の値（なければ`pending`）のまま処理を終え、判定が終わったら反映する。判定のfilesystem処理はdaemon全体で同時に2つまでにし、応答しないnetwork mountでもlibuvのpoolを使い切らない。判定ごとに増える番号を付け、その文書・checkoutにもっと新しい判定が反映済みなら捨てる。閉じた文書、判定の後に閉じて開き直した文書には反映しない。一覧の表示が変わるときはcatalogVersionを上げ、`catalog-changed`を1件送る。
- 通知: `apps/cli/src/server/event-hub.ts`。SSEで、IDと状態だけを運ぶ（本文は運ばない）。接続ごとの書き終わっていない通知は256件までで、超えた分は捨てて取り直しの合図（`resync-required`）にまとめる（`apps/cli/src/server/http/event-queue.ts`）。書き込みが60秒進まないときは、残りを送らずにsocketまで閉じる（`apps/cli/src/server/http/management.ts`）。

## 管理画面

- 認証なしでローカルのURLを直接開く。同じURLを別のbrowserやtabでも使える。`vo ui --print-url`でURLを取得できる。
- 一覧・表示・検索（`Cmd/Ctrl+K`）・回答panel。Flatの一覧の各行は、2行目にrepo・worktree・checkout内のpathを出す。Treeは、repo、worktreeの順に文書をまとめる。MarkdownとHTMLのiconは形と色が違う（`--format-markdown`、`--format-html`）。通知を受けて一覧と質問を取り直し、通知が欠けたら取り直して合わせる。
- HTMLの表示は、別のoriginのiframe（`sandbox`）。interactiveの表示とだけ、MessagePortで回答案を受け渡す（`apps/web/src/lib/bridge-host.ts`、`use-bridge.ts`）。
- 文書のheaderの「Export PDF」は、表示中の版を送り、返ってきたPDFをdownloadのlinkで保存する。出力の状態は文書ごとに表示の外で持つ（`apps/web/src/lib/pdf-export.ts`）。別の文書へ切り替えても取り消さず、失敗はその文書に戻ったときも表示する。管理画面を閉じるとrequestが中断され、browserを止める。

## 配布

`pnpm build`がUIとCLIをbuildし、`pnpm test:pack`がtarballを作って別のdirectoryへ導入して確かめる（`scripts/pack-smoke.ts`）。実行時の依存はすべてbundleし（ADR-0001）、導入時にbuildやscriptを実行しない。bundleに入れた依存（JS・CSS・font）のlicense noticeは、buildがbundleのmoduleの一覧から`THIRD_PARTY_NOTICES.md`へ書き出し、tarballに含める（`scripts/notices.ts`）。

## 設計の判断

`docs/adr/`にあります（0001〜0013）。
