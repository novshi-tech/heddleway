# シナリオのフィクスチャ

```
fixtures/<scenario>/
  scenario.json    # タイトル・検証する仮説・状態（desk-checked / draft / stand-recorded）
  seed.json        # User / Contact / Address / CredentialRef / DataSource（タスクのリスト channel todo を含む） / List / ListMember
  signals.jsonl    # 時刻順のステップ（観測されたシグナル・スタンドの操作・Cron）。// で始まる行はコメント
  expected.json    # シグナルごとの区切りと「返事や対応を求めているか」の正解ラベル、各時点のスレッドの状態、可視性
  recordings/      # Claude 呼び出しの入出力（再生モード用）。npm run scenario verify <name> -- --ai record で作る
```

seed.json は読み込み時に `seedProblems`（`src/domain/directory.ts`）で整合性を確かめる。データソース 1 つにリスト 1 つ、
個人の資格情報は読者 1 人（その本人）のデータソースにだけ使う（0013・0014・0039。タスクのリストも個人の資格情報の個人リスト）。

## signals.jsonl のステップ（ステップ 4 までの分）

```jsonc
// 観測されたシグナル（ダミーコネクタが受け取ったもの）。from がデータソースの送信元なら観測された送信（outbound）
// bind で結果（threadId / signalId）に名前を付ける
{"id":"s01","at":"2026-10-16T09:00:00.000Z","signal":{"dataSourceId":"ds_support", /* InboundSignal */ },"bind":{"custThread":"threadId"}}
// スタンドの操作（HTTP API と同じ入力）。me / list_threads / get_thread / dismiss_thread / reopen_thread / move_signal / get_list
// / add_note（thread_id・body・author?。個人リストのスレッドだけ）/ claim_thread（user_id は省略で自分、null で手放す）/ link_threads・unlink_threads（other_thread_id）
{"id":"a01","at":"...","action":{"tool":"move_signal","as":"u_sato","input":{"signal_id":"$sig","new_thread_title":"別件","reason":"..."}},"bind":{"t":"thread.id"}}
{"id":"a02","at":"...","action":{"tool":"add_note","as":"u_sato","input":{"thread_id":"$task","body":"..."}}}
// タスクを作った記録（To Do。0039）。宛先は要らず、sent_ref（タスクの ID）がそのスレッドの区切り
{"id":"a03","at":"...","action":{"tool":"record_sent","as":"u_sato","input":{"data_source":"ds_tasks_sato","subject":"この件","body":"...","sent_ref":"AAMkTask-1","source_thread_id":"$comp"}},"bind":{"task":"thread.id"}}
// 送信の記録（record_sent。入力は POST /api/sent と同じ）。echo: true ならダミー上流が次の pull でその送信を観測された送信として返す（記録 → 観測の順）
{"id":"o01","at":"...","action":{"tool":"record_sent","as":"u_sato","input":{"data_source":"ds_support","to":["ops@clean-toto.example"],"body":"...","sent_ref":"<u1@ubs.example>","source_thread_id":"$comp","reply_expected_by":"2026-10-16T22:00:00+09:00"}},"echo":true,"bind":{"partner":"thread.id"}}
// Cron（取り込みのポーリングと期限の見回り）
{"id":"c01","at":"...","cron":true}
// 状態の写し（ダミーの Jira の課題・To Do のタスクの更新。ステップ 7・0031・0039）。bind で写したスレッド（threadId）に名前を付けられる。fields は決まった形の変わった項目（closed / holders / title / statusLabel / due。holders はそのチャネルのアカウント）。
// 課題キー（threadKey）のスレッドに写す。スレッドはシグナル（課題の作成・起票の記録）で作られ、ID を使わないので AI の記録のキーは変わらない
{"id":"m01","at":"...","mirror":{"dataSourceId":"ds_jira","channel":"jira","threadKey":"NVT-42","fields":{"statusLabel":"進行中","holders":["acct-kato"],"closed":false},"sourceRef":"jira:NVT-42:u1"}}
```

