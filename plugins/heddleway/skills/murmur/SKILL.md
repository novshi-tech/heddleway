---
name: murmur
description: 連絡の索引「Murmur」(プロトタイプ)のスレッドを API ゲートウェイ経由で読み書きする。メール・Slack・LINE などの連絡から拾ったスレッドのうち自分の番のもの、スレッドの経過とタイムライン、仕分け待ち、相手待ち、期限超過の確認、スレッドを担当する・手放す・引き継ぐ、名指しを外す（目を通した）、着手したタスクを To Do のタスクとして作って結び、1 つのタスクのスレッドで追う(実装・レビュー・修正のループ、エージェントとしての参加)、個人リストのスレッド(タスク・本人のメール)にメモ(経過)を書く、スレッド同士を結ぶ、片付け・開き直し・振り分けの直し、そして外へ送った・起票した直後の送信の記録(record_sent)を扱う。「自分の番のものを見せて」「自分宛てのものは？」「仕分け待ちは？」「返事が来てないものは？」「目を通した」「この件は私が持つ」「この件をタスクにして結んで」「このメールにメモして」「この課題に着手する」「タスクの経過を見せて」「さっきの返信を記録して」「振り分けが違う」などの依頼で使う。外へ送るときは、送信のスキルで送ったあと必ずこのスキルで記録する。
---

# Murmur

Murmur の本体は、API ゲートウェイの上流サービス `murmur` として登録されている。Heddleway の機能で、デプロイによっては無効になっている。トークンの発行とスクリプトの基本的な使い方は、同じプラグインの `heddleway` スキルに従う。

Murmur は連絡(メール・Slack・LINE・Jira など)を**スレッド**に綴じて、誰の番かを追う索引。誰の番は 2 つの軸で決まる: **担当**(このタスクを進める人。Jira などは担当者、LINE・Teams・メールの共有リストは `claim` で担当した人)と**名指し**(連絡の宛先。送り主が「少なくとも読んでほしい」と思った人。本人かスタンドが `acknowledge` で外すまで残る)。スレッドはデータソースの写しで、データソースごとに 1 つのリストに入る。リストは**個人リスト**(読者が本人 1 人。本人の Outlook・本人の To Do のタスクのリスト)と**共有リスト**の 2 つだけ。「この件」として追いたいものは、本人の To Do にタスクを作って Murmur に記録し、関係するスレッドとリンクで結ぶ。経過は**メモ**として、個人リストのスレッドに書く(Murmur が持つのはスレッドへの操作だけで、メモもその 1 つ)。

**Murmur は外に何も書かない。** メール・LINE・Slack の送信や Jira の起票は、それぞれのスキル(gmail・microsoft-graph など)でユーザーの確認を取ってから送り、送った直後に `record_sent` で事実を記録する。Murmur がするのは、どのスレッドに綴じるかと、担当・名指しを機械的に追うことだけ。対応が要るのか FYI かは判断しない(名指しされた人が読んで決める)。何をするか・どのスレッドを結ぶかは、ユーザーとあなたが決める。

## 手順

1. 作業する組織のコネクタを選ぶ(`heddleway` スキルの「コネクタの選び方」)。Murmur は組織(チーム)ごとに 1 つで、その組織のゲートウェイの上流になっている。組織の分からない「自分の番のもの」は、`identity:murmur` を持つコネクタが 2 つ以上あれば、どの組織のものかを聞くか、組織ごとに分けて見せる。
2. そのコネクタの `list_credentials` に `identity:murmur` があることを確かめる。ユーザーが登録するものはない。ゲートウェイが、サインイン中のユーザーとして本体に伝える。
3. 同じコネクタの `issue_token` に `identity:murmur` を渡してトークンを発行し、`GW_TOKEN` と `GW_BASE_URL` を設定する。送信に使うサービスの認証情報と一緒に発行してよい(同じ組織のコネクタのものだけ)。
4. `scripts/gw_request.py`(`heddleway` スキルのものと同じ)で呼ぶ。パスは下の表のとおり(先頭に `/api` は付けない)。

```sh
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /me
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /threads -q filter=my_turn
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py GET murmur /threads/thr_12 -q since=2026-10-21T09:00:00+09:00
python3 ${CLAUDE_SKILL_DIR}/scripts/gw_request.py POST murmur /sent --json '{"data_source":"ds_support","reply_to_thread_id":"thr_12","to":["owner@example.com"],"body":"...","sent_ref":"<...@mail>"}'
```

見えるもの・できることは、ユーザー本人と同じ。見えるのは、ユーザーが読者になっているデータソースのスレッドと、そこに本人が書いたメモだけ。

### 初めてつないだとき

初めてつないだユーザーは名無しで、Contact(連絡先の自分)もリストもない(`GET /me` が `contact: null`・`lists: []`)。次の順に案内する。

