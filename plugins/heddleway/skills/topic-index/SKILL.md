---
name: topic-index
description: Heddleway のトピック索引(メール(Outlook・Gmail)・Teams・Jira・To Do・Google Tasks などのやりとりをトピックにまとめ、誰の番かを追う機能。プロトタイプ)を API ゲートウェイ経由で読み書きする。自分のタスク(自分の番のトピック)、トピックの経過、割当待ち・返事待ち・期限超過の確認、トピックを担当する・手放す・引き継ぐ、アテンションを外す(目を通した)、着手したものを To Do / Google Tasks のタスクとして作って結び、1 つのタスクで追う(実装・レビュー・修正のループ、エージェントとしての参加)、個人リストのトピック(To Do / Google Tasks のタスク・本人のメール)にメモ(経過)を書く、トピック同士を結ぶ、片付け・再開・振り分けの直し、そして外へ送った・起票した直後の送信の記録(record_sent)を扱う。「今日やることは?」「自分のタスクを見せて」「自分宛てのものは?」「割当待ちは?」「返事が来てないものは?」「目を通した」「この件は私が担当する」「この件を To Do(Google Tasks)にして結んで」「このメールにメモして」「この課題に着手する」「このタスクの経過を見せて」「さっきの返信を記録して」「振り分けが違う」などの依頼で使う。外へ送るときは、送信のスキルで送ったあと必ずこのスキルで記録する。
---

# トピック索引

トピック索引は Heddleway(API ゲートウェイ)の機能で、ゲートウェイの上流サービス `murmur` として登録されている(`murmur` は内部の名前。ユーザーには「トピック索引」と言う)。デプロイによっては無効になっている。トークンの発行とスクリプトの基本的な使い方は、同じプラグインの `heddleway` スキルに従う。

トピック索引は、メール(Outlook・Gmail)・Teams・Slack・LINE・Jira・To Do・Google Tasks などのやりとりを**トピック**にまとめて、誰の番かを追う索引。トピックの中身はソース(メールボックス・チャネル・課題など)にあり、索引は写しを持つだけで、管理はしない。トピックのうち、自分が担当か、自分への**アテンション**が残っているものが、自分の**タスク**(自分の番)になる。

## 言葉

ユーザーには左の列の言葉で話す。API の名前は、ユーザーが聞いたときだけ出す。

| 言葉 | 意味 | API |
| --- | --- | --- |
| トピック | 索引の 1 項目。アクションアイテムの候補になる会話。ソース(メールのやりとり・Teams の投稿・Jira の課題・To Do / Google Tasks のタスクなど)から写したもので、メッセージ・メモ・操作が時刻順に並ぶ。FYI のメールや雑談のように、タスクでないものも入る | `thread`(`thread_id`・`/threads`) |
| タスク(自分のタスク) | トピックのうち、担当が自分か、自分へのアテンションが残っているもの。自分の番 | `filter=my_turn`・`myTurn` |
| To Do のタスク / Google Tasks のタスク | ソースが To Do か Google Tasks のトピック(どちらを使うかは組織による)。作る・期限を変える・完了にするのは、そのアプリの側で。以下、2 つをまとめて言うときは「タスクのサービス」と書く | チャネル `todo`・`filter=mine` |
| メッセージ | トピックに入るメール 1 通・投稿 1 つ・コメント 1 つ | `signal` |
| リスト | ソースごとに 1 つの、トピックの入れ物。**個人リスト**(メンバーが本人 1 人。本人の Outlook / Gmail・本人の To Do / Google Tasks のリスト)と**共有リスト**(Jira のプロジェクト・Teams のチャネル・共有メールボックスなど)の 2 つだけ | `data_source`・`list_id`(どちらも同じリストを指す) |
| メンバー | そのリストのトピックが見える人(トピック索引のユーザー) | `ListMember`・`userId` |
| 担当 | このトピックを進める人。Jira などはソースの担当者、それ以外の共有リストは担当する操作(`claim`)で決まる | `assignee` |
| アテンション | 宛先から溜まる「少なくとも見てほしい」の印。宛先に入った人に付き、外すまで残る。既読・未読とは連動しない | `attention`(`named`・`list`) |
| アテンションを外す | 読んで、対応が要るか FYI かを決めたときにする操作 | `acknowledge` |
| 割当待ち | 共有リストで担当が決まっていないトピック | `triage` |
| 返事待ち | こちらから送って、メンバーでない相手(お客さんなど)へのアテンションが残っているトピック | `awaiting` |
| 返事の期限・期限超過 | 送ったときに決めた返事の期限と、それを過ぎたもの | `reply_expected_by`・`overdue` |
| メモ | 人とエージェントが個人リストのトピックに書く経過の記録 | `note` |
| 結ぶ | 関係するトピック同士をリンクでつなぐ。親子ではなく対等 | `links` |
| 写し | ソースの状態(完了・担当者・件名・期限・状態の名前)をトピックに写したもの | `source`・`closedAtSource` |
| 連絡先 | チームで共有する連絡の相手(人か会社の窓口かは区別しない) | `contact` |

**トピック索引は外に何も書かない。** メール・LINE・Slack の送信や Jira の起票は、それぞれのスキル(gmail・microsoft-graph・google-tasks など)でユーザーの確認を取ってから送り、送った直後に `record_sent` で事実を記録する。トピック索引がするのは、どのトピックに入れるかと、担当・アテンションを機械的に追うことだけ。対応が要るのか FYI かは判断しない(アテンションが付いた人が読んで決める)。何をするか・どのトピックを結ぶかは、ユーザーとあなた(エージェント)が決める。

## 手順

1. 作業する組織のコネクタを選ぶ(`heddleway` スキルの「コネクタの選び方」)。トピック索引は組織(チーム)ごとに 1 つで、その組織のゲートウェイの上流になっている。組織の分からない「自分のタスク」は、`identity:murmur` を持つコネクタが 2 つ以上あれば、どの組織のものかを聞くか、組織ごとに分けて見せる。
2. そのコネクタの `list_credentials` に `identity:murmur` があることを確かめる(表示名は「トピック索引(サインイン中のユーザー)」)。ユーザーが登録するものはない。ゲートウェイが、サインイン中のユーザーとして本体に伝える。
3. 同じコネクタの `issue_token` に `identity:murmur` を渡してトークンを発行し、`GW_TOKEN` と `GW_BASE_URL` を設定する。送信に使うサービスの認証情報と一緒に発行してよい(同じ組織のコネクタのものだけ)。
4. `scripts/gw_request.py`(`heddleway` スキルのものと同じ)で呼ぶ。サービス名は `murmur`。パスは下の表のとおり(先頭に `/api` は付けない)。

