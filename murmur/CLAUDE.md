# Murmur — トピック索引の本体

連絡（メール・Teams・Jira・To Do など）をスレッドにまとめ、担当と名指しを追う索引（`docs/adr/0012`）。表の名前は「トピック索引」。ゲートウェイの Worker の機能として動き（`docs/adr/0023`）、1 チームに 1 つセルフホストする（`docs/adr/0020`）。タスク管理ツールではない。チームの共有は既存のツール（Jira・グループメール・Slack）に任せる。

- 設計の正本はこのリポジトリ: `docs/PLAN.md` と `docs/adr/`（索引は `docs/adr/README.md`）
- 申し送り（残作業・判断待ち・既知の制約）: `docs/HANDOFF.md`。セッションの始めに読み、終わりに更新する

## 設計の要点

- コードは `murmur/` にあり、パッケージ管理は npm（コマンドはこのディレクトリで実行）。運用はゲートウェイと同じく PR で回す。ゲートウェイとのやりとりは全部 `src/ports/gateway.ts` の口を通し、口はゲートウェイの中核（`../src/feature-port.ts`）が実装する。組み立ては `src/feature.ts`（env を読まない）で、入口はゲートウェイの `../src/murmur-feature.ts`。境界は vertical slice（互いの実装を import しない、env は入口だけ、秘密ではなく能力を渡す、実行時の依存を足さない）。MCP のツールは足さず、スキルと REST で使う（`0023`）
- 1 デプロイ = 1 チーム。ストレージは D1（`0021`）。1 つの接続 = 1 つの組織で、1 人が複数の組織にまたがる対応はしない（切り替えはスタンドの側。`0018`）
- エンティティはスレッドの 1 種類で、データソースの写し。リストはデータソースごとに 1 つで、個人リスト（読者が本人 1 人）と共有リストの 2 つだけ（`0014`・`0039`）。共有リストはスペース単位（Teams・Slack のチャネル、Google Chat のスペース、Jira のプロジェクト、共有メールボックス）で、読者はソースの読める人のうち名乗った User を見回りで写す（`0037`）
- Murmur が正なのは、スレッドへの人とスタンドの操作だけ。メモ（`ThreadNoted`）もその 1 つで、個人リストのスレッドにだけ書ける。タスクは To Do・Google Tasks を個人リストの状態を持つソースとして写し、共有のスレッドと結ぶ（`0039`）
- 状態を持つソースの写しは決まった形（`closed / holders / title / statusLabel / due`）で、コネクタはサービスの標準の意味で写す（`0031`）。アクションが要るのは `holders` に自分がいるものだけで、範囲の外の話しかけは取り込まない（`0035`）
- 担当と名指しは独立した 2 つの軸（`0038`）。担当の出所はデータソースの種類で 1 つ（状態を持つソースはソースの担当者、ほかの共有リストは担当する操作、個人リストは本人）。名指しはシグナルの宛先から溜まり、明示的に外すまで残る。AI を呼ぶのは区切りと新しいスレッドの件名だけ
- イベントと fold はマスタに依存せず、アドレスで畳む。Contact への解決はクエリ層で行い、名寄せは人とスタンドが付ける（`0030`）
- エージェントは「次の一手を決める者が書く」。書き手の印（`author`）は担当と名指しに使わない（`0032`）
- 取り込み（ingest・mirror）は投影の全件ではなく作業範囲だけを読む。機械的に引ける重複・写しの置き先・アンカーは索引（`signal_keys`）で、返事待ちは名指しの残るスレッド全部で、AI に渡す候補だけ窓（既定 30 日）で切る。範囲の意味は `selectWorkingSet`（`0046`）。一覧・操作・期限の見回りは全件（isolate の写し）
- 共有メールボックスは、メンバーの委任（`Mail.Read.Shared`）で見回りの delta だけで読む（`0042`）
- Teams のチャット（1 対 1・グループ）は、本人のチャット全体を 1 つの個人リストにし、本人の全チャットの購読の通知と保険の見回りで読む。区切りの候補はアンカーの会話（`conversationId`）で同じチャットに限り、グループのチャットは個人へのメンションだけがアテンションになる（`0044`）
- Google Chat は、スペースを共有リスト（読者はメンバー。`users/<ID>` はサインインの sub と同じ）に、本人の DM・グループを 1 つの個人リスト（0044 の会話のアンカー）にし、どちらも 5 分ごとの見回りで `createTime` の差分を読む。スペースのタスクは公開の API で読めないので入れない（`0045`）
- 表の言葉（スキル・ゲートウェイの画面・同意やコールバックの文言）は内側の言葉と分ける（`0040`・`0043`）。スレッドは「トピック」、名指しは「アテンション」、スタンドは「エージェント」、読者は「メンバー」、シグナルは「メッセージ」、データソースは「リスト」、仕分け待ちは「割当待ち」、開き直しは「再開」。「番」は使わず、担当とアテンションでそのまま言う。ADR・コード・API の名前は内側の言葉のまま
- ADR には汎用の製品としての決定を書く。特定の会社の事情は書かない