- `"$name"` は束縛した値に置き換わる（本文に `$` から始まる文字列を書くと失敗する）
- 時刻は `2026-10-16T09:00:00.000Z` の形にそろえる
- 送信は、スタンド経由なら `record_sent`（返事をしているなら `reply_to_thread_id`、元のスレッドがあれば `source_thread_id` で経路 sent に結ぶ）、
  メーラーなどから直接送ったものは観測された送信の signal の行で書く。観測 → 記録の順は、signal の行のあとに同じ `sent_ref` の `record_sent` を書く
- 記録した送信は、観測された送信と同じ順で ID を使う（シグナル → 新しいスレッド）。観測された送信の行を `record_sent` に置き換えても、後の AI のプロンプトに入る id は変わらない
- ID は連番（`thr_1`・`sig_2` …）。AI に渡すプロンプトには候補のスレッドの id が入るので、AI 判断の前に ID を使う操作（新しいスレッドを作る `record_sent`・写し・メモの `add_note`）を足すと記録のキーが変わる。記録を取り直さないなら、AI に聞くスレッドができたあとに書く

## expected.json

- `ingest`: シグナルのステップごとの正解ラベル。`{"thread": "new" | "$<束縛名>", "needsResponse": true | false | null, "by"?: ..., "title"?: ...}` か `{"duplicate": true}`。
  ヒント実行（AI なし）では、AI に聞く判断にこのラベルを使う。AI 実行（`--ai replay`）では一致率を測る（H6）。
  `by` を書けば区切りの根拠（anchor / awaiting / no_match / ai）も確かめる。AI が区切るものには書かない（ヒント実行では human になる）
- `checkpoints`: そのステップの直後のスレッドの状態（ボール・片付け・シグナル数・持ち主・属性・`links`（`{"$束縛名": 経路}`）など）と、その時点の見え方（`views`、`visibility` と同じ形）
- `final`: 最終のスレッド・スレッド数・イベントの件数
- `visibility`: Viewer ごとの見え方（H3・H8）。スレッドの詳細（`access` は full / null、`mustContain` / `mustNotContain` の `$束縛名` は置き換える）、
  クエリ層の導出（`item`: `turn`・`derivedBall`・`linkedActiveSinceDismissed` など）、結び候補（`candidates`）、見えるシグナルの件数、
  `list_threads` の結果（filter: my_turn / mine / open / triage / all）、ゴースト Contact

## 状態

| シナリオ | 状態 | 備考 |
| --- | --- | --- |
| repair-estimate（修繕見積） | desk-checked | 組織のメールボックスと個人のメールボックス。同じ相手の別件を AI が区切る。個人のメールボックスは読者 1 人なので本人の「自分の番」。鈴木の見積依頼を記録して問い合わせと結び、期限超過 → 見積で解消 |
| development（開発） | desk-checked | Slack の共有チャンネル（グループ）、Jira・Bitbucket はソースの区切り（threadKey）。NVT-42 と NVT-50 に触れた Slack の結び候補から、NVT-42 だけを結ぶ。Jira の状態の写し（担当者で誰の番、完了でボールなし）、能勢が回帰テストの課題を起票して記録し Slack と結ぶ、Jira のコメントの両方向（直接・スタンド経由。H5）（H9） |
| absence（欠勤連絡） | draft | LINE。返事待ちの規則で打診への返事を取り違えない。木村が持ち、打診を送って記録して欠勤のスレッドと結ぶ（メモなし）。スタンド主導で回して置き換える（H7） |
| complaint（クレーム） | draft | 佐藤が持ち、協力会社への依頼を記録（期限超過 → 解消）、お詫びは観測が先で記録があと。メモのスレッドで結んで優先度を付け、閉じる。片付けたスレッドへの返信で別件が届き（閉じた件に結ばれた先が動く）、シグナルを移し替える。同上 |

`recordings/` は v2 のプロンプトで 2026-10-21 に取った（claude-sonnet-5-5）。`npm test` で H6 の一致率が測られる。
プロンプトかモデルを変えたら `ANTHROPIC_API_KEY` を設定して `npm run scenario verify all -- --ai rerecord` で取り直す。
添付の `files/` は参照（パスとハッシュ）だけで、実体は置いていない。