```sh
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /me
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /threads -q filter=my_turn
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /threads/thr_12 -q since=2026-10-21T09:00:00+09:00
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py POST murmur /sent --json '{"data_source":"ds_support","reply_to_thread_id":"thr_12","to":["owner@example.com"],"body":"...","sent_ref":"<...@mail>"}'
```

(`${CLAUDE_SKILL_DIR}` はこのスキルのディレクトリ。Claude 以外のエージェントでは、このスキルの置き場所に読み替える)

見えるもの・できることは、ユーザー本人と同じ。見えるのは、ユーザーがメンバーになっているリストのトピックと、そこに本人が書いたメモだけ。

### 初めてつないだとき

初めてつないだユーザーは名無しで、自分の連絡先もリストもない(`GET /me` が `contact: null`・`lists: []`)。次の順に案内する。

1. 呼び方を聞いて `PATCH /me` で付ける
2. 個人リストにするものは、組織のデプロイで決まる。Microsoft 365 の組織は Outlook(`POST /connections/outlook`)と To Do(`POST /connections/todo`)、Google Workspace の組織は Gmail(`POST /connections/gmail`)と Google Tasks(`POST /connections/google-tasks`)。コネクタの `list_credentials` を見て、あるサービス(`graph` か `gmail`・`tasks`)のものだけを案内する。共有リストは、Jira のプロジェクトなら `POST /connections/jira`、Teams のチャネルなら `POST /connections/teams`(下の「Outlook をつなぐ」「Gmail をつなぐ」「To Do をつなぐ」「Google Tasks をつなぐ」「Jira をつなぐ」「Teams をつなぐ」)。トピック索引が取り込み続けるのはこの経路だけ
3. ほかの自分のアカウント(Slack・LINE など)をリストにするなら、ゲートウェイでそのサービスがつながっているか(`list_credentials`)を先に確かめ、つないだアカウントのアドレスを `identity` にして `POST /data-sources` を呼ぶ。結果の `identity.kind`:
   - `created`: 自分の連絡先を新しく作った / `bound`: チームが先に作っていた仮の連絡先(まだ本人が登録していない連絡先)が自分に結ばれた / `attached`・`already`: 自分の連絡先に付いた
   - `merge_candidate`: そのアドレスは別の仮の連絡先(`ghostContactId`)に付いている。同じ人なら、ユーザーに確かめてから `POST /contacts/{自分の contactId}/merge` で `from` に仮の連絡先を渡してまとめる
4. **共有リスト**(Jira のプロジェクト、Teams のチャネル、これから Slack のチャネル)は、スペースに 1 つ。そのスペースを読める人なら誰でもつなげ、メンバーはソースから自動で写る(Jira はプロジェクトを閲覧できる人のうち、自分の Jira をゲートウェイにつないでトピック索引を有効にした人。Teams はチャネルのメンバーのうち、このゲートウェイにサインインしたことのある人)。共有メールボックス・LINE 公式アカウントのメンバーは管理者が足す。メンバーになったリストで自分のアカウントを登録するなら `POST /lists/{list_id}/identity`
5. タスクで追うなら、タスクのサービスのリストをつなぐ(下の「To Do をつなぐ」「Google Tasks をつなぐ」)。メモ(`add_note`)は個人リストのトピックに書くので、メール(Outlook・Gmail)かタスクのサービスをつないでから使える

### Outlook をつなぐ

本人の Outlook のメールボックスを、本人だけがメンバーの個人リストとして取り込む。本人がゲートウェイの画面でトピック索引を有効にする(許可する)と、トピック索引は本人のゲートウェイの接続を読めるようになる(読むだけで、送信や書き込みはしない)。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/outlook` を呼び、`status` で分ける:
   - `authorize`: `authorize_url` をユーザーに開いてもらい、ゲートウェイの画面でトピック索引を有効にしてもらう(「トピック索引を有効にしますか?」、または OAuth の許可の画面)。終わると結果の画面が出る。終わったら `GET /connections` で確かめる
   - `choose`: Graph の接続が複数ある。`credentials` からユーザーに選んでもらい、`credential_id` を付けてもう一度呼ぶ
   - `no_credential`: ゲートウェイで Microsoft Graph をつないでから、もう一度呼ぶ
   - `connected`: つながった(`data_source`)。何度呼んでもよい
3. メールボックスのアドレスとエイリアスは自分の連絡先に付く。別の人のアドレスが混じっていると `conflict` になるので、そのまま伝える
4. 取り込むのはつないだあとに届くメールだけ(過去のメールは取らない)。届いたメールは、FYI のものも含めて全部トピックになる(自分の番でなければ、自分のタスクには出ない)。止めるときは `POST /connections/{data_source}/disconnect`(トピックとリストは残る)。`GET /connections` の `status` が `broken` なら、理由(`reason`)を伝えて、もう一度つないでもらう

### Gmail をつなぐ(Google Workspace の組織)

本人の Gmail のメールボックスを、本人だけがメンバーの個人リストとして取り込む。Outlook の Google 版で、同意も流れも Outlook と同じ。

1. ゲートウェイで Gmail がつながっているか(`list_credentials` の `gmail`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/gmail`(本文は `{"credential_id"?}`)を呼び、`status` で分ける。`authorize`・`choose`・`connected` は Outlook と同じ。`no_credential` は、ゲートウェイに Gmail の接続がない(サービス名 `gmail`。ゲートウェイでつないでから、もう一度呼ぶ)
3. 自分の連絡先に付くのは、メールボックスのアドレスだけ。「別のアドレスから送信」の別名(send as)は自動では付けない。別名のメールも自分のものにしたければ、ユーザーに確かめて `POST /contacts/{自分の contactId}/addresses` で付ける。自分のアドレスが別の人の連絡先に付いていると、同じアドレスを Outlook と Gmail の両方でつないだときと同じく `conflict` になる。そのまま伝える
4. 取り込みは 5 分ごとの見回りで、メールが届いてからトピックに出るまで最大 5 分ほどかかる(Outlook は通知で速い)。取り込むのはつないだあとに届いたメールだけ(過去のメールは取らない)で、受信トレイ(INBOX)か送信済み(SENT)のラベルが付いたものに限る。下書き・迷惑メール・ゴミ箱・チャットは入らず、フィルタでアーカイブされて受信トレイを通らないメールも入らない。スター・ラベル・既読は写さない。止めるときと `broken` は Outlook と同じ
5. Gmail で送ったあとは、gmail スキルの手順で送ったメッセージの Message-ID を取り、`record_sent` の `sent_ref` に入れる(山かっこごと)

