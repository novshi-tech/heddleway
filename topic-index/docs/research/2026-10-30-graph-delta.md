# Graph の delta をゲートウェイ越しに確かめた（設計の段取り S0 の一部）

日付: 2026-10-30。本人の箱（委任の `graph` の接続）で、ゲートウェイの REST から呼んだ。メールの中身は見ず、項目があるかと件数だけを数えた。

## 確かめたこと

| 項目 | 結果 |
| --- | --- |
| delta の初回の `$filter=receivedDateTime ge <時刻>` と `$select` | 通る（受信トレイ・送信済みとも 200） |
| `Prefer` がゲートウェイを素通りするか | 通る。`Preference-Applied: IdType=ImmutableId`、`outlook.body-content-type="text"` で本文はテキスト、`odata.maxpagesize` も効く |
| delta で `uniqueBody` が取れるか | 取れる |
| nextLink の続き（`https://graph.microsoft.com` を外したパスをゲートウェイに渡す） | 通る |
| 受信トレイの delta で `internetMessageHeaders` | `$select` に入れれば取れる（直近 2 週間の 50 通すべてに付いた） |
| 送信済みの `internetMessageHeaders` | **ない**。delta でも、1 通ずつの GET でも空 |
| `/me` の `proxyAddresses` | 取れる（`User.Read` の範囲） |

## 実装に反映したこと

- delta の `$select` に `internetMessageHeaders` を足し、1 通ずつヘッダーを読みに行くのをやめた

## わかった問題: 送信済みのメールに In-Reply-To がない

Outlook（メーラー）から直接返信したメールは、送信済みの側では In-Reply-To のアンカーを持たない。そのため観測された送信の区切りは、構造（返事待ちが 1 本だけ）か AI（同じ相手の直近のスレッド）で決まる。スタンドから送って `record_sent` で記録したものは、`reply_to_thread_id` で置き先が決まり、観測はそのシグナルに重なる（H5）ので困らない。

考えられる手（未決。0016 の試用で件数を見てから決める）:

1. このままにする（AI の区切りで足りるかを H6 で見る）
2. `conversationId` をアンカーに足す（同じデータソースの中だけ。0024 の正規化で「AI の区切りの質を見るため threadKey にしない」とした点の見直し）
3. 送信済みの `conversationIndex` や件名から推す

## dev で通した結果（2026-10-30 後半）

murmur-dev に個人の箱をつないで、自分宛てのメールを 1 通取り込むところまで通した。

| 項目 | 結果 |
| --- | --- |
| ゲートウェイが本体の CIMD（`/oauth/client.json`）を読めるか | 読める。同意画面に `client_name` が出る |
| 本体からゲートウェイの公開 URL（workers.dev）を `fetch` | **通らない**。コールバックのトークンの交換が 400・401 以外のエラーで落ちた（同じアカウントの workers.dev 同士。ステータスはログに残っていない）。dev に `GATEWAY_WEB`（ゲートウェイのデフォルトの入口への Service Binding）を張って通った |
| サブスクリプションの作成（受け口の検証） | 通る。つないだ直後に `validationToken` 付きの POST が 2 回（受信トレイと送信済み）来て、どちらも作れた |
| 変更通知 → キュー → delta → Ingest | 通る。通知の受け付けが 07:42:20、キューの同期が 07:42:36。スレッドが 1 本でき、向きは inbound、アンカーは messageId、`needsResponse: false`（本文に依頼がない） |

続けて、Outlook（メーラー）から同じメールに返信した（`record_sent` なし、観測だけの送信）:

| 項目 | 結果 |
| --- | --- |
| 送信済みの変更通知 → delta → Ingest | 通る。通知の受け付けが 07:52:50、キューの同期が 07:52:58 |
| 区切り | 同じスレッドに入った。`threadedBy: ai`（送信済みに In-Reply-To がないので、予想どおり AI の区切り。今回は正しかった） |
| 向き・ボール | outbound。ボールは `{kind: party, partyIds: []}` になった。相手のアドレス（seed にない人）に Party がないので、「相手待ち」なのに相手が空。誰の番（`turn`）も同じ形 |

運用で気づいたこと:

- （2026-11-04 追記）この件はブランチ側で 0029（ボールの相手側をアドレスで持つ）として一度実装したが、main の 0030（イベントはアドレスだけ、Contact はクエリ層で解決、名寄せは人とスタンド）に置き換わったので載せなかった。0030 の実装に「解決できなければアドレスのまま」が入っていなかったので、同じ日に直した（0030 の末尾の追記。ボールの `addresses`・スレッドの `counterpartAddresses`）
- seed にない相手とのやりとりでは、ボールの相手が空の配列になる。実データではこれが普通なので、Party のない相手をボールにどう出すか（アドレスをそのまま出すか、Party を作るか）を決める要る

- `last_sync_at` は全フォルダを回した同期でしか進まない（通知で受信トレイだけ回したときは進まない）。仕様どおりだが、`GET /api/connections` を見た人には「止まっている」と読める
- コールバックの `console.error(err)` は、Workers の observability ではスタックしか残らずメッセージが落ちる。原因がステータスまで追えなかった。`String(err)` やメッセージを構造化して出すほうがいい

## まだ確かめていないこと

- 委任の `reauthorizationRequired` の間隔（サブスクリプションの寿命の中で来るか）
- 下書き → 送信で `internetMessageId` が変わらないか
- 410（delta の位置が無効）の実際の形
- メーラーからの返信の区切りを件数で見る（今回の 1 件は AI で正しく入った）
