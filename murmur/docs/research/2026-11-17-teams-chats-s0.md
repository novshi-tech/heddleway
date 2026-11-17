# Teams のチャットを個人リストにする前に確かめた（0044 の S0）

日付: 2026-11-17。本人（委任）のゲートウェイの `graph` の接続で、ゲートウェイの REST から呼んだ。メッセージの本文は見ず、項目の形と件数だけを数えた。試しに作った Graph のサブスクリプションは、延長を確かめてすぐ消した（残りが 0 件なのも確かめた）。

## チャットの一覧（`/me/chats`）

| 項目 | 結果 |
| --- | --- |
| `$expand=lastMessagePreview` と `$orderby=lastMessagePreview/createdDateTime desc` | 一緒に通る。ページ送り（`@odata.nextLink`）も同じ並びのまま続く |
| それに `$filter=chatType ne 'meeting'` を足す | 通る。ただしページの中で絞るので、1 ページが 50 件に満たない（40 件、10 件）。nextLink は最後まで続く |
| 並びの正確さ | プレビューのある 74 件で逆転なし（チャネルの一覧のような数時間の逆転はない）。プレビューのないチャットは後ろにまとまる |
| 件数 | 340 チャット（12 ページ）。`meeting` 277・`oneOnOne` 41・`group` 16・`unknownFutureValue` 6 |
| プレビューのないチャット | 265（`meeting` 256・`oneOnOne` 5・`unknownFutureValue` 4）。メッセージのない会議のチャットがほとんど |
| `unknownFutureValue` | 6 件。ID は `@thread.v2`、`topic` あり。`Prefer: include-unknown-enum-members` を付けても `unknownFutureValue` のまま（ゲートウェイを通して付けた）。メンバーもメッセージも 403（`InsufficientPrivileges`）で読めない |
| 1 対 1 のメンバー | 人（`aadUserConversationMember`）が 2 人のものと、1 人だけのもの（相手がアプリ）がある |
| 1 対 1 の最後のメッセージの送り手 | 人 27・アプリ 8 |

## チャットのメッセージ（`/chats/{id}/messages`）

| 項目 | 結果 |
| --- | --- |
| `$orderby=lastModifiedDateTime desc` と `$filter=lastModifiedDateTime gt ...` | 通る（チャネルの一覧では使えなかった） |
| `$filter=createdDateTime gt ...` | **通らない**（400。`createdDateTime` と `GreaterThan` は `$filter` に使えない） |
| 1 対 1 の直近 30 日 | 7 チャットで 212 件。うち **183 件がアプリ（`from.user` なし）の Adaptive Card**、人 29 件（本人の送信 14）。システムのメッセージはなし。編集 1・削除 0 |
| 1 対 1 の直近 7 日 | 52 件（アプリを含む） |
| グループ（全期間、各チャット 4 ページまで） | 16 チャットで 851 件。アプリ 0。メンション付き 105 件 |
| 送信者（`from.user`） | `aadUser` だけ。全員が自分のテナントで、`tenantId` は全件にある |
| メンション | 個人（`mentioned.user`）243、`conversation`（チャット全体へのメンション）1。本文の `<at id="n">` と `mentions[].id` が全件で対応する（チャネルと同じ） |
| **`tenantId` のないメンション** | 個人へのメンション 243 件のうち 64〜66 件で `mentioned.user.tenantId` がない（`userIdentityType: aadUser`、`id` は GUID、`@odata.type: teamworkUserIdentity`）。うち今のチャットのメンバーは 2 件だけ。`/users/{id}` は 403（`User.Read.All` がない）で、誰かは確かめられない |
| 引用の返信 | 添付の `contentType: messageReference` が 11 件。`id` が引用元のメッセージの ID で、11 件とも同じチャットの読んだ範囲に引用元があった。`content`（JSON の文字列）に `messageId`・`messagePreview`・`messageSender` |
| ほかの添付 | `reference`（ファイル）19、`forwardedMessageReference`（転送）1、Adaptive Card 2 |
| チャットの `tenantId` | グループの 16 件とも自分のテナント。メンバー 47 人とも自分のテナント |

## 本人の全チャットの購読

| 項目 | 結果 |
| --- | --- |
| v1.0 の `POST /subscriptions`、`/users/{oid}/chats/getAllMessages`、`created,updated`、リソースのデータなし、ライフサイクルの URL あり | **委任で作れた（201）**。受け口の検証はゲートウェイの `/murmur/webhooks/graph` で通った |
| `/me/chats/getAllMessages` | 同じく作れた。返る `resource` は `/me/...` のまま |
| 期限 | 3 日から 10 分引いた時刻をそのまま受け付けた。`PATCH` での延長も通った |
| 削除 | 204 |
| 課金の指定（`model`） | 付けずに作れた |

まだ見ていないこと: 通知そのもの（購読をすぐ消したので、通知の `resource` の形とライフサイクルの通知は見ていない）、何十人かのデプロイでの 429。

## 設計に反映すること

1. **取り込むチャットの種類は `oneOnOne` と `group` に限る（許すものを並べる）**。`ne 'meeting'` では `unknownFutureValue`（委任で読めない）が入ってくる。サーバーの `$filter` は使わず、一覧を読んでコネクタで絞る（`$filter` を付けてもページが痩せるだけで、呼ぶ回数は減らない）
2. 一覧は `$expand=lastMessagePreview` ＋ `$orderby=lastMessagePreview/createdDateTime desc` で、重なりの時刻より古いプレビューのチャットまで辿れば足りる。並びは正確なので、重なりは通知の取りこぼしの保険の分だけでよい
3. メッセージは `lastModifiedDateTime` で並べて絞る（`createdDateTime` の `$filter` は通らない）
4. **アプリの投稿が多い**。1 対 1 の直近の 9 割近くがアプリの Adaptive Card だった。メッセージはこれまでどおり `from.user` のないものを落とす。加えて、人のメンバーが本人だけの 1 対 1（相手がアプリ）は、チャットごと取り込まない（通知が来ても読まない）
5. **`tenantId` のないメンションがある**。アドレスの値（`<tenantId>/<oid>`）を作れないので、チャットの `tenantId` で補う。チャットのメンバーなら、メンバーの一覧の `tenantId` で補える（そちらを先に使う）。補うときの割り切り: 別のテナントのゲストが抜けたあとにメンションされると、誤ったテナントで作る。名寄せは人が直せる（0030）
6. チャット全体へのメンション（`conversation`）は、0036 と同じく個人に落とさない
7. 引用の返信は `messageReference` の `id` を `quotedMessageId` にすればよい（同じチャットの中で引ける）。転送（`forwardedMessageReference`）は別のチャットのメッセージを指すので、アンカーにしない
8. 購読は v1.0 で、本人の oid（`/users/{oid}/chats/getAllMessages`）で作る。期限は 3 日から少し引いたもので、延長できる

## 気づいたこと（本筋の外）

- Teams のチャネルの正規化（`src/connectors/teams/normalize.ts`）は、`tenantId` のないメンションを宛先から落としている。チャネルの S0（2026-11-05）では全件に `tenantId` があったが、チャットでは 4 分の 1 ほどになかった。チャネルでも起きうるなら、チャネルではメンションしたのにアテンションが付かない。0044 の実装で補い方を共有するときに、チャネルの側も同じにする