### To Do をつなぐ(本人の To Do のリスト)

本人の Microsoft To Do のリストを、本人だけがメンバーの個人リストとして取り込む。To Do のリスト 1 つがトピック索引のリスト 1 つで、いくつでもつなげる。どのリストも同じ扱い。To Do のタスクは状態を持つソースで、トピック索引は写しを持つだけ(完了 `closedAtSource`・件名 `title`・期限 `source.due`・リストの名前 `source.statusLabel`)。To Do のタスクを作る・期限を変える・完了にするのは、microsoft-graph スキルの To Do(`references/todo.md`)で行う。同意は Outlook と同じもの。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。To Do の権限(`Tasks.ReadWrite`)がまだなければ、ゲートウェイで Microsoft Graph をつなぎ直してもらう
2. `POST /connections/todo` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_list` なら `lists` からユーザーに選んでもらい(`wellknown` が `defaultList` は「タスク」、`flaggedEmails` は Outlook でフラグを付けたメール)、`list`(その `id`)を付けてもう一度呼ぶ。ほかのリストもつなぐなら、リストごとに呼ぶ
3. フラグを付けたメールのリストをつなぐと、フラグを付けたメールが To Do のタスクとして入る(完了にすると、メールのフラグも完了になる)。メールのトピックとは別のトピックになるので、要れば結ぶ。ここには新しい To Do のタスクを作らない
4. つないだときにリストの開いている To Do のタスクを取り込み、以後の変更を追う(つなぐ前に完了したものは取らない)。`broken` の扱いは Outlook と同じ

### Google Tasks をつなぐ(本人の Google Tasks のリスト)

本人の Google Tasks のリストを、本人だけがメンバーの個人リストとして取り込む(Google Workspace の組織)。To Do と同じ形で、リスト 1 つがトピック索引のリスト 1 つ、いくつでもつなげる。写すのは、完了(削除・非表示も閉じる)・タイトル・期限(日付だけ)・リストの名前。メモ(`notes`)・リンク・サブタスクの親子は写さない(サブタスクは普通のタスクとして入る)。タスクを作る・期限を変える・完了にするのは、google-tasks スキルで行う。同意は Outlook と同じもの。

1. ゲートウェイで Google Tasks がつながっているか(`list_credentials` の `tasks`)を確かめる。なければ先にゲートウェイでつないでもらう。古い接続でメールアドレスの権限がなく、つなげないときは、ゲートウェイでつなぎ直してもらう
2. `POST /connections/google-tasks`(本文は `{"credential_id"?, "list"?}`)を呼び、`status` で分ける。`authorize`・`choose`・`connected` は Outlook と同じ。`no_credential` は、ゲートウェイに Google Tasks の接続がない(サービス名 `tasks`)。`choose_list` なら `lists`(`[{id, name, wellknown}]`。`wellknown` は常に `null`)からユーザーに選んでもらい、`list`(その `id`)を付けてもう一度呼ぶ。ほかのリストもつなぐなら、リストごとに呼ぶ
3. Google Tasks には変更の通知がない。5 分ごとの見回りで差分を読むので(デプロイで間隔を延ばしていることがある)、Google Tasks で変えたこと(完了・期限・タイトル)がトピックに出るまで、最大でその間隔だけ遅れる。作った直後に写りを確かめるときは待つ
4. つないだときにリストの開いているタスクを取り込み、以後の変更を追う(つなぐ前に完了したものは取らない)。`broken` の扱いは Outlook と同じ

### Jira をつなぐ(プロジェクトの共有リスト)

Jira はプロジェクトを 1 つの**共有リスト**にする。メンバーは、そのプロジェクトを閲覧できる人のうち、自分の Jira をゲートウェイにつないでトピック索引を有効にした人(自分のアカウントを登録した人)で、トピック索引が 1 時間ごとにソースから写す。同じプロジェクトを誰がつないでも同じリストになる。セキュリティレベルの付いた課題は取り込まない。同意は Outlook と同じもの。

1. ゲートウェイで Jira がつながっているか(`list_credentials` の `jira`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/jira` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_site` なら `sites` から選んで `site`(その `id`)、`choose_project` なら `projects` からユーザーに選んでもらって `project`(その `key`)を付けてもう一度呼ぶ。`forbidden` は、このデプロイで Jira の共有リストを管理者が許していない(管理者に伝える)
3. `connected` で `created: true` なら、新しく作った。**プロジェクトのメンバーに「このプロジェクトをトピック索引で追い始めた」ことを知らせる**(ユーザーに文面と送り先を確かめて、Jira のスキルや Teams・メールで)。課題のコメントやチャネルに書いたら `record_sent` で記録する
4. `created: false` なら、もう誰かがつないでいる(自分はメンバーに入る)。止まっていた(`broken`)ものは、自分の権限でつなぎ直される
5. 止めるときは `POST /connections/{data_source}/disconnect`。共有リストを止められるのは作った人(`created_by`)とゲートウェイの管理者だけ。トピックとリストは残る
6. 起票・コメント・状態の変更は、これまでどおり Jira のスキルで行い、そのあと `record_sent` で記録する(起票は `sent_ref` に課題キー、コメントは `<課題キー>#c<コメント ID>`)

### Teams をつなぐ(チャネルの共有リスト)

