# Google Chat の操作

例の `$GW` は `python3 "${CLAUDE_SKILL_DIR}/scripts/gw_request.py"`。

## スペースと DM を探す

```sh
$GW GET chat /v1/spaces -q pageSize=1000 -q 'filter=spaceType = "SPACE"'
$GW GET chat /v1/spaces -q pageSize=1000 -q 'filter=spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"'
$GW GET chat /v1/spaces/{space}
```

- `spaceType`: `SPACE`(名前のあるスペース)・`GROUP_CHAT`(名前のないグループのチャット)・`DIRECT_MESSAGE`(1 対 1)。`filter` で絞れるのは `spaceType` だけ
- `displayName` はスペースの名前(DM にはない)。名前で探すときは一覧を取ってから絞る
- `spaceThreadingState`: `THREADED_MESSAGES` ならスレッドを使うスペース(返信はスレッドに付く)。`UNTHREADED_MESSAGES` はスレッドを使わない設定
- `lastActiveTime`: 最後にメッセージが投稿された時刻。最近動いたスペースを探すのに使える
- DM の相手は `GET /v1/spaces/{space}/members` で見る(本人と相手。アプリとの DM は `singleUserBotDm: true` か、メンバーに `type: BOT`)

## メッセージを読む

```sh
$GW GET chat /v1/spaces/{space}/messages -q pageSize=100 -q orderBy="createTime desc"
$GW GET chat /v1/spaces/{space}/messages -q pageSize=1000 -q 'filter=createTime > "2026-11-01T00:00:00+09:00"'
$GW GET chat /v1/spaces/{space}/messages -q 'filter=thread.name = spaces/{space}/threads/{thread}'
$GW GET chat /v1/spaces/{space}/messages/{message}
```

- 既定は `createTime` の古い順。新しい順は `orderBy="createTime desc"`。`pageSize` は最大 1000
- 絞り込みは `createTime`(`>`・`<`。`AND` で範囲)と `thread.name`(1 つだけ)。本文の検索はできないので、期間で取ってから絞る
- 項目: `sender`(`name` が `users/{ID}`、`type`、`displayName`)、`createTime`、`text`(素の文。メンションは `@名前`)、`thread.name`、`threadReply`(返信なら `true`。スレッドの最初のメッセージには付かない)、`annotations`(`USER_MENTION` はメンション、`userMention.user.name` が相手)、`quotedMessageMetadata.name`(引用元)、`attachment`(添付)、`lastUpdateTime`(編集)
- システムのメッセージ(メンバーの出入りなど)は一覧に出ない。スペースの「タスク」タブのタスクは読めない(公開の API にない)

## 投稿する

```sh
# スペースに新しいスレッドとして(DM でも同じ)
$GW POST chat /v1/spaces/{space}/messages -q requestId={UUID} --json '{"text": "本文"}'

# スレッドに返信する
$GW POST chat /v1/spaces/{space}/messages -q requestId={UUID} -q messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD \
  --json '{"text": "本文", "thread": {"name": "spaces/{space}/threads/{thread}"}}'
```

- **メンション**: 本文に `<users/{ID}>` と書く(`{ID}` は `users/{ID}` の数字)。スペースの全員は `<users/all>`。`@名前` と書いてもメンションにならない
- 書式: `*太字*`・`_斜体_`・`~取り消し~`・`` `コード` ``・`<https://example.com|リンクの文字>`。改行は `\n`
- `requestId`: 投稿ごとに新しい UUID を付ける。同じ `requestId` で送り直すと、二重に投稿されずに最初のメッセージが返る(タイムアウトしたときの送り直しに使う)
- `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` はスレッドが見つからなければ新しいスレッドにする。スレッドを使わないスペースでは返信にならない
- 返事の `name`(`spaces/{space}/messages/{message}`)が投稿したメッセージ。`thread.name` がスレッド

## トピック索引に記録する

トピック索引の Google Chat のリスト(スペースの共有リスト・本人の Google Chat のチャット)のトピックに返事を投稿したら、すぐ topic-index スキルの `record_sent` で記録する(「送信の記録」の「Google Chat で送った」)。

- `sent_ref` に投稿の返事の `name`(`spaces/.../messages/...`)
- スレッドに返信したら `anchors.thread_ts` にスレッドの `name`
- DM・グループで送ったら `anchors.conversation_id` にスペースの `name`(グループなら `anchors.conversation_group: true`)
- `to` は Google のアカウントの ID(`users/{ID}` の `{ID}`)。DM なら相手、スペース・グループならメンションした人

トピックの元のメッセージは、タイムラインのメッセージの `anchors.messageId`(そのまま `GET /v1/{messageId}`)、スレッドは `anchors.threadTs`。
