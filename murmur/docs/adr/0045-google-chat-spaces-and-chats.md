# 0045 Google Chat のスペースを共有リストに、DM とグループのチャットを個人リストにする

- 状態: 採用（2026-11-17、直樹。S0 の後半を見てから）。実装はスペースの共有リスト → DM の個人リスト → スキルの順。スペースのタスクは入れない（下の「スペースのタスクを入れない理由」）。S0 は前半（スペースのタスク）・後半（Chat API の実物）とも `docs/research/2026-11-17-google-chat-space-tasks-s0.md`。後半の結果は末尾の「実物で確かめたこと」
- 関連: 0009（区切りの 4 段）、0012（外には書かない）、0024（購読は本体が持つ）、0030（Contact とアドレス）、0035（範囲の外は取り込まない）、0036（Teams のチャネル。スペースの手本）、0037（共有リストはスペース単位）、0038（担当と名指し）、0041（Google は見回り）、0043（表の言葉）、0044（Teams のチャット。DM の手本）、H3・H5・H8

## 背景

Microsoft 365 の組織では、Teams のチャネル（0036）とチャット（0044）が入った。Google Workspace の組織のデプロイには、チャットのコネクタがまだない。Google Workspace の組織では、依頼や確認は Gmail より Google Chat で来ることが多く、0044 の背景と同じことが起きる（「自分宛てのものは?」にチャットの依頼が出てこない、結ぶ先がない、`record_sent` が観測と 1 つにならない）。

最初は、スペースのタスク（スペースの「タスク」タブ）を、Google Workspace の中で完結する共有のタスクリストとして写すことを考えた。調べた結果、公開の API では割り当てのないタスクも他人のタスクも読めないので、やめた（下）。代わりに、スペースのスレッドそのものを共有リストにする。Teams のチャネル（0036）と同じく、メンションで名指しし、名指しのない依頼は割当待ちになり、誰かが担当すれば（`ThreadClaimed`）ほかのメンバーのエージェントにも「○○さんが対応している」と見える。ふつうのチャットのスレッドで、タスクの共有が成り立つかを確かめるのが、この ADR のねらいでもある（0036 の背景と同じ）。

## スペースのタスクを入れない理由（2026-11-17 に調べた）

- スペースのタスクの本体はスペースの側にあり、UI ではメンバー全員が割り当てのないものも見られる（Google のヘルプ）
- 公開の Tasks API で見えるのは、割り当てられた人の既定のリストの写しだけ（`tasks.list` の `showAssigned=true`、`assignmentInfo.spaceInfo.space` 付き）。実物でも確かめた。スペースの ID をタスクのリストの ID として渡すと 400
- Chat API（メッセージ・一覧）と Workspace Events の Chat のイベントの種類には、タスクの項目もイベントもない。スペースに出るタスクの通知は、ドキュメントにない（システムのメッセージは `messages.list` に出ない、ともある）
- したがって共有リストにするには、読者それぞれの委任で「自分に割り当てられた分」を集めるしかなく、割り当てのないタスクは入らず、0037 の決定 3（つないだ人 1 人の委任で読む）も改めることになる。得るものに対して形が崩れすぎる
- 今の Google Tasks の個人リスト（0041）は `showAssigned` を付けないまま。本人に割り当てられた分も、当面は入れない（未決 3）

## 決定（案）

### 1. スペース（`spaceType: SPACE`）は共有リスト（0036・0037 の形）

- スペース 1 つが、1 つのスペース・1 つの共有リスト（0037 の決定 1）。名前はスペースの表示名
- 読者はスペースのメンバー（`spaces.members.list`）のうち、Murmur の User に対応が付く人。ゲートウェイのサインインが Google なら、ゲートウェイの User ID（`google_<sub>`）の sub と、Chat のメンバーの `users/<ID>` の ID が同じ Google のアカウントの ID なので、名乗りなしで付く（0037 の決定 2 の「同じ IdP」。同じかは S0 の後半で確かめる）。`type: BOT` のメンバーは外す
- 経路はつないだ人の委任（ゲートウェイの新しいサービス `chat`）。作れるのはメンバーなら誰でも、デプロイの設定 `MURMUR_SHARED_SERVICES` に `google-chat` があるとき（0037 の決定 4）
- **区切り**: Chat のスレッド（`thread.name`）をアンカー `threadTs` にする。スレッドの返信は構造で入り、スレッドの最初のメッセージは AI の区切りに回す（0036 の決定 3 と同じ）。スレッドを使わないスペース（`spaceThreadingState` が `UNTHREADED_MESSAGES`）は、メッセージごとに `thread` が 1 つ付くだけなので、`threadTs` にせずメッセージごとに AI の区切り（S0）
- **名指し**: 個人へのメンション（`annotations` の `USER_MENTION`）を宛先にする。`@all` は個人に落とさない。メンションのないメッセージは宛先なしで、名指しのない依頼は割当待ちになり、担当する操作（`ThreadClaimed`）を待つ（0036 の決定 4、0038）
- 編集・削除・リアクション・アプリ（`type: BOT`）の投稿は取り込まない（0036 と同じ）