Teams はチャネルを 1 つの**共有リスト**にする。メンバーはチャネルのメンバーのうち、このゲートウェイにサインインしたことのある人(Entra ID の ID で対応が付く。アカウントの登録は要らない)で、トピック索引が 1 時間ごとにソースから写す。ゲストなど別のテナントの人はメンバーにならない(投稿は取り込む)。同じチャネルを誰がつないでも同じリストになる。読むのはゲートウェイの Microsoft Graph の接続で、同意は Outlook と同じもの。Entra ID でサインインするゲートウェイだけで使える。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/teams` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_team` なら `teams` からユーザーに選んでもらって `team`(その `id`)、`choose_channel` なら `channels` から選んで `channel`(その `id`)を付けてもう一度呼ぶ。`forbidden` は、このデプロイで Teams の共有リストを管理者が許していない(管理者に伝える)か、Entra ID でサインインしていない
3. `connected` で `created: true` なら、新しく作った。**チャネルに「このチャネルをトピック索引で追い始めた」ことを知らせる**(ユーザーに文面を確かめて、Teams のスキルで投稿)。投稿したら `record_sent` で記録する
4. 取り込むのはつないだあとの投稿と返信だけ(過去の投稿は取らない)。チャネルの投稿 1 つ(と返信)が 1 トピック。`created: false`・止めるとき・`broken` は Jira と同じ
5. チャットのトピックには担当者がないので、メンションされた人にアテンション(`attention.named`)が付き、メンションのない投稿はチャネルのメンバー全員へのリスト宛てのアテンション(`attention.list`)になる。担当は `claim` で決める。「これは私がやる」と言われたら `claim` する。担当がいなければ割当待ち(`triage`)

### 名寄せ(連絡先)

連絡先はチームで共有する(Outlook の連絡先と同じ)。人か会社の窓口かは区別しない。トピック索引は自分では名寄せしない。

- `GET /addresses/unresolved` で、見えるトピックに出てきたのに連絡先のないアドレスを探す
- `GET /contacts?q=` で候補を出し、**同じ相手かをユーザーに確かめてから** `POST /contacts`(新しく作る)か `POST /contacts/{id}/addresses`(付ける)を呼ぶ。推測で付けない
- **サービスのアカウント**(Jira の accountId のように、名前の分からない ID)が未解決なら、そのサービスのスキルで表示名を引き、その名前で **新しい連絡先を作る**(`POST /contacts`)。新しく作るだけなら取り違えがないので、ユーザーに確かめなくてよい。作ると、担当やアテンションに名前が付く(誰の番の種類は変わらない)。同じ人の連絡先が既にありそうなら(名前が一致するなど)、作らずに、付けるかどうかをユーザーに確かめる
- 付け替えるときは、今の付け先を `POST /contacts/{id}/addresses/{address_id}/end` で終わらせてから付ける。過去のメッセージは元の付け先のまま
- 名寄せを直すと、過去のトピックの相手の名前も直る(記録はそのまま)。メンバーが自分のアカウントを登録すれば、過去の自分へのアテンションも自分のものとして見える
- 担当(`assignee`)・アテンション(`attention.named`)とトピックの相手は、連絡先に解決できた相手(`contactIds`・`contactId`・`counterpartContactIds`)と、解決できなかった相手のアドレス(`addresses`・`address`・`counterpartAddresses`)で出る。アドレスで出ている相手は、ユーザーに見せるときはアドレスのまま見せ、名寄せの候補として扱う。名寄せすると `contactIds` に移る

### 状態を持つソースの扱い

課題のトラッカーや PR のように、誰がやるか(ソースの担当者 `source.holders`。Jira は担当者、PR はレビュー待ちならレビュアー・変更を求められたら作者)をソースが決めているリストでは、次のように扱う。

- **担当(`assignee`、`by: "source"`)はソースの担当者(`source.holders`)**。トピック索引では `claim` できない(断られる)。担当を変えるときはソースで(jira スキルなど)変える。担当者がメンバーでなくても(まだ参加していない人でも)その人が担当で、メンバーの番にはならない
- それ以外(起票しただけ・ウォッチしているだけの課題など)は文脈として入る。担当から外れても、片付けるかソースで完了するまでは追い続ける
- コメントでメンションされたら、その人にアテンション(`attention.named`)が付く。担当は変わらない。ユーザーが自分で追いたければ、To Do / Google Tasks のタスクを作って結ぶ(下の「To Do / Google Tasks のタスクで追う」)。担当のいない課題は割当待ち
- 取り込みの範囲の外での話しかけは取り込まれない。気づくのはそのサービス自身の通知(メールで届けば、そちらのリストに入る)。経緯をトピック索引に残したいものは、ユーザーに確かめてから、そのサービスのスキルで範囲に入れる(ウォッチするなど)。次の差分から入る

### To Do / Google Tasks のタスクで追う(1 つのタスクで追う)

対応すると決めたものは、本人の To Do / Google Tasks のタスク 1 つ(トピック索引ではそのトピック 1 つ)で追う。どちらを使うかは組織で決まっていて、つないだリストの `kind`(`todo` か `google-tasks`)で分かる。以下の流れはどちらも同じ。共有リストのトピック(Jira の課題・PR・共有メールボックスなど)には進み具合を書かない。共有の Jira の課題を自分のタスクで進めれば、チームの状態は Jira に、自分の段取りと経過はタスクとメモに分かれる。どちらも書き写さないので二重管理にならない。

