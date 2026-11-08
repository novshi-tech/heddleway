# Murmur — スレッドとリンクのプロトタイプ

連絡から対応の要る件を拾い、その経過を追跡する（`docs/adr/0012`）。エンティティはスレッドの 1 種類。スレッドはデータソースの写しで、リストはデータソースごとに 1 つ（チームで共有、見えるのはそのデータソースの読者）。リストは個人リスト（読者が本人 1 人）と共有リストの 2 つだけ。Murmur が正なのはスレッドへの人とスタンドの操作だけで、メモ（経過の記録）もその 1 つ（`docs/adr/0014`・`0039`）。スレッド同士を結ぶのは人とスタンドで、Murmur はアンカーの一致を候補として見せるだけ。
そのデータモデルとアーキテクチャが成立するかを、外部接続なしで確かめるためのプロトタイプ。製品の MVP ではない。タスク管理ツールではない（抽出をやる。追跡だけではない）。
チームの共有は既存のツール（Jira・グループメール・Slack）に任せ、Murmur はチームリストを持たない。

- 設計の正本: このリポジトリの `docs/PLAN.md`（計画 v2）と `docs/adr/`（`docs/adr/0011`）。立ち位置は `docs/adr/0012`、データモデルは `docs/adr/0013` を `docs/adr/0014` で 1 種類のスレッドに統合した形
- Google Doc（https://docs.google.com/document/d/1gNSrK_p5xrEGiJB4RRr2FfFf9r-naPamh_5P9tNqM6w/edit）は 2026-10-17 までの経緯の資料。更新しない。食い違ったらリポジトリが優先
- v1 の計画と実装はタグ `proto-v1`
- 決定の記録: `docs/adr/`
- 申し送り（残作業・判断待ち・既知の制約）: `docs/HANDOFF.md`。セッションの始めに読み、終わりに更新する
- 計画 v2 は 2026-10-21 に完了（振り返りは `docs/retrospective-v2.md`）。次の段階（自社の実データで Ingest を確かめる）のゴールと段取りは `docs/adr/0016`
- 1 人のユーザが複数の組織（テナント）にまたがる対応はやらない（`docs/adr/0018`）。1 つの接続 = 1 つの組織。組織の切り替えはスタンドの側で行い、本体にもゲートウェイにも切り替えやアカウントリンクを足さない
- 立ち位置（`docs/adr/0020`）: Murmur は 1 チーム（会社・部署・プロジェクトなど、緊密なタスクの共有とディスパッチが要るグループ）に 1 つセルフホストする。ゲートウェイとは 1 対 1。チームの境界を越えることを最初から想定し、越えるときはチームの中とは違う要約レベルのスレッドを共有する。将来像はチームごとの Murmur が送り合う形と個人の Murmur（`docs/adr/0022`、構想）
- マルチテナントの概念は本体から外し（1 デプロイ = 1 チーム）、ストレージは D1 にした（`docs/adr/0021`、2026-10-23 に実装）。投影は変わった行だけ upsert する。Postgres の実装は消した（要る人は `Repo` を実装する）
- Party は Contact（アドレスを束ねた連絡の相手）に改め、組織の概念を外す。読者は User で持ち、イベントと fold はマスタに依存せず（ボールは保持者のアドレスで畳む）、Contact への解決と誰の番かはクエリ層で行う。名寄せは人とスタンドが後から付ける（`docs/adr/0030`、2026-10-31 に採用・実装）
- 個人のメモはなくした（`docs/adr/0039`、2026-11-08 に採用・To Do まで実装）。リストは個人リスト（読者が本人 1 人）と共有リストの 2 つだけ。タスクは組織のアカウントのタスクのサービス（To Do・Google Tasks）を個人リストの状態を持つソースとして写し、共有の Jira の課題などと結ぶ。Murmur が正なのはスレッドへの人とスタンドの操作だけで、メモ（経過の記録）もその 1 つ。中身を持つ操作なので、個人リストのスレッドにだけ書ける（イベントは `ThreadNoted`）。本人が付ける属性はなくし、`due` は写しにした。To Do は経路 `graph-todo`（`src/connectors/todo/`）
- タスクは 1 つの外のタスク（To Do）のスレッドで追い、共有スレッドには事実と構造の操作だけを書く（0039 で、0031 の「1 つの個人のメモのスレッド」「属性はメモのスレッドだけ」を改めた）。写しは Murmur が決めた形（`closed / holders / title / statusLabel / due`）で、コネクタはサービスの標準の意味で写す（`docs/adr/0031`、2026-11-03 に採用）
- 状態を持つデータソースで「アクションが要る」のは、ソースでボールを持つ人（`holders`。Jira は担当者）に自分がいるものだけ。ほかは文脈として取り込み、範囲の外の話しかけ（Jira の範囲外のメンション）は取り込まない（ソースの通知がメールで入る経路で気づく）。解決されていない登場人物はスタンドが Contact を作る（`docs/adr/0035`）
- 誰の番は「担当」と「名指し」の 2 軸で決める（`docs/adr/0038`、2026-11-06 に採用・実装）。担当の出所はデータソースの種類で 1 つ（状態を持つソースはソースの担当者、それ以外の共有リストは担当する操作、個人リストは本人）。名指しはシグナルの宛先から溜まり、本人（読者でないアドレスは読者の誰か）が明示的に外すまで残る。ボール・どちら側か・読者が 1 人・「返事や対応を求めているか」（AI の判定）はやめた。AI を呼ぶのは区切りと新しいスレッドの件名だけ
- エージェントは「次の一手を決める者が書く」。オーケストレータの下で動くものは書かず、直接の参加者は書き手の印（`author`）を付けて書く。書き手の印は番に使わない（`docs/adr/0032`、0027 を改めた）
- Murmur はゲートウェイの Worker の機能（`docs/adr/0023`、2026-11-04 に採用、2026-11-05 に UBS を移して完了）。novshi-tech/heddleway の `murmur/` にあり、パッケージ管理は npm（コマンドはこのディレクトリで実行）。運用はゲートウェイに合わせて PR で回す。ゲートウェイとのやりとりは全部 `src/ports/gateway.ts` の口を通し、口はゲートウェイの中核（`../src/feature-port.ts`）が実装する。組み立ては `src/feature.ts`（env を読まない）で、入口はゲートウェイの `../src/murmur-feature.ts`。コードの境界は vertical slice（互いの実装を import しない、env は入口だけ、秘密ではなく能力を渡す、Murmur は実行時の依存を足さない）。MCP のツールは足さず、スキルと REST で使う
- 共有リストはスペース単位（Teams・Slack のチャネル、Jira のプロジェクト）で 1 つ。読者はソースの「読める人」のうち本人が名乗って対応が付いた Murmur の User で、見回りで写す。経路は作った人の委任。作れるのはそのスペースを読める人なら誰でも（管理者がデプロイの設定でサービスを許す）。Jira も共有リストにし、個人リストは本人だけが読むもの（Outlook・To Do のタスクのリスト）に限る（`docs/adr/0037`、2026-11-05 に採用・実装。Teams の形は `docs/adr/0036`）
- ADR には汎用の製品としての決定を書く。特定の会社の事情（どの会社のアカウントで回すか、どの会社をまとめるか）は書かない

