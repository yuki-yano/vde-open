# 構成

[English](architecture.md)

vde-openは、CLI、localのdaemon、browserの管理画面の3つで動きます。状態はdaemonだけが持ち、CLIと管理画面はdaemonへ依頼します。

```text
CLI（vde-open／vo） ──IPC（Unix socket、鍵で相互確認）──▶ daemon ──▶ state（state.json、blobs/）
                                                          │
管理画面（React） ◀──管理listener（127.0.0.1、session token）──┤
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
- 表示: `apps/cli/src/render/render-service.ts`が、文書・版・表示方法・sessionに結び付いた表示の権限を発行し、`apps/cli/src/server/http/preview.ts`が配信する（ADR-0008、0009、0012）。
- 質問と回答: `apps/cli/src/feedback/service.ts`（ADR-0011）。
- 通知: `apps/cli/src/server/event-hub.ts`。SSEで、IDと状態だけを運ぶ（本文は運ばない）。接続ごとの書き終わっていない通知は256件までで、超えた分は捨てて取り直しの合図（`resync-required`）にまとめる（`apps/cli/src/server/http/event-queue.ts`）。sessionの失効・破棄と、書き込みが60秒進まないときは、残りを送らずにsocketまで閉じる（`apps/cli/src/server/http/management.ts`）。

## 管理画面

- 一回限りのURL（`vo ui`）でsessionを作り、tokenはsessionStorageに置く（URLのfragmentはすぐ消す）。
- 一覧・表示・検索（`Cmd/Ctrl+K`）・回答panel。通知を受けて一覧と質問を取り直し、通知が欠けたら取り直して合わせる。
- HTMLの表示は、別のoriginのiframe（`sandbox`）。interactiveの表示とだけ、MessagePortで回答案を受け渡す（`apps/web/src/lib/bridge-host.ts`、`use-bridge.ts`）。

## 配布

`pnpm build`がUIとCLIをbuildし、`pnpm test:pack`がtarballを作って別のdirectoryへ導入して確かめる（`scripts/pack-smoke.ts`）。実行時の依存はすべてbundleし（ADR-0001）、導入時にbuildやscriptを実行しない。bundleに入れた依存（JS・CSS・font）のlicense noticeは、buildがbundleのmoduleの一覧から`THIRD_PARTY_NOTICES.md`へ書き出し、tarballに含める（`scripts/notices.ts`）。

## 設計の判断

`docs/adr/`にあります（0001〜0012）。