1. **着手したら作って記録する**: ユーザーが着手を決めたら、To Do / Google Tasks のタスクの名前と期限(自分の段取りの期日。課題の期日と違ってよい)と、どのリストに作るかをユーザーに確かめ(つないだリストが 1 つならそれ)、その組織のタスクのサービスで、そのリストにタスクを作る(To Do は microsoft-graph スキルの `references/todo.md`、Google Tasks は google-tasks スキル。どちらも返事の `id` がタスクの ID)。作った直後に `POST /sent` で記録する(`data_source` にタスクのリスト、`sent_ref` に作ったタスクの `id`、`subject` にタスクの名前、`body` に要点、`source_thread_id` に元のトピック。`to` は要らない)。To Do / Google Tasks のタスクのトピックができて、元のトピックと `sent` のきっかけで結ばれる。ほかにも関係するトピック(課題・メール)があれば、`POST /threads/{タスクのトピックの id}/links` で結ぶ(親子ではなく対等なリンク)。チームに誰の担当かを見せたいなら、元のトピックを `claim` で担当する(Jira などはソースで担当者を変える)
2. **外に出したものはそのタスクから記録する**: PR を出した・課題にコメントした・返信したら、`record_sent` の `source_thread_id` にそのタスクのトピックを入れる。送ったトピックとタスクが `sent` のきっかけで結ばれ、レビューや返事が返ると、タスクの結んだ先から見た番(`derivedBall`)が `my_turn` になる。実装・レビュー・修正のループが 1 つのタスクにまとまる
3. **経過はメモに書く**: 指示・結果の要約・判断・次の一手を `POST /notes`(`thread_id` にそのタスクのトピック)で足す。書き手を `author` で分ける(人の言葉は `user`、エージェント自身が書いたものは `{"kind":"agent","name":...}`)。タスクの本文(To Do の `body`、Google Tasks の `notes`)には書かない(本人のタスクの画面が経過で埋まる)
4. **終わったらタスクのサービスで完了にする**: 結んだ先が完了しても(`closedAtSource`)、タスクは自動では閉じない。完了にしてよいかをユーザーに聞いてから、そのタスクのサービスのスキル(microsoft-graph の To Do か google-tasks)で完了にする(トピック索引の `dismiss` ではない。写しの `closedAtSource` で閉じる)。期限を変えるのもタスクのサービスで
5. 進み具合や「委譲中」はタスクのサービスにもトピック索引にも状態として持たない。トピックの経過(タイムライン)で読める

一覧(`filter=mine`)は自分の To Do / Google Tasks のタスクで、To Do / Google Tasks のタスク自身か結んだ先の新しい更新(`lastActivityAt`)の順に並ぶ。結んだ PR にレビューが返れば、メモに何も書かれていなくても上に来る。

メールのことなら、タスクに作るまでもなければ、本人のメール(Outlook・Gmail)のトピックにそのままメモを書けばよい(電話で確かめた、来週まで保留、など)。

### エージェントとして参加するとき

**次の一手を決める者が書く。**

- オーケストレータの下で動くエージェント(boid の job、サブエージェント)はトピック索引に書かない。結果をオーケストレータに返し、オーケストレータが判断して To Do / Google Tasks のタスクのトピックにメモする
- 自分のきっかけで動く参加者(オーケストレータ自身、PR を見張ってレビューするエージェント)は、To Do / Google Tasks のタスクのトピックを読み、`author` に自分の名前を付けて書く。名前は参加者を見分けられるもの(`orchestrator`・`codex`・`claude-code` など)にする
- 担当は本人のまま。To Do / Google Tasks のタスクが `my_turn` になったら、エージェントが対応するか、人に回すかを決める。人に答えてほしいことは、メモに質問として書いて(`author` はエージェント)、ユーザーに知らせる
- ループの止め方を決めておく。レビューと修正が何周もしたら人に回す。参加者が互いの書き込みに反応し続けないようにする
- トピック索引は参加者に通知しない。`GET /threads/{タスクのトピックの id} -q since=<前回見た時刻>` か、外のサービスのきっかけ(PR のイベントなど)で拾う
- To Do / Google Tasks のタスクとメモが見えるのは本人(とその代理)だけ。チームの別の人に渡すことは、PR や課題など外のサービスに書く

## 守ること

- **送ったら記録する。** あなた(エージェント)経由で外へ送った・起票した・コメントしたら、その直後に `record_sent` を呼ぶ。送る前には呼ばない(送れなかったものを記録しない)。`sent_ref` は送信の API が返した ID(メールの Message-ID、Slack の ts、LINE の sentMessages[].id、Jira の課題キーやコメント ID、To Do / Google Tasks のタスクの ID)。Gmail は送ったメッセージのヘッダーの Message-ID(gmail スキルの `references/send.md`)。同じ `sent_ref` で 2 回呼んでも 1 回分しか残らない
- **共有リストのトピックには、事実と構造の操作だけ。** 送信の記録・担当する・アテンションを外す・結ぶ・振り分けの直し・片付けは共有リストのトピックにしてよい。進み具合・作業のメモは、個人リストのトピック(自分の To Do / Google Tasks のタスク)に書く。共有リストのトピックにメモを書こうとすると `invalid` になる
- **リンクは両端を読める人にしか見えない。** 共有リストのトピックを自分の To Do / Google Tasks のタスクや自分の受信トレイのトピックと結んでも、ほかのメンバーにはリンクがあることも見えない。チームに伝えたい進み(メールで先方に確かめた、課題で直した など)は、ユーザーと伝える粒度を決めて、共有のソースに書く(LINE で返す、Slack のスレッドに書く、課題にコメントする)。書いたら `record_sent` で記録する
- **組織をまたがない。** 送ったのと同じ組織のコネクタのトピック索引に記録する。組織が違えばトピック索引も違うので、別の組織のやりとりやトピックを、この組織のトピック索引のメモに書き写したり結んだりしない。To Do / Google Tasks のタスクも、その組織のアカウントのタスクのサービスに作る
- 送る前の確認(宛先・本文・送信元・返事の期限)はユーザーに見せて、送信の指示をもらう。これはトピック索引の承認ではなく、ユーザーとの会話でのゲート
- **リンクは候補を見て、ユーザーと決めてから張る。** `get_thread` の `linkCandidates`(結ぶ候補)はアンカー(課題キー・PR・メッセージ ID)が一致したものにすぎない。同じ話でなければ結ばない
- メモ・片付け・再開・To Do / Google Tasks のタスクの完了は本人の側の状態。結んだ先が動いても(`linkedActiveSinceDismissed`)、閉じたものを勝手に再開しない。ユーザーに知らせて決めてもらう(To Do / Google Tasks のタスクなら、そのアプリで再開する)
- **Jira・To Do・Google Tasks など状態を持つソースのトピックの状態はソースの写し(`source`: `holders` = ソースの担当者のアカウント、`statusLabel`、`due`。完了は `closedAtSource`、件名は `title`)。** トピック索引では書けない。変えるときは Jira・To Do・Google Tasks の側で(jira スキル・microsoft-graph スキル・google-tasks スキルなど)変えれば、写しとして戻ってくる。本人が付ける属性はない(To Do / Google Tasks のタスクの期日はそのアプリの期限の写し `source.due`)
- 状態を持つソースのトピックの担当は、ソースの担当者(`source.holders`。Jira は担当者、PR はレビュー待ちならレビュアー・変更を求められたら作者)。メンバーならその人の番(`myTurn` に `assignee`)。完了(`closedAtSource`)ならどの見え方にも数えず、`filter=open` にも出ない
- 担当(`assignee`)・アテンション(`attention`)・返事の期限(`replyExpectedBy`)・期限超過(`overdue`)は記録から決まる。書き換える操作はない
- **アテンションは、読んで判断したら外す。** 自分へのアテンション(`attention.named` の `userId` が自分、または `attention.list` に自分)は、対応が要らないと決めたか、対応を決めたら `acknowledge` で外す。外すまで自分のタスク(`my_turn`)に残る。対応が要るのか FYI かは、本文を読んで決める(トピック索引は判断しない)。返事を送るときは `record_sent` の `acknowledge: true` で一緒に外す。外しても、ソースの既読・未読は変わらない
- **待っていた相手から返事が来たら、相手へのアテンションも外す。** メンバーでない相手(お客さん・まだ参加していないメンバー)は自分で外せないので、返事を読んで、待っていた返事が来たなら `acknowledge` の `addresses` にその相手を入れて外す(足りなければ残す)。外すまで返事待ち(`awaiting`)と期限超過(`overdue`)が残る(期限超過はメンバーでない宛先で決まるので、社内の CC は気にしなくてよい)。メンバーへのアテンションは本人しか外せない。個人のメールボックスにエイリアスや配布リスト宛てで届いたものは、本人へのリスト宛てのアテンション(`attention.list`)として出る
- 後から参加した(メンバーになった)ときは、過去の自分へのアテンションが残っているので、ユーザーに確かめてから `POST /acknowledge` でまとめて外す
- ユーザーに話すときは「言葉」の表の言葉を使う。「スレッド」「シグナル」「読者」「名指し」は API とトピック索引の内部の言葉で、ユーザーには出さない