## 約束事

- 実装の順序と完了条件は `docs/PLAN.md` の実装ステップに従う。ステップをまたいで先回りしない
- イベント型を追加・変更するときは、zod スキーマ（`src/domain/events.ts`）、fold の純関数テスト（`test/domain/fold.test.ts`）、リプレイテスト（H1、`test/scenarios.test.ts`）を同じ PR で更新する
- Claude API の呼び出しは必ず記録・再生の層（`src/ingest/llm.ts` の `RecordReplayLlm`）を通す。テストは再生モードのみ
- `src/domain/` に Workers API への依存を持ち込まない（下の FC-IS を参照）
- 本体はデータソースの中身を書き換えない（`docs/adr/0012`）。送信・起票・コメントはスタンドがゲートウェイ経由で行い、本体には `record_sent` で事実だけを記録する。本体に送信の経路（`Connector.send`、承認付きの送信）を足さない。例外は取り込みのための購読の管理（Graph のサブスクリプション、Jira の動的 Webhook など）だけで、本体が持つ（`docs/adr/0024`）。読み取りしかしないことは本体のコードで保証する
- チームリスト・購読・派生・本体の承認を足さない（`docs/adr/0013`）。誰の番かは持ち主の操作（`ThreadClaimed`）と構造で決め、自然文の条件を持ち込まない
- スレッド以外のエンティティ（用件・Matter）を足さない。リストは個人リストと共有リストの 2 つで、Murmur の中にデータソースを作らない（`docs/adr/0014`・`0039`）。メモは個人リストのスレッドだけに書く
- Murmur は自分でリンクを張らない（`record_sent` の副作用の経路 sent だけが例外）。アンカーの一致は結び候補としてクエリ層で出すだけ。本人の側の状態（片付け・メモ）を自動で変えない（`docs/adr/0014`）
- fold は 1 段。スレッドの fold はそのスレッドのイベントとリンクのイベントだけ読み、リンク先の状態はクエリ層で合わせる（`docs/adr/0014`）
- テスト名とコミットメッセージに仮説番号（H1〜H10）を付ける
- 計画や ADR と食い違う判断が必要になったら、実装せず `docs/adr/` に案を書いて止まる

