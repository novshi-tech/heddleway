# 0002 テストは Node の vitest と pglite で回す（vitest-pool-workers は保留）

- 状態: 提案（直樹の判断待ち）。0021 で Postgres をやめ、pglite を Miniflare の D1 に置き換えた（Node の vitest のまま。vitest-pool-workers には移していない）
- 関連: 計画「テスト: vitest + @cloudflare/vitest-pool-workers、Cron をローカル再現」

## 背景

計画は `@cloudflare/vitest-pool-workers` で Cron をローカル再現するとしている。
一方で、FC-IS（0001）にしたことで、Cron の中身（`MurmurService.tick()` = 取り込み + 期限の見回り）は
Workers ランタイムに依存しない関数として呼べる。また Postgres の SQL を実際に通したいが、pglite は Workers ランタイムでは動かない。

## 決定（案）

- 当面は Node 上の vitest で全テストを回す
  - コア: 純関数のテスト
  - シェル: メモリ実装と Postgres 実装（`@electric-sql/pglite` + 同じ Drizzle のマイグレーション）に同じ契約テスト
  - Cron: `service.tick()` / `checkOverdue()` を時計を進めながら呼ぶ（止めて再開しても ReplyOverdue が二重に出ないことを確認）
- Worker の入口（`src/index.ts`）は `wrangler deploy --dry-run` でビルドが通ることだけを CI で確かめる

## 未決

- `scheduled` ハンドラそのもの（配線）を Workers ランタイムで叩くテストを足すかどうか。足すなら vitest-pool-workers 用の
  別プロジェクト（`vitest.workers.config.ts`）にし、DB は Neon の dev ブランチを使う