1. 呼び方を聞いて `PATCH /me` で付ける
2. 自分の Outlook を自分のリストにするなら `POST /connections/outlook`、自分の To Do のタスクのリストを自分のリストにするなら `POST /connections/todo`、Jira のプロジェクトを共有リストにするなら `POST /connections/jira`、Teams のチャネルを共有リストにするなら `POST /connections/teams` を呼ぶ(下の「Outlook をつなぐ」「To Do をつなぐ」「Jira をつなぐ」「Teams をつなぐ」)。Murmur が取り込み続けるのはこの経路だけ
3. ほかの自分の箱(Slack・LINE など)をリストにするなら、ゲートウェイでそのサービスがつながっているか(`list_credentials`)を先に確かめ、つないだアカウントのアドレスを `identity` にして `POST /data-sources` を呼ぶ。結果の `identity.kind`:
   - `created`: 自分の Contact を新しく作った / `bound`: チームが先に作っていたゴーストが自分に結ばれた / `attached`・`already`: 自分の Contact に付いた
   - `merge_candidate`: そのアドレスは別のゴースト(`ghostContactId`)に付いている。同じ人なら、ユーザーに確かめてから `POST /contacts/{自分の contactId}/merge` で `from` にゴーストを渡してまとめる
4. **共有リスト**(Jira のプロジェクト、Teams のチャネル、これから Slack のチャネル)は、スペースに 1 つ。そのスペースを読める人なら誰でもつなげ、読者はソースから自動で写る(Jira はプロジェクトを閲覧できる人のうち、自分の Jira をゲートウェイにつないで名乗った人。Teams はチャネルのメンバーのうち、このゲートウェイにサインインしたことのある人)。共有メールボックス・LINE 公式アカウントの読者は管理者が足す。読者になったリストで自分のアカウントを決めるなら `POST /lists/{list_id}/identity`
5. タスクを追うなら、To Do のタスクのリストをつなぐ(下の「To Do をつなぐ」)。メモ(`add_note`)は個人リストのスレッドに書くので、Outlook か To Do をつないでから使える

### Outlook をつなぐ

本人の Outlook のメールボックスを、本人だけが読む個人のリストとして取り込む。本人がゲートウェイの画面で Murmur を有効にする(許可する)と、Murmur は本人のゲートウェイの接続を読めるようになる(読むだけで、送信や書き込みはしない)。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/outlook` を呼び、`status` で分ける:
   - `authorize`: `authorize_url` をユーザーに開いてもらい、ゲートウェイの画面で Murmur を有効にしてもらう(「Murmur を有効にしますか?」、または OAuth の許可の画面)。終わると結果の画面が出る。終わったら `GET /connections` で確かめる
   - `choose`: Graph の接続が複数ある。`credentials` からユーザーに選んでもらい、`credential_id` を付けてもう一度呼ぶ
   - `no_credential`: ゲートウェイで Microsoft Graph をつないでから、もう一度呼ぶ
   - `connected`: つながった(`data_source`)。何度呼んでもよい
3. メールボックスのアドレスとエイリアスは自分の Contact に付く。別の人のアドレスが混じっていると `conflict` になるので、そのまま伝える
4. 取り込むのはつないだあとに届くメールだけ(過去のメールは取らない)。止めるときは `POST /connections/{data_source}/disconnect`(スレッドとデータソースは残る)。`GET /connections` の `status` が `broken` なら、理由(`reason`)を伝えて、もう一度つないでもらう

### To Do をつなぐ(本人のタスクのリスト)

本人の Microsoft To Do のタスクのリストを 1 つ、本人だけが読む個人リストとして取り込む。タスクは状態を持つソースで、Murmur は写しを持つだけ(完了 `closedAtSource`・件名 `title`・期限 `source.due`・リストの名前 `source.statusLabel`)。タスクを作る・期限を変える・完了にするのは、microsoft-graph スキルの To Do(`references/todo.md`)で行う。同意は Outlook と同じもの。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。To Do の権限(`Tasks.ReadWrite`)がまだなければ、ゲートウェイで Microsoft Graph をつなぎ直してもらう
2. `POST /connections/todo` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_list` なら `lists` からユーザーに選んでもらい(Murmur で追うタスク用のリストを作って選ぶのがおすすめ。`wellknown` が `defaultList` は「タスク」、`flaggedEmails` はフラグを付けたメール)、`list`(その `id`)を付けてもう一度呼ぶ
3. つなげるリストは 1 つのアカウントで 1 つ。別のリストに替えるなら、今のものを `disconnect` してから
4. つないだときにリストの開いているタスクを取り込み、以後の変更を追う(つなぐ前に完了したタスクは取らない)。`broken` の扱いは Outlook と同じ

### Jira をつなぐ(プロジェクトの共有リスト)

Jira はプロジェクトを 1 つの**共有リスト**にする。読者は、そのプロジェクトを閲覧できる人のうち、自分の Jira をゲートウェイにつないで Murmur を有効にした人(名乗った人)で、Murmur が 1 時間ごとにソースから写す。同じプロジェクトを誰がつないでも同じリストになる。セキュリティレベルの付いた課題は取り込まない。同意は Outlook と同じもの。

