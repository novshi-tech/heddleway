# Teams のチャネルと Jira のプロジェクトを共有リストにする前に確かめた（0036・0037 の S0）

日付: 2026-11-05。本人（委任）のゲートウェイの接続（`graph`・`jira`）で、ゲートウェイの REST から呼んだ。メッセージと課題の中身は見ず、項目の形と件数だけを数えた。試しに作った Graph のサブスクリプションはすぐ消した。

## Teams（標準チャネル 1 つ）

| 項目 | 結果 |
| --- | --- |
| 参加しているチームとチャネルの一覧（`/me/joinedTeams`・`/teams/{id}/channels`） | 読める（`Team.ReadBasic.All`・`Channel.ReadBasic.All`） |
| チャネルのメンバーの一覧（`/teams/{id}/channels/{id}/members`） | **読めない（403）**。`ChannelMember.Read.All`（か `Group.Read.All` など）が要る。ゲートウェイの `graph` の権限にない |
| メッセージの一覧（`/messages`） | 読める（`ChannelMessage.Read.All`）。返すのは投稿（`replyToId` が null）だけ。`$expand=replies` で返信も付く（19 件の返信も全部付いた） |
| 一覧の並び | 最後に動いた順（返信の時刻を含む）に近いが、数時間の逆転がある。厳密な順ではない |
| 投稿の `lastModifiedDateTime` | **返信が付いても動かない**（返信は 11/05、投稿の更新は 11/04 のまま） |
| delta（`/messages/delta?$filter=lastModifiedDateTime gt ...`） | 通る。nextLink → deltaLink の形。ただし**返信を含まない**（投稿の作成・編集だけ） |
| 返信（`/messages/{id}/replies`） | 読める |
| 変更通知（`/teams/{t}/channels/{c}/messages`、`created,updated`、リソースのデータなし） | **委任で作れた**。期限 3 日をそのまま受け付けた。受け口の検証はゲートウェイの `/murmur/webhooks/graph` で通った |
| 送信者（`from.user`） | `id`（Entra のオブジェクト ID）・`displayName`・`tenantId`・`userIdentityType: aadUser`。直近 2 か月の 122 件はすべて同じテナント |
| メンション（`mentions[].mentioned`） | 18 件すべて個人（`user`。`id`・`displayName`・`tenantId`）。本文（HTML）に `<at id="n">` で埋まっていて、`mentions[].id` と対応する。チャネル・タグへのメンションはこのチャネルにはなかった（`conversation`・`tag` のキーはあり、値が null） |
| 本文 | `contentType: html`。添付・システムメッセージはこの範囲になかった |
| 流量 | 9/1〜11/5 で投稿 50・返信 73 |

## Jira（チーム管理型の業務プロジェクト 1 つ）

| 項目 | 結果 |
| --- | --- |
| プロジェクトの閲覧の権限を持つ人（`/user/permission/search?permissions=BROWSE_PROJECTS&projectKey=...`） | 読める。22 件 = 人（`atlassian`）7・アプリ（`app`）15。ゲストはなし。メールアドレスが見えるのは 6 件だけ（推測で対応を付けない 0037 の決定 2 のとおり、`myself` で付ける） |
| セキュリティレベル（`/project/{key}/securitylevel`） | 0 件。`level is not EMPTY` の課題も 0 件 |
| 流量 | 30 日で更新 85 件、未完了 31 件 |
| `search/approximate-count` | POST で使える（GET は 401） |

## 設計に反映すること

1. ゲートウェイの `graph` の権限に `ChannelMember.Read.All`（管理者の同意が要る）を足す。足すと各利用者は `graph` の接続をつなぎ直す
2. 返信の差分は delta では取れない。投稿の一覧（`$expand=replies`）を新しい順に読み、最後に動いた時刻（投稿と返信の時刻の大きいほう）が前回の同期より十分古い（重なりを 1 日取る）ページまで辿る。返信の多いスレッドは `/replies` で取り直す。投稿の作成・編集は delta でも取れるが、一覧の走査で足りる
3. 通知は期限 3 日まで取れる（Outlook と同じ扱いでよい）。中身は使わず、通知のたびに上の走査をする
4. 読者の対応: 送信者・メンションの `user.id` が Entra のオブジェクト ID で、ゲートウェイの User ID（`entra_<tenant>_<oid>`）とそのまま対応が付く。アドレスの値は `<tenantId>/<oid>` にしておくと、別のテナントのゲストが来ても衝突しない
5. Jira の読者からアプリのアカウント（`accountType: app`）を外す。セキュリティレベル付きの課題を除く条件は、0 件でも入れておく

## 気づいたこと（本筋の外）

- 本人の箱に、10/30 に dev で試したときの Outlook のサブスクリプション（通知先 `murmur-dev.nose-0d2.workers.dev`）が 2 本残っている。murmur-dev が延長し続けているなら、dev を止めるか消す