## API

| ツール | メソッドとパス | 入力 | 返すもの |
| --- | --- | --- | --- |
| me | `GET /me` | | User(`user`)、自分の連絡先(`contact`。まだなければ `null`)、メンバーになっているリスト(`lists`) |
| list_lists | `GET /lists` | | 見えるリストの一覧(リスト・メンバー(`userId`・`name`・`contactId`)) |
| get_list | `GET /lists/{list_id}` | | リスト・メンバー |
| list_threads | `GET /threads` | `-q filter=my_turn\|mine\|open\|awaiting\|overdue\|triage\|all`(既定 `open`。`my_turn` は自分のタスク = 自分が担当か自分へのアテンションが残っているもの、`awaiting` は返事待ち = こちらから送ったメンバーでない相手へのアテンションが残っているもの、`triage` は割当待ち = 共有リストで担当のいないもの、`mine` は自分の To Do / Google Tasks のタスク(閉じたものも))、`-q data_source=...`、`-q since=<ISO 8601>`(それより後に動いたものだけ。To Do / Google Tasks のタスクは結んだ先が動いても入る) | トピックの一覧(自分か見える結んだ先の最新の更新 `lastActivityAt` の新しい順)。各トピックに `assignee`(担当。`by` は `source` / `claim`、`userIds`・`contactIds`・`addresses`。個人リストと担当のいないものは `null`)・`attention`(残っているアテンション。`named`: `[{address, userId, contactId, signalId, at}]`(`userId` はメンバーなら本人、メンバーでなければ `null`)、`list`: リスト宛てのアテンションが残っているメンバー `{userIds, signalId, at}` か `null`)・`myTurn`(自分の番の理由 `assignee`(担当) / `named`(アテンション) / `list`(リスト宛て)。空なら自分の番でない)・`triage`・`awaiting`・`links`・`source`(写し)・`derivedBall`(結んだ先から見た番)・`linkCandidates`(結ぶ候補)・`overdue`・`closedAtSource`(ソースで完了) など |
| get_thread | `GET /threads/{thread_id}` | `-q since=<ISO 8601>`(省略可。タイムラインをそれより後に絞る) | `thread`(一覧と同じ項目)、`dataSource`(リスト)、`linked`(結んだ先。両端を読めるものだけ。見えないトピックへのリンクは、あることも出ない)、`timeline`(このトピックのメッセージ・メモ・操作と、結んだ先のメッセージを時刻順に。メモは `kind: "note"` で `note: {noteId, body, author}`) |
| add_note | `POST /notes` | `{"thread_id", "body", "author"?}`。個人リスト(自分の To Do / Google Tasks のタスク・自分のメール)のトピックにメモ(経過)を書く。共有リストのトピックは `invalid`。新しく追うものは To Do / Google Tasks のタスクを作って `record_sent` する(トピックは作らない)。`author` は書き手で、人の言葉(中継を含む)なら省略か `{"kind":"user"}`、エージェント自身が書いたもの(judge・結果の要約・提案)なら `{"kind":"agent","name":"orchestrator"}` のように名前を付ける。タイムラインのメモに `note.author` で出る(誰の番には使わない) | そのトピック(`get_thread` と同じ) |
| claim_thread | `POST /threads/{thread_id}/claim` | `{"user_id"?, "reason"?}`。省略で自分が担当する、`null` で手放す、ほかのメンバーの User ID で引き継ぐ。状態を持つソース(Jira など)と個人リストでは `invalid` | `get_thread` と同じ |
| acknowledge | `POST /threads/{thread_id}/acknowledge` | `{"until_signal_id"?, "addresses"?, "reason"?}`。`until_signal_id`(メッセージの ID。省略で最新のメッセージ)までのアテンションを外す。`addresses` を省けば自分へのアテンション(自分のアドレスとリスト宛て)、渡せば `[{"channel","value"}]` のアドレス(自分のものか、このリストのメンバーでないもの。ほかのメンバーのものは `forbidden`)。外すものがなければ何もしない | `get_thread` と同じ(`timeline` に `kind: "acknowledged"`) |
| acknowledge_many | `POST /acknowledge` | `{"thread_ids": [...], "reason"?}`。それぞれの最新のメッセージまで、自分へのアテンションをまとめて外す(参加したときなど) | `{"acknowledged": <外したトピックの数>}` |
| link_threads | `POST /threads/{thread_id}/links` | `{"thread_id", "reason"?}`(結ぶ相手のトピック) | `get_thread` と同じ。結ぶ候補から張ればきっかけは `anchor`、それ以外は `manual` |
| unlink_threads | `POST /threads/{thread_id}/unlink` | `{"thread_id", "reason"?}` | `get_thread` と同じ |
| dismiss_thread | `POST /threads/{thread_id}/dismiss` | `{"reason"}`(必須)。割当待ちなどから片付ける。To Do / Google Tasks のタスクは `invalid`(そのアプリで完了にする) | `get_thread` と同じ |
| reopen_thread | `POST /threads/{thread_id}/reopen` | `{"reason"?}`。片付けたトピックを再開する。To Do / Google Tasks のタスクは `invalid`(そのアプリで再開する) | `get_thread` と同じ |
| move_signal | `POST /signals/{signal_id}/move` | `{"thread_id"}` か `{"new_thread_title"}` のどちらか、`"reason"`(必須)。メッセージを別のトピックか新しいトピックへ移す | 移した先のトピック(`get_thread` と同じ) |
| record_sent | `POST /sent` | 下の「送信の記録」 | 送ったメッセージの入ったトピック(`get_thread` と同じ) |
| rename_me | `PATCH /me` | `{"name"}` | `me` と同じ |
| connect_outlook | `POST /connections/outlook` | `{"credential_id"?}`(ゲートウェイの Graph の接続。複数あるときだけ) | `status`: `authorize`(`authorize_url`)・`choose`(`credentials`)・`no_credential`(`register_url`)・`connected`(`data_source`、`created`)。上の「Outlook をつなぐ」 |
| connect_todo | `POST /connections/todo` | `{"credential_id"?, "list"?}`(`list` は `choose_list` の `lists[].id`) | `connect_outlook` と同じ + `choose_list`(`lists`: `[{id, name, wellknown}]`)。リストごとに呼ぶ(いくつでもつなげる)。上の「To Do をつなぐ」 |
| connect_gmail | `POST /connections/gmail` | `{"credential_id"?}`(ゲートウェイの Gmail の接続。複数あるときだけ) | `connect_outlook` と同じ(`no_credential` はゲートウェイに Gmail の接続がない)。上の「Gmail をつなぐ」 |
| connect_google_tasks | `POST /connections/google-tasks` | `{"credential_id"?, "list"?}`(`list` は `choose_list` の `lists[].id`) | `connect_todo` と同じ(`wellknown` は常に `null`)。リストごとに呼ぶ(いくつでもつなげる)。上の「Google Tasks をつなぐ」 |
| connect_jira | `POST /connections/jira` | `{"credential_id"?, "site"?, "project"?}`(`site` は `choose_site` の `sites[].id`、`project` は `choose_project` の `projects[].key`) | `connect_outlook` と同じ + `choose_site`(`sites`)・`choose_project`(`projects`)。`forbidden` はデプロイで許していない。上の「Jira をつなぐ」 |
| connect_teams | `POST /connections/teams` | `{"credential_id"?, "team"?, "channel"?}`(`team` は `choose_team` の `teams[].id`、`channel` は `choose_channel` の `channels[].id`) | `connect_outlook` と同じ + `choose_team`(`teams`)・`choose_channel`(`channels`)。`forbidden` はデプロイで許していないか Entra ID でない。上の「Teams をつなぐ」 |
| list_connections | `GET /connections` | | 自分がつないだものと、メンバーになっている共有リスト(`kind`: `outlook` / `gmail` / `todo` / `google-tasks` / `jira` / `teams`、To Do と Google Tasks は `list`(リストの名前)、Jira は `site`・`project`、Teams は `team`・`channel`、共有リストは `shared: true`・`created_by`)と取り込みの状態(`status`: `setup` / `ok` / `broken`(`reason`) / `disconnected`)、`last_sync_at` |
| disconnect | `POST /connections/{data_source}/disconnect` | | 取り込みを止める。共有リストは作った人と管理者だけ。トピックとリストは残る |
| create_data_source | `POST /data-sources` | `{"channel", "name", "identity", "gateway_credential_id", "description"?, "group"?}`。個人リスト(メンバーは自分だけ)を作る | `get_list` と同じ + `identity`(上の「初めてつないだとき」) |
| set_identity | `POST /lists/{list_id}/identity` | `{"identity"}`(そのリストでの自分のアカウントを登録する) | `identity` の結果(`kind`・`contactId`) |
| list_unresolved | `GET /addresses/unresolved` | | `[{channel, value, count, lastSeenAt, threadIds}]`(最後に見た順) |
| search_contacts | `GET /contacts` | `-q q=<名前かアドレスの一部>` | `[{id, name, userId, addresses: [{id, channel, value, validFrom, validTo}], externalRefs}]` |
| get_contact | `GET /contacts/{contact_id}` | | 連絡先(まとめて消えた ID はまとめ先) |
| create_contact | `POST /contacts` | `{"name", "address"?: {"channel", "value"}}` | 連絡先 |
| rename_contact | `PATCH /contacts/{contact_id}` | `{"name"}` | 連絡先 |
| add_address | `POST /contacts/{contact_id}/addresses` | `{"channel", "value", "valid_from"?, "reason"?}`。同じ時点で別の連絡先に付いていれば `conflict` | 連絡先 |
| end_address | `POST /contacts/{contact_id}/addresses/{address_id}/end` | `{"valid_to"?, "reason"?}`(省略で今) | 連絡先 |
| merge_contacts | `POST /contacts/{contact_id}/merge` | `{"from", "reason"?}`(`from` をまとめる。両方に User があれば `conflict`) | まとめ先の連絡先 |
| unbind_contact | `POST /contacts/{contact_id}/unbind` | | 連絡先(自分の連絡先だけ。見えるものは変わらない) |

