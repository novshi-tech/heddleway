---
name: google-chat
description: Google Chat のスペース・DM の一覧、メンバーの確認、メッセージの検索・取得、スペースやスレッドへの投稿・返信を Heddleway 経由で行う。「Google Chat のスペースを一覧して」「このスペースの最近のやりとりを見せて」「スレッドに返信して」「DM を送って」など、ゲートウェイに登録された Google アカウントの Google Chat を操作する依頼で使う。トピック索引のトピックに返事を投稿するときも使う(投稿したあとはすぐ topic-index スキルで記録する)。
---

# Google Chat API

`heddleway` スキルでサービス `chat` の認証情報を選び、`issue_token` が返した `token` / `base_url` を `GW_TOKEN` / `GW_BASE_URL` に設定する。上流の Google トークンはゲートウェイが管理する。ホストやアカウント名を固定しない。

接続はサービスごとに 1 つ。複数の組織のゲートウェイがつながっていれば、`heddleway` スキルの「コネクタの選び方」で組織のコネクタを選ぶ。Gmail / Tasks の認証情報とは別に選ぶ。

権限はスペース・メンバー・メッセージの読み取りと、メッセージの投稿(`chat.spaces.readonly`・`chat.memberships.readonly`・`chat.messages.readonly`・`chat.messages.create`)。メッセージの編集・削除、リアクション、スペースの作成・メンバーの追加はできない。本人がメンバーのスペース・DM だけが見える。

## 呼び出す

単発の取得・投稿は共通の `gw_request.py`、一覧のページングは `scripts/chat_all.py` を使う。Python 標準ライブラリだけで動く。

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 "$GW" GET chat /v1/spaces -q pageSize=1000 -q 'filter=spaceType = "SPACE"'
python3 "$GW" GET chat /v1/spaces/{space}/messages -q pageSize=100 -q orderBy="createTime desc"
python3 "${CLAUDE_SKILL_DIR}/scripts/chat_all.py" /v1/spaces/{space}/members --key memberships -q pageSize=1000 -o members.json
```

- パスは `/v1/...`。スペースの名前は `spaces/{ID}`、メッセージは `spaces/{ID}/messages/{ID}`、スレッドは `spaces/{ID}/threads/{ID}` で、API はこの `name` をそのままパスに使う(`GET /v1/spaces/AAA/messages/BBB`)。
- 一覧は `nextPageToken` を `pageToken` に渡して続ける。`chat_all.py` は `spaces`・`messages`・`memberships`(メンバーは `--key memberships`)を JSON 配列か CSV に保存する。`--max-pages` 到達の警告があれば全件取得と報告しない。
- ユーザーの認証で読んでも、送り手・メンバー・メンションに表示名(`displayName`)とメールアドレス(`email`)が入る(ドキュメントには入らないとあるので、ないときは `users/{ID}` のまま扱う)。人とアプリは `type`(`HUMAN`・`BOT`)で分かる。

## 詳細

スペースと DM の探し方、メッセージの検索、スレッドの読み方、投稿・スレッドへの返信・メンションの書き方、トピック索引への記録: [references/chat.md](references/chat.md)。

## 実行範囲とエラー

投稿はユーザーの依頼の範囲で行い、送る前に宛先のスペース(スレッドなら、どのスレッドか)と本文をユーザーに確かめる。明示的に本文と宛先を指示された投稿に、重ねて承認を求めない。エージェント自身が投稿を提案するときは、実行の前に必ず確認する。投稿がタイムアウトした場合は、同じ `requestId` を付けて送り直す(二重に投稿されない。下の reference)。

403 は Google のエラー本文を確認する(メンバーでないスペース、権限の足りない操作)。どのスペースでも 404 になるときは、ゲートウェイの Google Cloud のプロジェクトに Chat アプリの構成がないことがある(管理者に伝える。デプロイの手順の Google の節)。ゲートウェイの再接続エラーは案内された URL を使う。429 / 503 の GET は付属の一覧スクリプトが上限付きで再試行する。