## 約束事

- 実装の順序と完了条件は `docs/PLAN.md` の実装ステップに従う。ステップをまたいで先回りしない
- イベント型を追加・変更するときは、zod スキーマ（`src/domain/events.ts`）、fold の純関数テスト（`test/domain/fold.test.ts`）、リプレイテスト（H1、`test/scenarios.test.ts`）を同じ PR で更新する
- Claude API の呼び出しは必ず記録・再生の層（`src/ingest/llm.ts` の `RecordReplayLlm`）を通す。テストは再生モードのみ
- `src/domain/` に Workers API への依存を持ち込まない（下の FC-IS を参照）
- 本体はデータソースの中身を書き換えない（`docs/adr/0012`）。送信・起票・コメントはスタンドがゲートウェイ経由で行い、本体には `record_sent` で事実だけを記録する。本体に送信の経路（`Connector.send`、承認付きの送信）を足さない。例外は取り込みのための購読の管理（Graph のサブスクリプション、Jira の動的 Webhook など）だけで、本体が持つ（`docs/adr/0024`）。読み取りしかしないことは本体のコードで保証する
- チームリスト・購読・派生・本体の承認を足さない（`docs/adr/0013`）。担当と名指しは操作（`ThreadClaimed`・アテンションを外す）と構造で決め、自然文の条件を持ち込まない
- スレッド以外のエンティティ（用件・Matter）を足さない。リストは個人リストと共有リストの 2 つで、Murmur の中にデータソースを作らない（`docs/adr/0014`・`0039`）。メモは個人リストのスレッドだけに書く
- Murmur は自分でリンクを張らない（`record_sent` の副作用の経路 sent だけが例外）。アンカーの一致は結び候補としてクエリ層で出すだけ。本人の側の状態（片付け・メモ）を自動で変えない（`docs/adr/0014`）
- fold は 1 段。スレッドの fold はそのスレッドのイベントとリンクのイベントだけ読み、リンク先の状態はクエリ層で合わせる（`docs/adr/0014`）
- テスト名とコミットメッセージに仮説番号（H1〜H10）を付ける
- 計画や ADR と食い違う判断が必要になったら、実装せず `docs/adr/` に案を書いて止まる

## 構成: Functional Core / Imperative Shell

判断はすべて純関数のコアに置き、副作用（DB・Claude・コネクタ・HTTP・時計・ID 生成・暗号）はシェルに集める。`test/architecture.test.ts` がこの境界を検査する。同じテストが vertical slice（0023 の決定 7）も検査する: ゲートウェイの口の実装を import するのは入口だけ、`env` と `cloudflare:workers` は入口だけ、実行時の依存は `zod` と `drizzle-orm` だけ、グローバルを書き換えない。

