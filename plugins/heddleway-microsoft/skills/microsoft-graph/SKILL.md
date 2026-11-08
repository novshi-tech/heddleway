---
name: microsoft-graph
description: Microsoft Graph API(Microsoft 365)を API ゲートウェイ経由で操作する。Outlook メールの検索・取得・送信・返信と添付ファイルの保存、OneDrive / SharePoint のファイル検索・一覧・ダウンロード・アップロード、Teams のチャネルとチャットのメッセージ、予定表の予定の確認・作成・更新・招待への応答、To Do のタスクの確認・作成・更新・完了を扱う。「メールを検索して」「添付の PDF を保存して」「SharePoint から請求書を探して」「OneDrive にアップロードして」「Teams に投稿して」「今週の予定を確認して」「会議を入れて」「To Do にタスクを作って」「タスクを完了にして」などの依頼で使う。
---

# Microsoft Graph API

Microsoft Graph を、API ゲートウェイ経由で呼び出す。トークンの発行とスクリプトの基本的な使い方は、`heddleway` スキルに従う。

## 手順

1. `heddleway` スキルの手順で、サービス `graph` の認証情報を選んでトークンを発行し、`GW_TOKEN` と `GW_BASE_URL` を設定する。
   - `graph` は OAuth のサービスで、ユーザーがゲートウェイの画面で Microsoft アカウントを接続する。上流のトークンはゲートウェイが注入・更新するので、Claude は扱わない。
2. 使うエンドポイントを、下の表のリファレンスで探す。見出しは `## ` で始まるので、`grep -n "^## " references/mail.md` で見出しを一覧してから、必要な節だけ読む。
3. スクリプトで呼び出す。
   - 1 件の取得や、送信・登録・更新、ファイルのダウンロードとアップロード: このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)
   - 一覧の全件取得: `scripts/graph_all.py`(`@odata.nextLink` をゲートウェイ経由でたどる)

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 $GW GET graph /v1.0/me -q '$select=displayName,mail'
python3 $GW GET graph /v1.0/me/messages -q '$search="請求書"' -q '$select=id,subject,from,receivedDateTime,hasAttachments' -q '$top=10'
python3 $GW GET graph /v1.0/drives/{drive-id}/items/{item-id}/content -o invoice.pdf
python3 ${CLAUDE_SKILL_DIR}/scripts/graph_all.py /v1.0/me/mailFolders/inbox/messages -q '$select=id,subject,receivedDateTime' -q '$top=100' -o inbox.json
```

## API の要点

- パスは `/v1.0/...` から書く(ゲートウェイのサービス `graph` の上流は `https://graph.microsoft.com`)。自分のデータは `/v1.0/me/...`。
- クエリは OData 形式: `$select`(項目の絞り込み、指定を推奨)、`$filter`、`$orderby`、`$top`、`$search`、`$expand`。`$` を含む引数はシングルクォートで囲む。
- 一覧は `{"value": [...], "@odata.nextLink": "..."}`。`@odata.nextLink` は `https://graph.microsoft.com/...` の絶対 URL なので、直接呼ばない。全件が要るときは `graph_all.py` を使う(パスとクエリをゲートウェイに付け替える)。
- OneDrive / SharePoint のファイル本体(`.../content`)は、事前認証済みの一時 URL への 302 が返る。`gw_request.py -o` はリダイレクトを追い、リダイレクト先にはゲートウェイのトークンを送らない。
- メールの添付ファイルは `.../attachments/{id}/$value` で本体を取れる。`contentBytes`(base64)を会話に出さない。

## リファレンス

| やりたいこと | ファイル |
|---|---|
| メールの検索・取得・送信・返信、添付ファイル | [references/mail.md](references/mail.md) |
| OneDrive / SharePoint のファイル検索・一覧・ダウンロード・アップロード・共有 | [references/files.md](references/files.md) |
| 予定表の予定、招待への応答 | [references/calendar.md](references/calendar.md) |
| To Do のタスクのリスト・タスクの作成・更新・完了 | [references/todo.md](references/todo.md) |
| Teams のチャネル・チャットのメッセージ | [references/teams.md](references/teams.md) |
| ページング、OData クエリ、エラー、スロットリング、`$batch` | [references/common.md](references/common.md) |

## 権限

ゲートウェイの `graph` には、次の委任アクセス許可が付いている: Files.ReadWrite.All、Sites.ReadWrite.All、Mail.ReadWrite、Mail.Send、Calendars.ReadWrite、Chat.ReadWrite、ChannelMessage.Send、ChannelMessage.Read.All、ChannelMember.Read.All、Team.ReadBasic.All、Channel.ReadBasic.All、Tasks.ReadWrite、User.Read。

- Planner、連絡先、ユーザーやグループの管理などは、この範囲にないので使えない。頼まれたら、使えないことを伝える。
- 権限の範囲内でも、テナントの設定やファイル・チャネルの権限で 403(`ErrorAccessDenied`、`accessDenied` など)になることがある。

## 制限と注意

- スロットリングは 429 と `Retry-After`(秒)で返る。固定の上限はないので、待ってから再試行する。大量の取得は `graph_all.py` を使い、結果をファイルに保存して使い回す。
- ゲートウェイ自身のエラーは `{"error": "..."}`、Graph のエラーは `{"error": {"code": "...", "message": "..."}}` の形。見分け方は [references/common.md](references/common.md)。
- メールの送信・返信、Teams への投稿、予定の作成・変更・削除(参加者に通知が飛ぶ)、To Do のタスクの完了・削除、ファイルの上書き・削除・共有は、実行前に宛先と内容をユーザーに確認する。
- ファイルやメールの本文・添付を会話に貼らない。スクリプトでファイルに保存し、必要な部分だけ読む。
