# To Do(タスク)

例の `$GW` は このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)。パスはすべて `/v1.0` から書く。権限は `Tasks.ReadWrite`(本人のタスクだけ。ほかの人のタスクや Planner は触れない)。

トピック索引で追う To Do のタスク(`topic-index` スキルの「To Do のタスクで追う」)は、ここで作ったあと、すぐトピック索引に `record_sent` で記録する。

## ID は「変わらない ID」で扱う

To Do のタスクには ID が 2 種類ある。何も付けずに呼ぶと長い ID(150 文字ほど。`AAMk...` で始まる)が返り、ヘッダー `Prefer: IdType="ImmutableId"` を付けて呼ぶと短い「変わらない ID」(70 文字ほど。`AAkALgAAAAAA...` で始まる)が返る。同じタスクでも 2 つは別の文字列。

**トピック索引は変わらない ID でタスクを覚えている。** 長い ID を `record_sent` の `sent_ref` に渡すと、同じタスクがトピック索引で 2 つのトピックに分かれる(記録のトピックと、To Do からの写しのトピック)。

- タスクを作る・読む・変えるときは、いつも `-H 'Prefer=IdType="ImmutableId"'` を付ける。返ってきた `id` をそのまま `sent_ref` に使う
- `record_sent` に渡す前に、`id` が `AAkALgAAAAAA` で始まる短いものかを確かめる。`AAMk` で始まる長いものなら、ヘッダーを付けて一覧(`/tasks`)を取り直し、同じタスクの `id` を使う
- 変わらない ID をパスに入れて呼ぶときも、同じヘッダーを付ける
- タスクのリストの ID(`/lists/{list-id}`)は、どちらの呼び方でも同じ

## タスクのリスト

```sh
python3 $GW GET graph /v1.0/me/todo/lists
```

- リストの一覧は `$select` を付けると 400（`RequestBroker--ParseUri`）になる。付けずに呼ぶ(実物で確認、2026-11-08)
- `wellknownListName` が `defaultList` は既定の「タスク」、`flaggedEmails` は Outlook でフラグを付けたメール(読むだけ。ここにタスクは作らない)。
- リストを作る: `POST /v1.0/me/todo/lists`、`{"displayName": "トピック索引"}`。

## タスクの一覧と 1 件の取得

```sh
python3 $GW GET graph /v1.0/me/todo/lists/{list-id}/tasks -H 'Prefer=IdType="ImmutableId"' -q '$filter=status ne '"'"'completed'"'"'' -q '$top=50'
python3 $GW GET graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} -H 'Prefer=IdType="ImmutableId"'
```

- `status` は `notStarted` / `inProgress` / `completed` / `waitingOnOthers` / `deferred`。
- 期限は `dueDateTime`(`{"dateTime": "2026-11-20T00:00:00.0000000", "timeZone": "Tokyo Standard Time"}`)。To Do の期限は日付だけで、時刻は 0 時。
- 本文は `body`(`{"content", "contentType"}`)。元のメールなどへのリンクは `linkedResources`。

## 作成

```sh
python3 $GW POST graph /v1.0/me/todo/lists/{list-id}/tasks -H 'Prefer=IdType="ImmutableId"' --json '{
  "title": "DEV-12 の調査",
  "dueDateTime": {"dateTime": "2026-11-20T00:00:00", "timeZone": "Tokyo Standard Time"},
  "body": {"contentType": "text", "content": "要点だけ。経過はトピック索引のメモに書く"}
}'
```

- 返る `id` がタスクの ID(ヘッダーを付けたので、変わらない ID)。トピック索引に記録するときの `sent_ref` に使う。
- 名前と期限は作る前にユーザーに確かめる。期限は課題の期日と違ってよい(自分の段取りの日付)。
- 本文には経過を書き足していかない(経過はトピック索引のメモ)。

## 更新・完了・削除

```sh
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} -H 'Prefer=IdType="ImmutableId"' --json '{"dueDateTime": {"dateTime": "2026-11-25T00:00:00", "timeZone": "Tokyo Standard Time"}}'
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} -H 'Prefer=IdType="ImmutableId"' --json '{"status": "completed"}'
python3 $GW PATCH graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} -H 'Prefer=IdType="ImmutableId"' --json '{"status": "notStarted"}'
python3 $GW DELETE graph /v1.0/me/todo/lists/{list-id}/tasks/{task-id} -H 'Prefer=IdType="ImmutableId"'
```

- 完了・再開・期限の変更は、ユーザーに確かめてから。トピック索引には写しで戻るので、別に記録しなくてよい。
- 削除は戻せない。完了で足りるなら完了にする。
