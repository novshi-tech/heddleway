# タスクのリストとタスク

例の `$GW` は このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)。サービス名は `tasks`、パスは `/tasks/v1` から書く。上流のホストは `www.googleapis.com`(ゲートウェイが付ける)。

トピック索引で追うタスク(`topic-index` スキルの「タスクで追う」)は、ここで作ったあと、すぐトピック索引に `record_sent` で記録する(`sent_ref` は作ったタスクの `id`)。

## タスクのリスト

```sh
python3 $GW GET tasks /tasks/v1/users/@me/lists
```

- `id` と `title` が要る。`maxResults` は最大 100(既定 20)。足りなければ `nextPageToken` で続ける。
- 既定のリストは `@default` でも指せる(`/tasks/v1/lists/@default/tasks`)。トピック索引につないだリストを指すときは、`id` を使う。
- リストを作る: `POST /tasks/v1/users/@me/lists`、`{"title": "トピック索引"}`。

## タスクの一覧と 1 件の取得

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/tasks_all.py" /tasks/v1/lists/{tasklist}/tasks -q maxResults=100 -q showCompleted=false -o open.json
python3 $GW GET tasks /tasks/v1/lists/{tasklist}/tasks/{task}
```

一覧の主なクエリ:

- `showCompleted`(完了を含めるか。既定 `true`)。**Google の標準の画面で完了にしたタスクは、`showHidden=true` も付けないと出ない**(完了したものは隠れる)。完了を探すときは両方付ける
- `showHidden`(隠れたタスクを含める。既定 `false`)、`showDeleted`(削除済みを含める。既定 `false`)
- `updatedMin`(RFC 3339 の時刻。それ以降に変わったものだけ)
- `dueMin` / `dueMax`(期限の範囲)、`completedMin` / `completedMax`(完了の時刻の範囲)
- `maxResults`(最大 100)、`pageToken`(前のページの `nextPageToken`)

タスクの主な項目:

- `id`、`title`、`notes`(メモ)、`status`、`due`、`completed`(完了の時刻)、`parent`(親のタスクの `id`)、`position`、`updated`、`links`
- `status` は `needsAction`(未完了)か `completed`。ほかの値はない
- **`due` は日付だけ**。`2026-11-20T00:00:00.000Z` の形で送る。時刻の部分は Google が捨てる(読み出しも 0 時で返る)。時刻つきの期限は持てない
- `links` に元のメールなどへのリンクが付くことがある(読むだけ)

## 作成

```sh
python3 $GW POST tasks /tasks/v1/lists/{tasklist}/tasks --json '{
  "title": "DEV-12 の調査",
  "due": "2026-11-20T00:00:00.000Z",
  "notes": "要点だけ。経過はトピック索引のメモに書く"
}'
```

- 返る `id` がタスクの ID。トピック索引に記録するときの `sent_ref` に使う。
- `title` だけで作れる(`notes`・`due` は省ける)。サブタスクとして作るなら、クエリに `parent={親の task id}` を付ける(`previous` で兄弟の中の位置も決められる)。
- 名前と期限は作る前にユーザーに確かめる。期限は課題の期日と違ってよい(自分の段取りの日付)。
- `notes` には経過を書き足していかない(経過はトピック索引のメモ)。

## 更新・完了・再開・削除

```sh
python3 $GW PATCH tasks /tasks/v1/lists/{tasklist}/tasks/{task} --json '{"title": "DEV-12 の調査と報告", "due": "2026-11-25T00:00:00.000Z"}'
python3 $GW PATCH tasks /tasks/v1/lists/{tasklist}/tasks/{task} --json '{"status": "completed"}'
python3 $GW PATCH tasks /tasks/v1/lists/{tasklist}/tasks/{task} --json '{"status": "needsAction"}'
python3 $GW DELETE tasks /tasks/v1/lists/{tasklist}/tasks/{task}
```

- 更新は `PATCH`(送った項目だけ変わる)。`PUT` は全体の置き換えなので使わない。
- 完了・再開・期限の変更は、ユーザーに確かめてから。トピック索引には写し(最大 5 分の遅れ)で戻るので、別に記録しなくてよい。
- 削除は戻せない(トピック索引では閉じた扱いになる)。完了で足りるなら完了にする。
- 完了済みのタスクを複数まとめて隠すクリア(`POST /tasks/v1/lists/{tasklist}/clear`)は、ユーザーの依頼がなければ使わない。

## 移動(順番・サブタスク)

```sh
python3 $GW POST tasks "/tasks/v1/lists/{tasklist}/tasks/{task}/move?parent={親の task id}&previous={直前の task id}"
```

- `parent` を付けるとそのタスクのサブタスクになり、省くと先頭の階層に戻る。`previous` は同じ階層で直前に置くタスク(省くと先頭)。`destinationTasklist` で別のリストへ移せる。
- サブタスクは、トピック索引では親とは別の 1 つのタスクとして写る(親子は写らない)。