### 2. DM とグループのチャットは、本人の個人リスト 1 つ（0044 の形）

- `spaceType` が `DIRECT_MESSAGE` と `GROUP_CHAT` のものを、まとめて「Google Chat のチャット」という個人リスト 1 つにする（1 人に 1 つ。読者は本人だけ）
- 区切りの候補は会話で同じ DM・グループに限る（`Anchors.conversationId` にスペースの名前、`conversationGroup` は `GROUP_CHAT` なら真）。0044 で足した仕組みをそのまま使う
- 名指しは 0044 の決定 3 と同じ: DM は相手のメッセージ全部、グループはメンションだけ
- 相手がアプリだけの DM は取り込まない（0044 と同じ）
- グループのチャットのスレッドも `thread.name` があれば `threadTs` にする

### 3. アドレス: チャネル `google-chat`、値はアカウントの ID

- `Channel` に `google-chat` を足し、値は `users/<ID>` の `<ID>`。スペースと DM で同じ人は同じアドレス
- つないだとき・読者を写すときに、本人の Contact に本人の `google-chat` のアドレスを付ける（sub から分かる）
- ドキュメントでは、ユーザーの認証で読むと `User` に `name` と `type` しか入らないとあるが、**実物では送り手・メンバー・メンションに `displayName` と `email` が入った**（S0）。コネクタは名前の候補を持たせる（Teams のチャネルと同じ）。メールアドレスは、ないときにも動くように、あれば使う程度にする（未決 1）。Contact を作るのは 0035 のとおりエージェント

### 4. 取り込み: 見回り（0041 の決定 1）

- Pub/Sub と Workspace Events API は使わない（0041 と同じ。デプロイの設定が重い）。5 分ごとの `maintain` で読む（未決 2）
- **スペース**: `spaces.messages.list` を `filter=createTime > "<前回 − 重なり>"` で読む（一覧の絞り込みは `createTime` と `thread.name` だけ）。スレッドの返信も `createTime` で拾える（チャネルの返信が delta に出なかった Teams と違い、返信も 1 通のメッセージ）。二重は `sourceRef`（`google-chat:<message の name>`）で落ちる。重なりは S0 の後半で決める
- **個人リスト**: `spaces.list`（`spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"`）で本人の DM・グループを読み、`lastActiveTime` が前回より新しいものだけを、同じく `messages.list` で読む。1 回の見回りで読むスペースの数に上限を置き、残りは次の見回りに回す（0044 と同じ）
- 量と Chat API のクォータ（ユーザーごとの読み取りの上限）は、S0 の後半と試用で見る

### 5. ゲートウェイ

- カタログに Google Chat のサービス `chat`（`chat.googleapis.com`）を足す。スコープは読み取りの `chat.spaces.readonly`・`chat.messages.readonly`・`chat.memberships.readonly` と、エージェントが投稿するための `chat.messages.create`
- デプロイの手順に「Google Cloud のプロジェクトで Chat API を有効にし、Chat アプリの構成（名前とアイコン）を作る」を足す（Chat API は、ユーザーの認証でも Chat アプリの構成を求める）
- 読める口を 2 つ足す（0044 の決定 6 と同じ分け方）
  - `google-chat`（スペースの共有リスト）: `spaces/{space}` の GET、`spaces/{space}/members` の GET、`spaces/{space}/messages` の GET、つなぐときの `spaces` の一覧
  - `google-chat-dm`（個人リスト）: `spaces` の一覧、`spaces/{space}/members` と `messages` の GET
  - 投稿の口は通らない。`{space}` は入口では固定できないので、コネクタはデータソースのスペースか、一覧で得たスペースだけを呼ぶ（0042 の決定 6 と同じ割り切り）。共有リストの経路から、窓口の人の DM を読まないようにする

### 6. つなぎ方と API

