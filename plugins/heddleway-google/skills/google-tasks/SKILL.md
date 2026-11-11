---
name: google-tasks
description: Google Tasks のタスクのリストの一覧、タスクの検索・取得・作成・更新・完了・再開・削除・移動(サブタスク化)を Heddleway 経由で行う。「Google Tasks にタスクを作って」「タスクを完了にして」「期限を変えて」など、ゲートウェイに登録された Google アカウントのタスクを操作する依頼で使う。トピック索引で追うタスクを作るときも使う(作ったあとはすぐ topic-index スキルで記録する)。
---

# Google Tasks API

`heddleway` スキルでサービス `tasks` の認証情報を選び、`issue_token` が返した `token` / `base_url` を `GW_TOKEN` / `GW_BASE_URL` に設定する。上流の Google トークンはゲートウェイが管理する。ホストやアカウント名を固定しない。

接続はサービスごとに 1 つ。複数の組織のゲートウェイがつながっていれば、`heddleway` スキルの「コネクタの選び方」で組織のコネクタを選ぶ。Gmail / Calendar の認証情報とは別に選ぶ。

権限は `tasks` と `userinfo.email`(本人のタスクのリストとタスクの読み書き。ほかの人のタスクは触れない)。

## 呼び出す

単発の取得・作成・更新は共通の `gw_request.py`、リストやタスクの一覧のページングは `scripts/tasks_all.py` を使う。Python 標準ライブラリだけで動く。

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 "$GW" GET tasks /tasks/v1/users/@me/lists
python3 "${CLAUDE_SKILL_DIR}/scripts/tasks_all.py" /tasks/v1/lists/{tasklist}/tasks -q maxResults=100 -o tasks.json
python3 "$GW" GET tasks /tasks/v1/lists/{tasklist}/tasks/{task}
```

- パスは `/tasks/v1/...`。Google の `items` 配列と `nextPageToken` を使う。`tasks_all.py` はリストとタスクの一覧を JSON 配列または CSV に保存する。
- `maxResults` は最大 100(タスクの既定は 20)。`gw_request.py` で 1 ページずつ取るなら、`nextPageToken` を `pageToken` として同じ条件で渡す。`tasks_all.py` は `-q maxResults=100` を付けて呼ぶと呼び出しが減る。
- `--max-pages` 到達の警告があれば全件取得と報告しない。

## 詳細

リスト・タスクの一覧と絞り込み、作成、更新、完了・再開、削除、移動: [references/tasks.md](references/tasks.md)。

## 実行範囲とエラー

タスクの作成・更新・完了・削除はユーザーの依頼の範囲で行う。リストや対象のタスクが曖昧なら確認する。作成がタイムアウトした場合は、作成済みか一覧で確かめてから再試行する(無条件に再送しない)。

403 は Google のエラー本文を確認する。ゲートウェイの再接続エラーは案内された URL を使う。429 / 503 の GET は付属の一覧スクリプトが上限付きで再試行する。
