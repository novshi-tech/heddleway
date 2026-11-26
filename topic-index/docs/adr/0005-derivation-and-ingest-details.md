# 0005 実装で決めた派生と Ingest の細部

- 状態: 採用（Google Doc への書き戻し候補。ステップ 7 で確認）

計画に明記がなく、実装のために決めたこと。設計メモと食い違っていれば指摘してほしい。

## イベント

- `DerivationRejected` を追加した（計画の API に `reject_derivation` があるがイベント表になかった）
- `SignalReceived` / `SignalObservedSent` に、Ingest 時に Directory で解決した `fromPartyId` / `toPartyIds` を持たせた。
  fold がマスタを読まずに済み（純関数のまま）、後から Address の紐づけが変わっても当時の解決結果が残る
- `DerivationProposed` に `mode`（internal / external）と `targetTaskId` を持たせた。宛先 Party があれば external

## ボールの所在（通信状態）

- 受信 → 自リスト。外部へ送信（観測された送信・外部派生の送信）→ 宛先 Party。派生を出した → 派生先リスト。返事 → 自リスト
- 外部派生の適用先タスクのボールは宛先 Party（返事待ち）。内部派生の適用先タスクのボールは自リスト
- 返事の派生（派生先のタスクから元のリストへ出す派生）は、元の派生の `DerivationReplied` を先に置いてから適用・送信する。
  外部への返事なら、適用先のボールが宛先 Party に残る

## 派生を起こすのはスタンド（2026-10-16 確認）

- 派生の提案（`DerivationProposed`）は、スタンドか人が `POST /api/derivations` を呼んだときだけ出る。Ingest は提案しない
- Ingest の仕事は、届いたシグナルをどのタスクに置くか（attach / new / ignore）まで。「別のリストや外部に渡すべきか」は
  スタンド（Cowork / Claude Code）の Claude が判断する。Murmur の中の Claude が派生に関わるのは、本文を省略した提案の本文を書くところ（`AiSummarizer`）だけ
- 計画のイベント表は `DerivationProposed` の発生元を「Ingest・スタンド」としていて、スキーマにも `proposedBy: 'ingest'` が残っている。
  将来 Ingest から提案させる余地として残すが、今は使わない（省略時は `'stand'`）
- スタンド側の判断は `RecordReplayLlm` を通らないので、記録・再生されず H6 の一致率にも入らない
- 本文（要約）もスタンドに寄せ、Murmur は境界の検査だけを持つ案を 0008 に書いた（提案）

## 派生の状態（7 状態）

proposed → rejected / approved。内部派生は approved で適用され、返事期待がなければ completed。
外部派生は sent を経る（返事期待は必須）。sent / 適用済みの approved は期限超過で overdue、返事で replied。
overdue は終端ではない。返事期待を省略した派生（completed）にも返事は紐づく。

## Ingest

- AI の ignore は confidence が閾値（既定 0.8、`IGNORE_CONFIDENCE_THRESHOLD`）以上なら採用、未満なら new に倒す（拾いすぎ側）
- 候補にないタスクへの attach、取得主体ルールで置けないリストへの new は採用せず、許可リストの先頭に new
- 取得主体ルールで置けるリストが 1 つもなければ、AI を呼ばずに ignore（理由付き）
- アンカーの優先順: In-Reply-To（派生の sent_ref → 送信元シグナルの Message-ID）→ thread_ts → Jira キー → PR 番号
- 受信が外部派生の適用先タスクに付き、送り主がその派生の宛先なら DerivationReplied（アンカーでも AI でも同じ）

## 期限の見回り

Task 投影ではなく派生の投影を見回る（期限は派生ごとに持つため）。状態が overdue に変わるので冪等。