- `POST /connections/google-chat`（`space` を省けば、つなぐ人がメンバーのスペースの一覧で `choose_space`）。スペースの共有リスト。既にあれば 0037 のとおり、読者を写し、止まっていればつなぎ直す
- `POST /connections/google-chat-dm`（選ぶものはない）。本人の個人リスト。1 人 1 つ
- Google でサインインするゲートウェイだけ（sub が要る）
- `GET /connections` に `kind: google-chat`・`google-chat-dm`
- スキル: topic-index に「Google Chat のスペースをつなぐ」「Google Chat のチャットをつなぐ」と、つないだらスペースに知らせる（0037 の決定 4）。プラグイン `heddleway-google` に Google Chat のスキル（スペースの一覧・メッセージの読み書き・スレッドへの返信。`record_sent` の `sent_ref` はメッセージの `name`）

### 7. 進める順番

1. ゲートウェイ: `chat` のサービスと、デプロイの手順
2. S0 の後半（下）
3. 採用して、スペースの共有リストから実装 → DM・グループの個人リスト → スキル

## S0 の後半で確かめること

- Chat API が委任で読めるか（スペースの一覧・メンバー・メッセージ）
- `users/<ID>` の ID が、ゲートウェイの User ID の sub と同じか。People API の ID と同じか
- `messages.list` の `createTime` の絞り込みと並び。スレッドの返信が `createTime` で拾えるか
- メンションの `annotations` の形（`@all`、アプリへのメンション）
- `spaces.list` の `lastActiveTime` が、メッセージが来たときに動くか
- Workspace Events API の購読（スペースのメッセージの作成）が、本人の委任で作れるか（未決 2）
- 外部のユーザー（別のドメイン）の `users/<ID>` の形

## 代案

- **A. スペースのタスクを、読者それぞれの委任で集めて写す**: 上の「入れない理由」。割り当てのないタスクが入らず、0037 の決定 3 を改める
- **B. スペースをアプリの権限（ドメイン全体の委任）で読む**: 管理者がサービスアカウントにドメイン全体の委任を付ければ、メンバーになりすまして読める。ただ、組織の全員のチャットに届く権限を本体に持たせる。0036 の代案 A・0042・0044 の代案 C と同じ理由で使わない
- **C. Workspace Events API と Pub/Sub で通知を受ける**: 遅れが減るが、0041 の決定 1 と同じくデプロイの設定が重い。見回りで足りなければ後から足す（未決 2）

## 帰結

- ドメイン: `Channel` に `google-chat`。区切りと名指しは 0036・0044 の仕組みのまま
- コネクタ: `src/connectors/google-chat/`（スペースと DM。正規化・見回りの計画は純関数）
- ゲートウェイ: カタログの `chat`、読める口 2 つ、デプロイの手順
- API とスキル: 決定 6

## 未決

1. ~~相手の名前の候補を People API・Directory API で引くか~~ → 送り手・メンバーに表示名が入るので引かない（S0）。メールアドレスも入るが、ドキュメントにない振る舞いなので、名寄せの手がかりに使うか（Gmail のアドレスと同じ人を、エージェントが付けやすくする）は実装で決める
2. 見回りの遅れ（最大 5 分）で足りるか。足りなければ Workspace Events API と Pub/Sub をデプロイの任意の設定として足す。直樹はリアルタイム性を上げたい（ユーザーの投稿に反応したい、2026-11-17）。候補は 2 つ: (a) Workspace Events API の購読（本人の委任でスペースのメッセージの作成を購読。届け先は Pub/Sub で、デプロイの設定が増える。本命）、(b) インタラクティブな Chat アプリ（コールバック URL に HTTP で届き Pub/Sub は要らないが、アプリをスペースに足す必要があり、届くのはアプリへのメンションだけらしい。未確認）。どちらも見回りは保険として残す（0024 の決定 2）。S0 の後半で、(a) の購読が委任で作れるかと、届くイベントの範囲を見る。当面は Chat アプリの構成をインタラクティブ機能なしで作る
3. ~~Google Tasks の個人リストに、スペースで本人に割り当てられたタスクを入れるか~~ → 当面は入れない（2026-11-17、直樹）。`showAssigned` は付けないまま

## 実物で確かめたこと（S0 の後半、2026-11-17）

`docs/research/2026-11-17-google-chat-space-tasks-s0.md` の後半。要点:

1. 委任でスペース・メンバー・メッセージが読める。`users/<ID>` は sub と同じ（決定 1 の読者の対応が名乗りなしで付く）
2. 送り手・メンバー・メンションに表示名とメールアドレスが入る（ドキュメントと違う。決定 3）
3. スレッドは `thread.name`、返信は `threadReply`（最初のメッセージには付かない）。`UNTHREADED_MESSAGES` のスペースではメッセージごとに `thread` が 1 つ（決定 1）
4. メッセージの 8 割はメンションなし（「ビルメンNEXT開発」で 359 件中 283）。名指しのない依頼の割当待ちが、このリストの使いどころ
5. 一覧は既定で `createTime` の古い順、`createTime > "…"`・`thread.name = …`・`orderBy=createTime desc` が通る。`lastActiveTime` は最後のメッセージの `createTime` と一致（決定 4）

まだ見ていないこと: Workspace Events API の購読（未決 2。Pub/Sub のトピックが要る）、グループのチャット（試した組織に 0）、外部のユーザー、`@all`、返信で `lastActiveTime` が動くか。

## 実装の記録（2026-11-17）

- ドメイン: チャネル `google-chat`（値は Google のアカウントの ID）。接続先 `google-chat`（`space`・`threaded`。共有リスト、spaceKey は `google-chat:<space>`）と `google-chat-dm`（`account`。1 人に 1 つの個人リスト）。`connectGoogleChatSpace`・`connectGoogleChatDms`、`googleChatAccount`（`users/<ID>` → `<ID>`）・`googleUserId`・`googleAccountOf`（`google_<sub>` ↔ `<sub>`）。`dataSource.origin` に `{ kind: 'google-chat', space }`・`{ kind: 'google-chat-dm' }`
- コネクタ（`src/connectors/google-chat/`）: 正規化は決定 1〜3 のとおり。スレッドを使うスペースは `thread.name` を `threadTs`、使わないスペース（`UNTHREADED_MESSAGES`）は `threadTs` なし。宛先は `USER_MENTION` の `MENTION` で相手が `HUMAN` のものだけ（`@all`・アプリ・追加は落とす）。引用は `quotedMessageId`。`sourceRef` は `google-chat:<message の name>`、`messageId` はメッセージの `name`（`record_sent` の `sent_ref` と同じ）。アプリ（`BOT`）と削除は取らない。名前は使わない（S0 で入ると分かったが、Contact はエージェントが作る）
- 取り込み: 5 分ごとの見回り。スペースは `createTime > 位置 − 10 分` を古い順に読み、位置は読んだ中で一番新しい `createTime`。1 回にスペース 1 つで 5 ページ（200 件）まで。上限で止めたら `pagedOut` を残し、次は重なりなしで続きから（重なりの読み直しで上限を使い切らない）。読者は 60 分ごと（と setup で）メンバーの `HUMAN`・`JOINED` から `google_<ID>` で写す。つないだ人が外れる・スペースが 403/404 なら broken。DM・グループは `spaces.list`（`DIRECT_MESSAGE OR GROUP_CHAT`）の `lastActiveTime` が位置より新しいものだけを、新しい順に 1 回 50 まで読む。種類とメンバーは運用の状態に覚えて 1 日ごとに読み直す（アプリとの DM・メンバーが読めないものは `skip`）。DM 1 つの 403/404 は接続を止めずにその DM を `skip` にする
- 書き込みは、そのつど今の状態を読み直して見回りの項目だけを重ねる（外された・つなぎ直されたら止める。0041 の Google Tasks と同じ）
- 口: `UpstreamKind` に `google-chat`・`google-chat-dm`。どちらもゲートウェイの `chat` の接続（`MURMUR_CHAT_SERVICE` で変えられる）。読める口は GET だけで、スペースの口は一覧・1 つ・メンバー・メッセージ、DM の口は一覧・メンバー・メッセージ。スペースと DM はパスでは区別できない（決定 5 の割り切り）
- API: `POST /connections/google-chat`（`{credential_id?, space?}`。`choose_space` は `SPACE` だけ。デプロイの設定 `MURMUR_SHARED_SERVICES` に `google-chat` が要る）、`POST /connections/google-chat-dm`。どちらも Google でサインインするゲートウェイだけ（`forbidden`）。`GET /connections` に `kind: google-chat`（`space`）・`google-chat-dm`
- スキル: topic-index に「Google Chat のチャットをつなぐ」「Google Chat のスペースをつなぐ」と、`record_sent` の「Google Chat で送った」（heddleway 0.29.0）。heddleway-google に `google-chat` スキル（一覧・読み取り・投稿・スレッドへの返信・メンションの書き方、heddleway-google 0.16.0）。同意の文面に Google Chat
- 試用で見ること: 返信で `lastActiveTime` が動くか（DM の見回りが頼っている）、`@all` の形、外部のユーザー、グループのチャット、人数の多いデプロイでの Chat API のクォータ
