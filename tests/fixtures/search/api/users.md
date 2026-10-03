# ユーザーAPI

## 一覧の取得

`GET /api/v2/users` は、登録済みのユーザーを返す。`pageSize` の既定は50。

## 1件の取得

`GET /api/v2/users/{userId}` は、指定したユーザーを返す。存在しなければ `USER_NOT_FOUND`。
