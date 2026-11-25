# 0001 関数型コアと命令型シェルに分ける

- 状態: 採用（2026-10-16）
- 関連: H1、計画「fold は IO を持たない純関数」「domain/ は Workers API に依存しない純粋な TS」

## 背景

計画は fold だけを純関数にすることを求めているが、Ingest の判断・派生の承認・可視性・期限の見回りも、
入力（投影・マスタ・時刻）が決まれば出力が決まる判断である。ここに IO が混ざると、リプレイと単体テストが難しくなる。
直樹から「FC-IS を意識して、副作用は別レイヤーに分離して」との指示があった。

## 決定

- `src/domain/` を関数型コアにする。fold に加え、コマンドの判断（`commands.ts`）、Ingest の判断（`ingest.ts`）、
  クエリ層の可視性（`visibility.ts`）、通信状態の導出（`comm.ts`）をすべて純関数で置く
- 時刻と ID 生成は `CoreContext` でシェルから渡す。コアは `Date.now()`・乱数・`crypto`・`fetch` を使わない
- シェル（`src/app/service.ts`）は「投影を読む → コアで決める → イベントを追記（楽観ロック）→ fold して投影を保存」だけを行う。
  AI 判断のように途中で IO が要る処理は、コアを 2 段に分けてシェルが間で IO を挟む
  （`prepareInbound` → 推定 → `planDecision` → Decider → `finalizeDecision`）
- `test/architecture.test.ts` で、`src/domain` の import 先と禁止 API を検査する

## 結果

- コアのテストは IO なしで書け、`test/domain/` に集まっている
- 可視性はクエリ層（純関数）で強制する。Postgres からは投影を丸ごと読み、コアで絞る（性能は今回スコープ外、0004 参照）