## 構成: Functional Core / Imperative Shell

判断はすべて純関数のコアに置き、副作用（DB・Claude・コネクタ・HTTP・時計・ID 生成・暗号）はシェルに集める。`test/architecture.test.ts` がこの境界を検査する。同じテストが vertical slice（0023 の決定 7）も検査する: ゲートウェイの口の実装を import するのは入口だけ、`env` と `cloudflare:workers` は入口だけ、実行時の依存は `zod` と `drizzle-orm` だけ、グローバルを書き換えない。

`src/domain/` はステップ 2 でスレッド 1 種類のデータモデル（`docs/adr/0013`・`0014`）に組み替え、ステップ 3 で個人のメモ・持ち主・リンク・属性（0039 で個人のメモと属性はなくした）と、クエリ層の「誰の番か」・結び候補・導出したボール・タイムラインを足した。ステップ 4 で送信の記録（`record_sent` → `OutboundRecorded`）、期限の見回り、観測された送信との統合を足した。ステップ 7 で状態の写し（`ThreadMirrored`。Jira の課題の状態をスレッドに写す）と、担当者で決まる「誰の番」を足した。0031 で写しを決まった形にした。0039 でメモを `ThreadNoted` にし、タスクのサービス（チャネル `todo`）を足した。

```
src/
  domain/        関数型コア。zod と domain 内しか import しない。Date.now・乱数・fetch・crypto 禁止
    entities.ts    マスタ（User / Contact / Address / CredentialRef / DataSource / List / ListMember）
    events.ts      イベント型（zod）
    fold.ts        fold(events) → projections（1 段）
    comm.ts        通信状態の導出。アドレスだけで畳む（名指しと外した位置・担当する操作・片付け・返事期待。0030・0038）
    directory.ts   マスタの検索、seed の整合性（seedProblems）
    commands.ts    スタンドの操作の判断（片付け・開き直し・シグナルの移し替え・メモ・持ち主・リンク）
    ingest.ts      Ingest の判断（重複排除、取り込む時点の向き、記録した送信との統合、区切り、AI 出力の検証）、プロンプト
    outbound.ts    送信の記録の判断（置き先・観測との統合・経路 sent のリンク）と期限の見回り
    mirror.ts      状態の写しの判断（課題キーのスレッドに、決まった形の写しの変わった項目だけを写す。なければ写しでスレッドを作る。0031）
    master.ts      マスタの書き換えの判断（差分・当て方・整合性。マスタはイベントにせず、変更の記録に残す。0030）
    connection.ts  個人の箱・タスクのリストをつないだときのデータソースの作成（0024・0039。作り方は people.ts の個人のリスト）
    shared.ts      共有リスト（0037）: スペースに 1 つ作る・読者をソースから写す・資格情報の入れ替え・外せる人
    people.ts      User と Contact の作り方と名寄せ（サインイン・個人のリスト・アイデンティティ・未解決のアドレス・まとめる。0030）
    sides.ts       クエリ層の「こちらのアドレスか」（窓口のアドレス + 読者の Contact のアドレス）、相手の一覧（0030）。誰の番には使わない（0038）
    turn.ts        クエリ層の「誰の番か」（0038: 担当 = ソースの担当者か担当する操作、名指し = 宛先から溜まり明示的に外す）、リンク先から導出したボール、結び候補
    visibility.ts  クエリ層の可視性（Viewer から見えるものだけ返す）、一覧のフィルタ、スレッドの詳細とタイムライン
  app/service.ts 命令型シェルの中心。読む → コアで決める → 追記 → fold して保存
  app/connections.ts 個人の箱をつなぐ（ゲートウェイの画面で本人が Murmur を有効にする → 実行時のデータソースの作成）
  store/         イベントストア・投影・マスタ（メモリ実装と D1 実装。投影は変わった行だけ upsert する）、取り込みの運用の状態（connector-state.ts）
  ingest/        Claude 呼び出し（記録・再生）、Decider
  connectors/    Connector インタフェース（取り込みだけ。シグナルと状態の写し）+ dummy/
    graph/         Outlook（0024）: 正規化・delta・サブスクリプションの計画（純関数）と、キューの仕事をこなす同期
    jira/          Jira（0034・0037）: 写像（純関数）・差分の JQL と Webhook の計画（純関数）・呼べる口を固定した API・キューの仕事・共有リストの読者の同期
    teams/         Teams（0036・0037）: 正規化・走査とサブスクリプションと読者の計画（純関数）・読める口・キューの仕事
    todo/          To Do（0039）: タスクの正規化（決まった形の写し。純関数）・読み取りの口・キューの仕事（サブスクリプションと delta は Outlook と同じ）
  ports/gateway.ts  ゲートウェイの口（型と取り決めだけ。0023）。認証・本人の接続・上流を読む関数・同意。読める口の許可リストはゲートウェイの入口で固定し、ゲートウェイの中核が強制する
  api/           HTTP API の入力スキーマ
  auth/          Bearer の取り出し（確かめるのは口）と、ダミーの Webhook の署名
  http/          経路（router.ts は app.ts が使う口だけの小さな仕組み）、参照専用の管理画面（admin.ts: /admin・timeline.html）
  feature.ts     組み立て（設定とゲートウェイの口だけで fetch / scheduled / queue を作る。env を読まない。入口はゲートウェイの側）
scripts/         scenario CLI と、その部品（Node 専用。Worker には入らない）
fixtures/<scenario>/  seed.json / signals.jsonl / expected.json / scenario.json / recordings/
drizzle/         D1 のマイグレーション（drizzle-kit generate で作り、リポジトリのルートの npm run d1-migrate で MURMUR_DB に当てる）
```

