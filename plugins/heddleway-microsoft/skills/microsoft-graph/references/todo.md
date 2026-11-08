# To Do(タスク)

例の `$GW` は このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)。パスはすべて `/v1.0` から書く。権限は `Tasks.ReadWrite`(本人のタスクだけ。ほかの人のタスクや Planner は触れない)。

Murmur で追うタスク(`murmur` スキルの「タスクとして追う」)は、ここで作ったあと、すぐ Murmur に `record_sent` で記録する。

## タスクのリスト

```sh
python3 $GW GET graph /v1.0/me/todo/lists -q '$select=id,displayName,wellknownListName'
```

- `wellknownListName` が `defaultList` は既定の「タスク」、`flaggedEmails` は Outlook でフラグを付けたメール(読むだけ。ここにタスクは作らない)。
- リストを作る: `POST /v1.0/me/todo/lists`、`{"displayName": "Murmur"}`。

## タスクの一覧と 1 件の取得

```sh
python3 $GW GET graph /v1.0/me/todo/lists/{list-id}/tasks -q '$filter=status ne '"'"'completed'"'"'' -q '$top=50'
python3 $GW GET graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id}
```

- `status` は `notStarted` / `inProgress` / `completed` / `waitingOnOthers` / `deferred`。
- 期限は `dueDateTime`(`{"dateTime": "2026-11-20T00:00:00.0000000", "timeZone": "Tokyo Standard Time"}`)。To Do の期限は日付だけで、時刻は 0 時。
- 本文は `body`(`{"content", "contentType"}`)。元のメールなどへのリンクは `linkedResources`。

## 作成

```sh
python3 $GW POST graph /v1.0/me/todo/lists/{list-id}/tasks --json '{
  "title": "DEV-12 の調査",
  "dueDateTime": {"dateTime": "2026-11-20T00:00:00", "timeZone": "Tokyo Standard Time"},
  "body": {"contentType": "text", "content": "要点だけ。経過は Murmur のメモに書く"}
}'
```

- 返る `id` がタスクの ID。Murmur に記録するときの `sent_ref` に使う。
- 名前と期限は作る前にユーザーに確かめる。期限は課題の期日と違ってよい(自分の段取りの日付)。
- 本文には経過を書き足していかない(経過は Murmur のメモ)。

## 更新・完了・削除

```sh
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} --json '{"dueDateTime": {"dateTime": "2026-11-25T00:00:00", "timeZone": "Tokyo Standard Time"}}'
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} --json '{"status": "completed"}'
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} --json '{"status": "notStarted"}'
python3 $GW DELETE graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id}
```

- 完了・開き直し・期限の変更は、ユーザーに確かめてから。Murmur には写しで戻るので、別に記録しなくてよい。
- 削除は戻せない。完了で足りるなら完了にする。