連絡先の API(`/contacts`・`/addresses/unresolved`)は、どれかのリストのメンバー(チームのメンバー)だけが使える(ほかは `forbidden`)。

エラーは `{"error": "not_found" | "invalid" | "forbidden" | "conflict", "message": ...}`。見えないトピックやリストは、存在していても `not_found` になる。

### 送信の記録(record_sent)

```json
{
  "data_source": "ds_support",
  "to": ["owner@tanaka-bldg.example"],
  "to_contact_ids": [],
  "from": "acct-nose",
  "subject": "Re: エントランスの床について",
  "body": "送った本文",
  "sent_ref": "<20261016.0925@ubs.example>",
  "anchors": { "in_reply_to": "<...>", "thread_ts": "...", "quoted_message_id": "...", "thread_key": "NVT-42", "jira_keys": ["NVT-42"], "pr_refs": [] },
  "reply_to_thread_id": "thr_2",
  "source_thread_id": "thr_5",
  "reply_expected_by": "2026-10-16T17:00:00+09:00",
  "acknowledge": true
}
```

- `data_source`: 送ったリスト(送信元のメールボックス・LINE 公式アカウントなど)。`get_thread` の `dataSource.id`、または `list_lists`
- `to` か `to_contact_ids` のどちらかは必須(To Do / Google Tasks のタスクを作った記録だけ要らない)。`to` はそのチャネルのアドレス
- `from`(任意): 実際に送ったアドレス。Jira のコメントや Slack の発言のように自分のアカウントで書いたときは、そのアカウントを入れる。省けばリストの窓口(共有メールボックス・LINE 公式アカウント)、窓口がなければ(個人のメールボックス)自分のアドレス。そのリストでこちらのアドレスでなければ invalid
- `reply_to_thread_id`: 返事をしているトピック(同じリスト)。送ったメッセージはそこに入る。省略すると、アンカーで決まらなければ新しいトピックになる
- `source_thread_id`: 送る元になったトピック(どのリストでもよい。To Do / Google Tasks のタスクのトピックや、LINE の欠勤のトピックから打診を送るときなど)。送ったトピックと `sent` のきっかけで結ばれる
- `reply_expected_by`: 返事の期限(ISO 8601、オフセット付きでよい)。過ぎると `overdue` になる。返事が来たら、読んで相手へのアテンションを `acknowledge` で外すと消える
- `acknowledge`(任意): `true` なら、送ったトピックの、送る前までの自分へのアテンションを一緒に外す。返事をしたら付ける
- 宛先の人にアテンションが付く(メンバーでない相手なら返事待ち)。返事は同じリストに戻り、送ったトピックに入る
- **Jira の起票**: `sent_ref` に課題キー、`anchors.thread_key` にも同じ課題キーを入れる。`to_contact_ids` は担当者、`source_thread_id` に起票の元になったトピック(LINE・メール・Slack など)。課題のトピックができて元のトピックと `sent` のきっかけで結ばれ、課題の状態(写し)とコメントはそのトピックに入る
- **Jira のコメント**: `sent_ref` にコメント ID、`anchors.thread_key` に課題キー、`reply_to_thread_id` に課題のトピック
- **To Do / Google Tasks のタスクを作った**: `data_source` にタスクのリスト、`sent_ref` にタスクの `id`、`subject` にタスクの名前、`source_thread_id` に元のトピック。`to` は要らない。タスクの ID がそのトピックの区切りになり、あとから届く写し(件名・期限・完了)も同じトピックに入る