```
src/
  domain/        関数型コア。zod と domain 内しか import しない。Date.now・乱数・fetch・crypto 禁止
    entities.ts    マスタ（User / Contact / Address / CredentialRef / DataSource / List / ListMember）
    events.ts      イベント型（zod）
    fold.ts        fold(events) → projections（1 段）
    comm.ts        通信状態の導出。アドレスだけで畳む（名指しと外した位置・担当する操作・片付け・返事期待。0030・0038）
    directory.ts   マスタの検索、seed の整合性（seedProblems）
    commands.ts    スタンドの操作の判断（片付け・開き直し・シグナルの移し替え・メモ・担当・リンク）
    ingest.ts      Ingest の判断（重複排除、取り込む時点の向き、記録した送信との統合、区切り、AI 出力の検証）、プロンプト
    outbound.ts    送信の記録の判断（置き先・観測との統合・経路 sent のリンク）と期限の見回り
    mirror.ts      状態の写しの判断（課題キーのスレッドに、決まった形の写しの変わった項目だけを写す。なければ写しでスレッドを作る。0031）
    master.ts      マスタの書き換えの判断（差分・当て方・整合性。マスタはイベントにせず、変更の記録に残す。0030）
    connection.ts  個人の箱・タスクのリストをつないだときのデータソースの作成（0024・0039。作り方は people.ts の個人のリスト）
    shared.ts      共有リスト（0037）: スペースに 1 つ作る・読者をソースから写す・資格情報の入れ替え・外せる人
    people.ts      User と Contact の作り方と名寄せ（サインイン・個人のリスト・アイデンティティ・未解決のアドレス・まとめる。0030）
    sides.ts       クエリ層の「こちらのアドレスか」と相手の一覧（0030）。担当と名指しには使わない
    turn.ts        クエリ層の担当と名指し（0038）、結んだ先の様子（derivedBall）、結び候補
    visibility.ts  クエリ層の可視性（Viewer から見えるものだけ返す）、一覧のフィルタ、スレッドの詳細とタイムライン
  app/service.ts 命令型シェルの中心。読む → コアで決める → 追記 → fold して保存
  app/connections.ts 個人の箱をつなぐ（ゲートウェイの画面で本人が Murmur を有効にする → 実行時のデータソースの作成）
  store/         イベントストア・投影・マスタ（メモリ実装と D1 実装。投影は変わった行だけ upsert する）、取り込みの運用の状態（connector-state.ts）
  ingest/        Claude 呼び出し（記録・再生）、Decider
  connectors/    Connector インタフェース（取り込みだけ。シグナルと状態の写し）+ dummy/
    graph/         Outlook（0024）: 正規化・delta・サブスクリプションの計画（純関数）と、キューの仕事をこなす同期
    jira/          Jira（0034・0037）: 写像（純関数）・差分の JQL と Webhook の計画（純関数）・呼べる口を固定した API・キューの仕事・共有リストの読者の同期
    teams/         Teams（0036・0037）: 正規化・走査とサブスクリプションと読者の計画（純関数）・読める口・キューの仕事
    teams-chat/    Teams のチャット（0044）: 正規化・チャットの種類と見回りの計画（純関数）・読める口・キューの仕事（本人の全チャットの購読の通知でチャットを読み、見回りは保険）
    todo/          To Do（0039）: タスクの正規化（決まった形の写し。純関数）・読み取りの口・キューの仕事（サブスクリプションと delta は Outlook と同じ）
    gmail/         Gmail（0041）: 正規化・ヘッダーと本文の読み取り（アドレスの一覧・符号化された語・MIME・文字コード。純関数）・履歴の計画と拾い直しの起点（純関数）・読み取りの口（GET だけ）・見回りの同期（通知がなく、5 分ごとの maintain で history.list の差分を読む。位置が切れたら検索で拾い直す）
    google-chat/   Google Chat（0045）: スペースと DM・グループの正規化・見回りの計画（純関数）・読める口（GET だけ、2 つ）・見回りの同期（スペースは読者の同期つき、DM は lastActiveTime で動いたものだけ）
    gtasks/        Google Tasks（0041）: タスクの正規化（純関数。To Do と同じ決まった形）・見回りの計画（間隔・cursor。純関数）・読み取りの口（GET だけ。userinfo でアカウントを知る）・見回りの同期（通知がなく、5 分ごとの maintain で updatedMin の差分を読む）
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

- 本体は上流サービスのトークンを持たず、データソースの中身は書き換えない（購読の管理だけはする。`docs/adr/0024`）。上流を読むのはゲートウェイの口の `upstream` だけで、トークンはゲートウェイの中核の中で使われ、読める口の許可リストもゲートウェイの中核が強制する。本人がゲートウェイの画面で Murmur を有効にしていなければ何も読めない。コネクタは `src/connectors/` の下（上の構成）。外部コネクタは `MURMUR_WEBHOOK_SECRET` があるデプロイだけ有効
- 初めてつないだ sub は User の行だけ作る（名無し、Contact なし）。自分の Contact はリストに入るときのアイデンティティで決まり、名寄せは人とスタンドが API で付ける（`docs/adr/0030`）。seed の `--user` の差し替えはシナリオを実環境で回すときだけ
- 本体の API はゲートウェイの中継の後ろ（`<ゲートウェイ>/api/murmur/*`）だけで、`issue_token` の `identity:murmur` で発行したゲートウェイのトークンが要る（口の `authenticate` でもう一度確かめる）。公開の経路は `<ゲートウェイ>/murmur/` の下の `/webhooks/*`（Graph の通知は clientState、Jira の通知は URL の本人ごとの秘密で照合）、同意のコールバック（`/oauth/callback`）、`MURMUR_TIMELINE_TOKEN` で守る参照専用の画面（`/admin`・`/timeline.html`）だけ
- スタンド（Cowork / Claude Code）用のスキルは同じリポジトリの `plugins/heddleway/skills/topic-index/SKILL.md`（`murmur/` から見て `../plugins/...`）（共通のプラグイン `heddleway`。ゲートウェイに同梱し、`/setup` とマーケットプレイスで配る）、接続手順は `docs/stand/connect.md`。下書きは置かない。HTTP API を変えたら、同じ時期にゲートウェイのスキル（API の表と手順）も直し、プラグインの版を上げる
