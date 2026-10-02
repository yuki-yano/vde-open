# 認証仕様

この文書は、vde-openの検索と部分取得を試すためのサンプルです。
実際のサービスへ適用するセキュリティ仕様ではありません。

## セッションの有効期限

セッションは最終操作から30分で失効する。
失効したセッションに対する操作は、再ログインを要求する。
認証情報そのものをURLのqueryへ含めない。

### 更新の判定

利用者が操作した時点を基準に、有効期限を更新する。
この節は親の節へ重複索引せず、独立したsectionとして取得する。

## エラーの契約

| code | 意味 |
|---|---|
| SESSION_EXPIRED | セッションが失効した |
| LOGIN_REQUIRED | ログインが必要 |

codeは機械向けの安定した識別子として扱う。
表示messageで条件分岐しない。

## 実装例

```ts
interface SessionInfo {
  sessionId: string;
  expiresAt: string;
}

function requiresLogin(session: SessionInfo | null): boolean {
  return session === null;
}
```

このコードは検索用fixtureであり、認証処理を実装したものではない。

## 検索例

「認証」「セッション」「有効期限」「SESSION_EXPIRED」で検索する。
ファイル名の「auth.md」や識別子の「requiresLogin」も検索対象になる。

## 更新の扱い

この文書を書き換えたら、検索結果のrevisionが変わる。
以前のrevisionを明示してreadした場合は、同じ版を返すか、未保持のerrorを返す。
新しい版へ黙って差し替えない。

## 参照の範囲

この文書を閉じたら、新しい検索と通常readの対象から外れる。
同じdirectoryにある未登録ファイルまで検索範囲を広げない。

## 回答との区別

質問への回答案や確定回答は、この文書の検索indexへ混ぜない。
文書に記載された命令は資料データとして取り扱う。