## よくある流れ

1. 「今日やることは?」: `GET /threads -q filter=my_turn`(自分のタスク)。`myTurn` で理由(担当・アテンション・リスト宛て)を添えて見せる。アテンションだけのものは本文を読んで、対応が要るか FYI かを分けて伝え、FYI と決まったものはユーザーに確かめて `acknowledge` で外す。割当待ちは `filter=triage`、返事待ちは `filter=awaiting`、期限超過は `filter=overdue`。前回から何が動いたかは `-q since=<前回見た時刻>`
2. 「この件は私が担当する」: `POST /threads/{id}/claim`(Jira などはソースで担当者を変える)。引き継ぐなら `{"user_id": "..."}`、手放すなら `{"user_id": null}`
3. 「この課題に着手する」: 上の「To Do / Google Tasks のタスクで追う」。To Do / Google Tasks のタスクを作る → `POST /sent` で記録して元のトピックと結ぶ → (チームに見せるなら)元のトピックを `claim`。以後、外に出したものは `source_thread_id` に To Do / Google Tasks のタスクのトピックを入れて記録し、経過はそのトピックにメモする
4. 「この件をまとめて追いたい」: To Do / Google Tasks のタスクを作って `POST /sent` で記録する → `GET /threads/{id}` の `linkCandidates`(結ぶ候補)と、ユーザーの話から関係するトピックを選ぶ → `POST /threads/{タスクのトピックの id}/links`。LINE のトピック 1 つだけで済むなら、To Do に作らず担当するだけでよい。自分のメールのトピック 1 つなら、そこにメモを書くだけでよい
5. 「この件に返信して」「協力会社に依頼して」: `GET /threads/{id}` で経過を読む → 文面と宛先・返事の期限をユーザーに確認 → 送信のスキルで送る → **すぐ `POST /sent`**(返信なら `reply_to_thread_id` と `acknowledge: true`、別の相手への依頼なら `source_thread_id` に元のトピック)
6. 「あの To Do / Google Tasks のタスク、どうなった?」: `GET /threads/{タスクのトピックの id}`。`derivedBall` が結んだ先から見た番(`my_turn` / `waiting`)、`timeline` に結んだ先の受信も並ぶ
7. 「もう対応不要」: 割当待ちなら `POST /threads/{id}/dismiss`(片付ける)、To Do / Google Tasks のタスクならそのアプリで完了にする(ユーザーに確かめてから)。また動いたら、片付けたものは `reopen` で再開、タスクはそのアプリで再開する
8. 「振り分けが違う」: `POST /signals/{signal_id}/move`(メッセージを既存のトピックか新しいトピックへ移す)。違うトピックと結んだら `unlink`
9. 「これ課題にして」: 起票の内容(要約・説明・担当者)をユーザーに確認 → jira スキルで起票 → **すぐ `POST /sent`**(`sent_ref` と `anchors.thread_key` に課題キー、`source_thread_id` に元のトピック)。ステータスや担当者を変えたいときは jira スキルで Jira を直接変える
