# ADR-0016: 1文書の容量上限を50MiBにする

状態: 採用。

画像と再編集用のデータを埋め込んだHTMLが10MiBを超え、文書として登録できなかったため、`LIMITS.documentBytes`を10MiBから50MiB（52,428,800 bytes）へ引き上げる。Markdown・HTML・単体画像とstdinに共通の上限として適用する。

50MiBを超える文書は、引き続き`E_LIMIT_EXCEEDED`で拒否する。読み取り中にfileが大きくなった場合の容量チェックも維持する。一度に開く文書の合計128MiB、保存容量1GiB、assetと解析時間の上限は変更しない。大きな文書では、読み込みや解析のメモリ使用量が増える。

## DoD

### 機能完了条件

- [x] 1文書の容量上限を52,428,800 bytesにする。
- [x] READMEの日英両方に50MiBの上限を記載する。

### テスト完了条件

- [x] 結合テストで50MiBちょうどの文書を登録でき、1 byte超過した文書は登録されないことを確認する。
- [x] 文書の一括登録と合計容量上限の既存テストが成功する。
- [x] 変更したTypeScript fileのformat・lintと配布物のbuildが成功する。

### 運用反映条件

- [x] ローカルのlinked CLIを更新し、既存の文書を保持してdaemonを再起動する。
- [x] deck-bridgeの対象HTMLをインストール済みの`vo`で登録できることを確認する。

検証（2026-10-31）: 文書・画像の結合テストと文書の並行処理テストの計56件、変更したTypeScript fileのformat・lint、`pnpm build`が成功。50MiBの境界を固定値で指定したテストも単独で再実行して成功した。`bun link`と`bun link -g --production vde-open`でローカルCLIを再リンクし、daemon再起動後も既存32文書のIDと順序を保持した。deck-bridgeの`.archify/explainer-master-duel-20261031-172141/index.html`（11,268,466 bytes）を、インストール済みの`vo`で警告なしに登録できた。