時刻と ID はシェルが `CoreContext`（`now`・`newId`）で渡す。コアの関数は同じ入力なら同じ出力を返す。

## コマンド

```sh
npm install
npm run typecheck
npm test                                   # vitest（コア・シェル・4 シナリオ。D1 は Miniflare）
npm run scenario verify all                    # 4 シナリオを expected.json と比較（H1 のリプレイ比較も）
npm run scenario verify development -- --db d1
npm run scenario verify all -- --ai replay        # 記録した Claude の判断で H6 の一致率を出す
ANTHROPIC_API_KEY=... npm run scenario verify all -- --ai record   # 記録を作る（モデルを変えたら --ai rerecord）
npm run db:generate                            # src/store/schema.ts からマイグレーションを作る（当てるのはルートの npm run d1-migrate -- <名前>）
npm run seed <scenario> -- --deployment <名前>    # ゲートウェイのデプロイの MURMUR_DB のデータを消して seed を入れる
# デプロイ・シークレット・ログはリポジトリのルートで（npm run deploy -- <名前> など。docs/stand/connect.md）
```

## 注意

- 本体は上流サービスのトークンを持たず、データソースの中身は書き換えない（購読の管理だけはする。`docs/adr/0024`）。上流を読むのはゲートウェイの口の `upstream` だけで、トークンはゲートウェイの中核の中で使われ、読める口の許可リストもゲートウェイの中核が強制する。本人がゲートウェイの画面で Murmur を有効にしていなければ何も読めない。実装は個人の箱の Outlook（`src/connectors/graph/`）と、本人のタスクのリストの To Do（`src/connectors/todo/`。0039）と、プロジェクトの共有リストの Jira（`src/connectors/jira/`。0034・0037）と、チャネルの共有リストの Teams（`src/connectors/teams/`。0036・0037）とダミーコネクタ。外部コネクタは `MURMUR_WEBHOOK_SECRET` があるデプロイだけ有効
- 初めてつないだ sub は User の行だけ作る（名無し、Contact なし）。自分の Contact はリストに入るときのアイデンティティで決まり、名寄せは人とスタンドが API で付ける（`docs/adr/0030`）。seed の `--user` の差し替えはシナリオを実環境で回すときだけ
- 本体の API はゲートウェイの中継の後ろ（`<ゲートウェイ>/api/murmur/*`）だけで、`issue_token` の `identity:murmur` で発行したゲートウェイのトークンが要る（口の `authenticate` でもう一度確かめる）。公開の経路は `<ゲートウェイ>/murmur/` の下の `/webhooks/*`（Graph の通知は clientState、Jira の通知は URL の本人ごとの秘密で照合）、同意のコールバック（`/oauth/callback`）、`MURMUR_TIMELINE_TOKEN` で守る参照専用の画面（`/admin`・`/timeline.html`）だけ
- スタンド（Cowork / Claude Code）用のスキルは同じリポジトリの `plugins/heddleway/skills/murmur/SKILL.md`（`murmur/` から見て `../plugins/...`）（共通のプラグイン `heddleway`。ゲートウェイに同梱し、`/setup` とマーケットプレイスで配る）、接続手順は `docs/stand/connect.md`。下書きは置かない。HTTP API を変えたら、同じ時期にゲートウェイのスキル（API の表と手順）も直し、プラグインの版を上げる