1. ゲートウェイで Jira がつながっているか(`list_credentials` の `jira`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/jira` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_site` なら `sites` から選んで `site`(その `id`)、`choose_project` なら `projects` からユーザーに選んでもらって `project`(その `key`)を付けてもう一度呼ぶ。`forbidden` は、このデプロイで Jira の共有リストを管理者が許していない(管理者に伝える)
3. `connected` で `created: true` なら、新しく作った。**プロジェクトのメンバーに「このプロジェクトを Murmur で追い始めた」ことを知らせる**(ユーザーに文面と送り先を確かめて、Jira のスキルや Teams・メールで)。課題のコメントやチャネルに書いたら `record_sent` で記録する
4. `created: false` なら、もう誰かがつないでいる(自分は読者に入る)。止まっていた(`broken`)ものは、自分の権限でつなぎ直される
5. 止めるときは `POST /connections/{data_source}/disconnect`。共有リストを止められるのは作った人(`created_by`)とゲートウェイの管理者だけ。スレッドとデータソースは残る
6. 起票・コメント・状態の変更は、これまでどおり Jira のスキルで行い、そのあと `record_sent` で記録する(起票は `sent_ref` に課題キー、コメントは `<課題キー>#c<コメント ID>`)

### Teams をつなぐ(チャネルの共有リスト)

Teams はチャネルを 1 つの**共有リスト**にする。読者はチャネルのメンバーのうち、このゲートウェイにサインインしたことのある人(Entra ID の ID で対応が付く。名乗りは要らない)で、Murmur が 1 時間ごとにソースから写す。ゲストなど別のテナントの人は読者にならない(投稿は取り込む)。同じチャネルを誰がつないでも同じリストになる。読むのはゲートウェイの Microsoft Graph の接続で、同意は Outlook と同じもの。Entra ID でサインインするゲートウェイだけで使える。

1. ゲートウェイで Microsoft Graph がつながっているか(`list_credentials`)を確かめる。なければ先にゲートウェイでつないでもらう
2. `POST /connections/teams` を呼び、`status` で分ける。`authorize`・`choose`・`no_credential` は Outlook と同じ。`choose_team` なら `teams` からユーザーに選んでもらって `team`(その `id`)、`choose_channel` なら `channels` から選んで `channel`(その `id`)を付けてもう一度呼ぶ。`forbidden` は、このデプロイで Teams の共有リストを管理者が許していない(管理者に伝える)か、Entra ID でサインインしていない
3. `connected` で `created: true` なら、新しく作った。**チャネルに「このチャネルを Murmur で追い始めた」ことを知らせる**(ユーザーに文面を確かめて、Teams のスキルで投稿)。投稿したら `record_sent` で記録する
4. 取り込むのはつないだあとの投稿と返信だけ(過去の投稿は取らない)。チャネルの投稿 1 つ(と返信)が 1 スレッド。`created: false`・止めるとき・`broken` は Jira と同じ
5. チャットのスレッドには担当者がないので、メンションされた人が名指し(`attention.named`)、メンションのない投稿はチャネルの全員へのリスト宛て(`attention.list`)になる。担当は `claim` で決める。「これは私がやる」と言われたら `claim` する。担当がいなければ仕分け待ち(`triage`)

### 名寄せ(Contact)

Contact はチームで共有する連絡先(Outlook の連絡先と同じ)。人か会社の窓口かは区別しない。Murmur は自分では名寄せしない。

- `GET /addresses/unresolved` で、見えるスレッドに出てきたのに Contact のないアドレスを探す
- `GET /contacts?q=` で候補を出し、**同じ相手かをユーザーに確かめてから** `POST /contacts`(新しく作る)か `POST /contacts/{id}/addresses`(付ける)を呼ぶ。推測で付けない
- **サービスのアカウント**(Jira の accountId のように、名前の分からない ID)が未解決なら、そのサービスのスキルで表示名を引き、その名前で **新しい Contact を作る**(`POST /contacts`)。新しく作るだけなら取り違えがないので、ユーザーに確かめなくてよい。作ると、担当や名指しに名前が付く(誰の番の種類は変わらない)。同じ人の Contact が既にありそうなら(名前が一致するなど)、作らずに、付けるかどうかをユーザーに確かめる
- 付け替えるときは、今の付け先を `POST /contacts/{id}/addresses/{address_id}/end` で終わらせてから付ける。過去のシグナルは元の付け先のまま
- 名寄せを直すと、過去のスレッドの相手の名前も直る(イベントはそのまま)。読者が自分のアカウントを名乗れば、過去の自分宛ての名指しも自分のものとして見える
- 担当(`assignee`)・名指し(`attention.named`)とスレッドの相手は、Contact に解決できた相手(`contactIds`・`contactId`・`counterpartContactIds`)と、解決できなかった相手のアドレス(`addresses`・`address`・`counterpartAddresses`)で出る。アドレスで出ている相手は、ユーザーに見せるときはアドレスのまま見せ、名寄せの候補として扱う。名寄せすると `contactIds` に移る

### 状態を持つデータソースの扱い

課題のトラッカーや PR のように、誰がやるか(ソースの担当者 `source.holders`。Jira は担当者、PR はレビュー待ちならレビュアー・変更を求められたら作者)をソースが決めているデータソースでは、次のように扱う。

- **担当(`assignee`、`by: "source"`)はソースの担当者(`source.holders`)**。Murmur では `claim` できない(断られる)。担当を変えるときはソースで(jira スキルなど)変える。担当者が読者でなくても(まだ参加していない人でも)その人が担当で、読者の番にはならない
- それ以外(起票しただけ・ウォッチしているだけの課題など)は文脈として入る。担当から外れても、片付けるかソースで完了するまでは追い続ける
- コメントでメンションされたら、その人への名指し(`attention.named`)になる。担当は変わらない。ユーザーが自分のタスクとして追いたければ、To Do にタスクを作って結ぶ(下の「タスクとして追う」)。担当のいない課題は仕分け待ち
- 取り込みの範囲の外での話しかけは取り込まれない。気づくのはそのサービス自身の通知(メールで届けば、そちらのリストに入る)。経緯を Murmur に残したいものは、ユーザーに確かめてから、そのサービスのスキルで範囲に入れる(ウォッチするなど)。次の差分から入る

### タスクとして追う(1 タスク = 1 つの To Do のタスク)

対応すると決めた件は、本人の To Do のタスク 1 つ(Murmur ではそのスレッド 1 本)で追う。共有のスレッド(Jira の課題・PR・共有メールボックスなど)には進み具合を書かない。共有の Jira の課題を自分のタスクで進めれば、チームの状態は Jira に、自分の段取りと経過はタスクとメモに分かれる。どちらも書き写さないので二重管理にならない。

1. **着手したら作って記録する**: ユーザーが着手を決めたら、タスクの名前と期限(自分の段取りの期日。課題の期日と違ってよい)をユーザーに確かめ、microsoft-graph スキルで To Do のつないだリストにタスクを作る。作った直後に `POST /sent` で記録する(`data_source` に To Do のデータソース、`sent_ref` に作ったタスクの `id`、`subject` にタスクの名前、`body` に要点、`source_thread_id` に元のスレッド。`to` は要らない)。タスクのスレッドができて、元のスレッドと経路 `sent` で結ばれる。1 つのタスクが複数のスレッドにまたがれば、残りは `POST /threads/{タスクのid}/links` で結ぶ。チームに誰の担当かを見せたいなら、元のスレッドを `claim` で担当する(Jira などはソースで担当者を変える)
2. **外に出したものはタスクから記録する**: PR を出した・課題にコメントした・返信したら、`record_sent` の `source_thread_id` にタスクのスレッドを入れる。送ったスレッドとタスクが経路 `sent` で結ばれ、レビューや返事が返るとタスクの `derivedBall` が `my_turn` になる。実装・レビュー・修正のループが 1 本のタスクに綴じられる
3. **経過はメモに書く**: 指示・結果の要約・判断・次の一手を `POST /notes`(`thread_id` にタスクのスレッド)で足す。書き手を `author` で分ける(人の言葉は `user`、エージェント自身が書いたものは `{"kind":"agent","name":...}`)。To Do のタスクの本文には書かない(本人のタスクのアプリが経過で埋まる)
4. **終わったら To Do で完了にする**: 結んだ先が完了しても(`closedAtSource`)、タスクは自動では閉じない。完了にしてよいかをユーザーに聞いてから、microsoft-graph スキルでタスクを完了にする(Murmur の `dismiss` ではない。写しの `closedAtSource` で閉じる)。期限を変えるのも To Do で
5. 進み具合や「委譲中」は To Do にも Murmur にも状態として持たない。タイムラインで読める

一覧(`filter=mine`)は自分のタスクで、タスク自身か結んだ先の新しい更新(`lastActivityAt`)の順に並ぶ。結んだ PR にレビューが返れば、メモに何も書かれていなくても上に来る。

メールの件は、タスクを作るまでもなければ、本人の Outlook のスレッドにそのままメモを書けばよい(電話で確かめた、来週まで保留、など)。

### エージェントとして参加するとき

**次の一手を決める者が書く。**

- オーケストレータの下で動くエージェント(boid の job、サブエージェント)は Murmur に書かない。結果をオーケストレータに返し、オーケストレータが判断してタスクのスレッドにメモする
- 自分のきっかけで動く参加者(オーケストレータ自身、PR を見張ってレビューするエージェント)は、タスクのスレッドを読み、`author` に自分の名前を付けて書く。名前は参加者を見分けられるもの(`orchestrator`・`codex`・`claude-code` など)にする
- 担当は本人のまま。タスクが `my_turn` になったら、エージェントが対応するか、人に回すかを決める。人に答えてほしいことは、メモに質問として書いて(`author` はエージェント)、ユーザーに知らせる
- ループの止め方を決めておく。レビューと修正が何周もしたら人に回す。参加者が互いの書き込みに反応し続けないようにする
- Murmur は参加者に通知しない。`GET /threads/{タスクのid} -q since=<前回見た時刻>` か、外のサービスのきっかけ(PR のイベントなど)で拾う
- タスクとメモが見えるのは本人(とその代理)だけ。チームの別の人に渡すことは、PR や課題など外のサービスに書く

## 守ること

- **送ったら記録する。** スタンド経由で外へ送った・起票した・コメントしたら、その直後に `record_sent` を呼ぶ。送る前には呼ばない(送れなかったものを記録しない)。`sent_ref` は送信の API が返した ID(メールの Message-ID、Slack の ts、LINE の sentMessages[].id、Jira の課題キーやコメント ID、To Do のタスクの ID)。同じ `sent_ref` で 2 回呼んでも 1 回分しか残らない
- **共有のスレッドには、事実と構造の操作だけ。** 送信の記録・担当する・名指しを外す・結ぶ・振り分けの直し・片付けは共有のスレッドにしてよい。進み具合・作業のメモは、個人リストのスレッド(自分のタスク)に書く。共有のスレッドにメモを書こうとすると `invalid` になる
- **リンクは両端を読める人にしか見えない。** 共有のスレッドを自分のタスクや自分の受信トレイのスレッドと結んでも、ほかの読者にはリンクがあることも見えない。チームに伝えたい進み(メールで先方に確かめた、課題で直した など)は、ユーザーと伝える粒度を決めて、共有のデータソースに書く(LINE で返す、Slack のスレッドに書く、課題にコメントする)。書いたら `record_sent` で記録する
- **組織をまたがない。** 送ったのと同じ組織のコネクタの Murmur に記録する。組織が違えば Murmur も違うので、別の組織の連絡やスレッドを、この組織の Murmur のメモに書き写したり結んだりしない。タスクも、その組織のアカウントの To Do に作る
- 送る前の確認(宛先・本文・送信元・返事期待)はユーザーに見せて、送信の指示をもらう。これは Murmur の承認ではなく、ユーザーとの会話でのゲート
- **リンクは候補を見て、ユーザーと決めてから張る。** `get_thread` の `linkCandidates` はアンカー(課題キー・PR・メッセージ ID)が一致したものにすぎない。同じ件でなければ結ばない
- メモ・片付け・開き直し・タスクの完了は本人の側の状態。結んだ先が動いても(`linkedActiveSinceDismissed`)、閉じたタスクを勝手に開き直さない。ユーザーに知らせて決めてもらう(開き直すなら To Do で)
- **Jira など状態を持つデータソースのスレッドの状態はソースの写し(`source`: `holders` = ソースの担当者のアカウント、`statusLabel`、`due`。完了は `closedAtSource`、件名は `title`)。** Murmur では書けない。変えるときは Jira・To Do の側で(jira スキル・microsoft-graph スキルなど)変えれば、写しとして戻ってくる。本人が付ける属性はない(タスクの期日は To Do の期限の写し `source.due`)
- 状態を持つデータソースのスレッドの担当は、ソースの担当者(`source.holders`。Jira は担当者、PR はレビュー待ちならレビュアー・変更を求められたら作者)。読者ならその人の番(`myTurn` に `assignee`)。完了(`closedAtSource`)ならどの見え方にも数えず、`filter=open` にも出ない
- 担当(`assignee`)・名指し(`attention`)・返事期待(`replyExpectedBy`)・期限超過(`overdue`)はイベントから決まる。書き換える操作はない
- **名指しは、読んで判断したら外す。** 自分への名指し(`attention.named` の `userId` が自分、または `attention.list` に自分)は、対応が要らないと決めたか、対応を決めたら `acknowledge` で外す。外すまで `my_turn` に残る。対応が要るのか FYI かは、本文を読んで決める(Murmur は判断しない)。返事を送るときは `record_sent` の `acknowledge: true` で一緒に外す
- **待っていた相手から返事が来たら、相手の名指しも外す。** 読者でない相手(お客さん・まだ参加していないメンバー)は自分で外せないので、返事を読んで、待っていた返事が来たなら `acknowledge` の `addresses` にその相手を入れて外す(足りなければ残す)。外すまで相手待ち(`awaiting`)と期限超過(`overdue`)が残る(期限超過は読者でない宛先で決まるので、社内の CC は気にしなくてよい)。読者の名指しは本人しか外せない。個人の箱にエイリアスや配布リスト宛てで届いたものは、本人へのリスト宛て(`attention.list`)として出る
- 後から参加した(読者になった)ときは、過去の自分宛ての名指しが残っているので、ユーザーに確かめてから `POST /acknowledge` でまとめて外す

## API

| ツール | メソッドとパス | 入力 | 返すもの |
| --- | --- | --- | --- |
| me | `GET /me` | | User(`user`)、自分の Contact(`contact`。まだなければ `null`)、読者になっているリスト(`lists`。データソース) |
| list_lists | `GET /lists` | | 見えるリストの一覧(データソース・読者(`userId`・`name`・`contactId`)) |
| get_list | `GET /lists/{list_id}` | | データソース・読者 |
| list_threads | `GET /threads` | `-q filter=my_turn\|mine\|open\|awaiting\|overdue\|triage\|all`(既定 `open`。`my_turn` は自分が担当か自分への名指しが残っているもの、`awaiting` はこちらから送って名指しした読者でない相手の名指しが残っているもの、`triage` は共有リストで担当のいないもの)、`-q data_source=...`、`mine` は自分の To Do のタスク(閉じたものも)、`-q since=<ISO 8601>`(それより後に動いたものだけ。タスクは結んだ先が動いても入る) | スレッドの一覧(自分か見える結んだ先の最新の更新 `lastActivityAt` の新しい順)。各スレッドに `assignee`(担当。`by` は `source` / `claim`、`userIds`・`contactIds`・`addresses`。個人リストと担当のいないものは `null`)・`attention`(残っている名指し。`named`: `[{address, userId, contactId, signalId, at}]`(`userId` は読者なら本人、読者でなければ `null`)、`list`: リスト宛ての名指しが残っている読者 `{userIds, signalId, at}` か `null`)・`myTurn`(自分の番の理由 `assignee` / `named` / `list`。空なら自分の番でない)・`triage`・`awaiting`・`links`・`source`(写し)・`derivedBall`・`linkCandidates`・`overdue`・`closedAtSource`(ソースで完了) など |
| get_thread | `GET /threads/{thread_id}` | `-q since=<ISO 8601>`(省略可。タイムラインをそれより後に絞る) | `thread`(一覧と同じ項目)、`dataSource`、`linked`(結んだ先。両端を読めるものだけ。見えないスレッドへのリンクは、あることも出ない)、`timeline`(このスレッドのシグナル・メモ・操作と、結んだ先のシグナルを時刻順に。メモは `kind: "note"` で `note: {noteId, body, author}`) |
| add_note | `POST /notes` | `{"thread_id", "body", "author"?}`。個人リスト(自分のタスク・自分の Outlook)のスレッドにメモ(経過)を書く。共有リストのスレッドは `invalid`。新しく追うものは To Do にタスクを作って `record_sent` する(スレッドは作らない)。`author` は書き手で、人の言葉(中継を含む)なら省略か `{"kind":"user"}`、エージェント自身が書いたもの(judge・結果の要約・提案)なら `{"kind":"agent","name":"orchestrator"}` のように名前を付ける。タイムラインのメモに `note.author` で出る(誰の番には使わない) | そのスレッド(`get_thread` と同じ) |
| claim_thread | `POST /threads/{thread_id}/claim` | `{"user_id"?, "reason"?}`。省略で自分が担当する、`null` で手放す、ほかの読者の User ID で引き継ぐ。状態を持つソース(Jira など)と個人リストでは `invalid` | `get_thread` と同じ |
| acknowledge | `POST /threads/{thread_id}/acknowledge` | `{"until_signal_id"?, "addresses"?, "reason"?}`。`until_signal_id`(省略で最新のシグナル)までの名指しを外す。`addresses` を省けば自分への名指し(自分のアドレスとリスト宛て)、渡せば `[{"channel","value"}]` のアドレス(自分のものか、このリストの読者でないもの。ほかの読者のものは `forbidden`)。外すものがなければ何もしない | `get_thread` と同じ(`timeline` に `kind: "acknowledged"`) |
| acknowledge_many | `POST /acknowledge` | `{"thread_ids": [...], "reason"?}`。それぞれの最新のシグナルまで、自分への名指しをまとめて外す(参加したときなど) | `{"acknowledged": <外したスレッドの数>}` |
| link_threads | `POST /threads/{thread_id}/links` | `{"thread_id", "reason"?}`(結ぶ相手) | `get_thread` と同じ。候補から張れば経路 `anchor`、それ以外は `manual` |
| unlink_threads | `POST /threads/{thread_id}/unlink` | `{"thread_id", "reason"?}` | `get_thread` と同じ |
| dismiss_thread | `POST /threads/{thread_id}/dismiss` | `{"reason"}`(必須)。仕分け待ちから片付ける。To Do のタスクは `invalid`(To Do で完了にする) | `get_thread` と同じ |
| reopen_thread | `POST /threads/{thread_id}/reopen` | `{"reason"?}`。To Do のタスクは `invalid`(To Do で開き直す) | `get_thread` と同じ |
| move_signal | `POST /signals/{signal_id}/move` | `{"thread_id"}` か `{"new_thread_title"}` のどちらか、`"reason"`(必須) | 移した先のスレッド(`get_thread` と同じ) |
| record_sent | `POST /sent` | 下の「送信の記録」 | 送ったシグナルの入ったスレッド(`get_thread` と同じ) |
| rename_me | `PATCH /me` | `{"name"}` | `me` と同じ |
| connect_outlook | `POST /connections/outlook` | `{"credential_id"?}`(ゲートウェイの Graph の接続。複数あるときだけ) | `status`: `authorize`(`authorize_url`)・`choose`(`credentials`)・`no_credential`(`register_url`)・`connected`(`data_source`、`created`)。上の「Outlook をつなぐ」 |
| connect_todo | `POST /connections/todo` | `{"credential_id"?, "list"?}`(`list` は `choose_list` の `lists[].id`) | `connect_outlook` と同じ + `choose_list`(`lists`: `[{id, name, wellknown}]`)。別のリストを既につないでいれば `conflict`。上の「To Do をつなぐ」 |
| connect_jira | `POST /connections/jira` | `{"credential_id"?, "site"?, "project"?}`(`site` は `choose_site` の `sites[].id`、`project` は `choose_project` の `projects[].key`) | `connect_outlook` と同じ + `choose_site`(`sites`)・`choose_project`(`projects`)。`forbidden` はデプロイで許していない。上の「Jira をつなぐ」 |
| connect_teams | `POST /connections/teams` | `{"credential_id"?, "team"?, "channel"?}`(`team` は `choose_team` の `teams[].id`、`channel` は `choose_channel` の `channels[].id`) | `connect_outlook` と同じ + `choose_team`(`teams`)・`choose_channel`(`channels`)。`forbidden` はデプロイで許していないか Entra ID でない。上の「Teams をつなぐ」 |
| list_connections | `GET /connections` | | 自分がつないだものと、読者になっている共有リスト(`kind`: `outlook` / `todo` / `jira` / `teams`、To Do は `list`、Jira は `site`・`project`、Teams は `team`・`channel`、共有リストは `shared: true`・`created_by`)と取り込みの状態(`status`: `setup` / `ok` / `broken`(`reason`) / `disconnected`)、`last_sync_at` |
| disconnect | `POST /connections/{data_source}/disconnect` | | 取り込みを止める。共有リストは作った人と管理者だけ。スレッドとデータソースは残る |
| create_data_source | `POST /data-sources` | `{"channel", "name", "identity", "gateway_credential_id", "description"?, "group"?}`。個人のリスト(読者は自分だけ) | `get_list` と同じ + `identity`(上の「初めてつないだとき」) |
| set_identity | `POST /lists/{list_id}/identity` | `{"identity"}`(そのリストでの自分のアカウント) | `identity` の結果(`kind`・`contactId`) |
| list_unresolved | `GET /addresses/unresolved` | | `[{channel, value, count, lastSeenAt, threadIds}]`(最後に見た順) |
| search_contacts | `GET /contacts` | `-q q=<名前かアドレスの一部>` | `[{id, name, userId, addresses: [{id, channel, value, validFrom, validTo}], externalRefs}]` |
| get_contact | `GET /contacts/{contact_id}` | | Contact(まとめて消えた ID はまとめ先) |
| create_contact | `POST /contacts` | `{"name", "address"?: {"channel", "value"}}` | Contact |
| rename_contact | `PATCH /contacts/{contact_id}` | `{"name"}` | Contact |
| add_address | `POST /contacts/{contact_id}/addresses` | `{"channel", "value", "valid_from"?, "reason"?}`。同じ時点で別の Contact に付いていれば `conflict` | Contact |
| end_address | `POST /contacts/{contact_id}/addresses/{address_id}/end` | `{"valid_to"?, "reason"?}`(省略で今) | Contact |
| merge_contacts | `POST /contacts/{contact_id}/merge` | `{"from", "reason"?}`(`from` をまとめる。両方に User があれば `conflict`) | まとめ先の Contact |
| unbind_contact | `POST /contacts/{contact_id}/unbind` | | Contact(自分の Contact だけ。見えるものは変わらない) |

Contact の API(`/contacts`・`/addresses/unresolved`)は、どれかのリストの読者(チームのメンバー)だけが使える(ほかは `forbidden`)。

エラーは `{"error": "not_found" | "invalid" | "forbidden" | "conflict", "message": ...}`。見えないスレッドやデータソースは、存在していても `not_found` になる。

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

- `data_source`: 送ったデータソース(送信元のメールボックス・LINE 公式アカウントなど)。`get_thread` の `dataSource.id`、または `list_lists`
- `to` か `to_contact_ids` のどちらかは必須(To Do のタスクを作った記録だけ要らない)。`to` はそのチャネルのアドレス
- `from`(任意): 実際に送ったアドレス。Jira のコメントや Slack の発言のように自分のアカウントで書いたときは、そのアカウントを入れる。省けばデータソースの窓口(共有メールボックス・LINE 公式アカウント)、窓口がなければ(個人の箱)自分のアドレス。そのデータソースでこちらのアドレスでなければ invalid
- `reply_to_thread_id`: 返事をしているスレッド(同じデータソース)。送ったシグナルはそこに入る。省略すると、アンカーで決まらなければ新しいスレッドになる
- `source_thread_id`: 送る元になったスレッド(どのデータソースでもよい。タスクのスレッドや、LINE の欠勤のスレッドから打診を送るときなど)。送ったスレッドと経路 `sent` で結ばれる
- `reply_expected_by`: 返事期待の期限(ISO 8601、オフセット付きでよい)。過ぎると `overdue` になる。返事が来たら、読んで相手の名指しを `acknowledge` で外すと消える
- `acknowledge`(任意): `true` なら、送ったスレッドの、送る前までの自分への名指しを一緒に外す。返事をしたら付ける
- 宛先の人が名指しされる(相手待ち)。返事は同じデータソースに戻り、送ったスレッドに入る
- **Jira の起票**: `sent_ref` に課題キー、`anchors.thread_key` にも同じ課題キーを入れる。`to_contact_ids` は担当者、`source_thread_id` に起票の元になったスレッド(LINE・メール・Slack など)。課題のスレッドができて元のスレッドと経路 `sent` で結ばれ、課題の状態(写し)とコメントはそのスレッドに入る
- **Jira のコメント**: `sent_ref` にコメント ID、`anchors.thread_key` に課題キー、`reply_to_thread_id` に課題のスレッド
- **To Do のタスクを作った**: `data_source` に To Do のデータソース、`sent_ref` にタスクの `id`、`subject` にタスクの名前、`source_thread_id` に元のスレッド。`to` は要らない。タスクの ID がそのスレッドの区切りになり、あとから届く写し(件名・期限・完了)も同じスレッドに入る

## よくある流れ

1. 「今日やることは？」: `GET /threads -q filter=my_turn`。`myTurn` で理由(担当・名指し・リスト宛て)を添えて見せる。名指しだけのものは本文を読んで、対応が要るか FYI かを分けて伝え、FYI と決まったものはユーザーに確かめて `acknowledge` で外す。仕分け待ち(担当のいないもの)は `filter=triage`、返事待ちは `filter=awaiting`、期限超過は `filter=overdue`。前回から何が動いたかは `-q since=<前回見た時刻>`
2. 「この件は私が持つ」: `POST /threads/{id}/claim`(Jira などはソースで担当者を変える)。引き継ぐなら `{"user_id": "..."}`、手放すなら `{"user_id": null}`
3. 「この課題に着手する」: 上の「タスクとして追う」。To Do にタスクを作る → `POST /sent` で記録して元のスレッドと結ぶ → (チームに見せるなら)元のスレッドを `claim`。以後、外に出したものは `source_thread_id` にタスクのスレッドを入れて記録し、経過はタスクのスレッドにメモする
4. 「この件をまとめて追いたい」: To Do にタスクを作って `POST /sent` で記録する → `GET /threads/{id}` の `linkCandidates` と、ユーザーの話から関係するスレッドを選ぶ → `POST /threads/{タスクのid}/links`。LINE の 1 本だけで済むなら、タスクを作らず持つだけでよい。自分のメールの 1 本なら、そのスレッドにメモを書くだけでよい
5. 「この件に返信して」「協力会社に依頼して」: `GET /threads/{id}` で経過を読む → 文面と宛先・返事期待をユーザーに確認 → 送信のスキルで送る → **すぐ `POST /sent`**(返信なら `reply_to_thread_id` と `acknowledge: true`、別の相手への依頼なら `source_thread_id` に元のスレッド)
6. 「あのタスク、どうなった？」: `GET /threads/{タスクのid}`。`derivedBall` が結んだ先から見た状態(`my_turn` / `waiting`)、`timeline` に結んだ先の受信も並ぶ
7. 「もう対応不要」: 仕分け待ちなら `POST /threads/{id}/dismiss`、件が片付いたら To Do でタスクを完了にする(ユーザーに確かめてから)。また動いたら、仕分け待ちは `reopen`、タスクは To Do で開き直す
8. 「振り分けが違う」: `POST /signals/{signal_id}/move`(既存のスレッドか新しいスレッドへ)。違うスレッドと結んだら `unlink`
9. 「これ課題にして」: 起票の内容(要約・説明・担当者)をユーザーに確認 → jira スキルで起票 → **すぐ `POST /sent`**(`sent_ref` と `anchors.thread_key` に課題キー、`source_thread_id` に元のスレッド)。ステータスや担当者を変えたいときは jira スキルで Jira を直接変える
