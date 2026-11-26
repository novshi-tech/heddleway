# 0029 デプロイの設定はリポジトリの外に置き、デプロイは CI でしない

- 状態: 採用（2026-10-31、直樹とのディスカッション）。**Murmur のデプロイの設定（murmur-deployments）は 0023（採用、2026-11-04）で改めた**（Murmur をゲートウェイの機能にして 1 つの Worker にした。2026-11-05 に実装）
- 関連: 0020（1 チームに 1 つセルフホストする。ゲートウェイと 1 対 1）、0021（D1。ゲートウェイと同じ Cloudflare アカウント）、api-gateway-mcp の `docs/adr/0004`（1 つのデプロイ = 1 つの組織）と README「設定をリポジトリで管理する」

## 背景

デプロイの設定は `wrangler.jsonc` の `env.dev` / `env.prod` に直接書き、main へのプッシュで CI が `murmur-dev` にデプロイしていた。

0020 で Murmur は 1 チームに 1 つになり、デプロイはチームの数だけ増える（まず UBS、近いうちに nvt）。チームごとに Cloudflare のアカウントが違い、ゲートウェイと同じアカウントに置く（0021）。
このままだと、チーム固有の設定（アカウント ID・D1・ゲートウェイの公開鍵）が汎用の Murmur のリポジトリに入り、CI のトークンもアカウントごとに要る。
ゲートウェイは同じ問題を、設定を別の private リポジトリに出して `deployments/` に clone する形で解いた。

## 決定

1. デプロイの設定は `deployments/<名前>.jsonc` に置く。`deployments/` は git の管理外で、デプロイする人の private リポジトリを clone する（ゲートウェイと同じ形）。直下には `wrangler.jsonc` を置かず、ひな形 `wrangler.example.jsonc` だけを持つ
2. wrangler はラッパー（`tools/wrangler.mjs`）から名前を付けて呼ぶ: `pnpm run deploy <名前>`・`pnpm secret <名前> put <KEY>`・`pnpm tail <名前>`・`pnpm db:migrate <名前>`・`pnpm seed <scenario> --deployment <名前>`
3. デプロイの設定には `account_id` を必ず書く
4. CI はテストとひな形のドライランだけにし、デプロイしない。デプロイはスタンド（Claude Code のセッション）か手元から行う
5. 設定は合成しない。ひな形の共通部分（互換日付・cron・D1 のマイグレーションの場所など）が変わったら、各デプロイの設定に同じ変更を入れる

## 帰結

- novshi-tech のアカウントの `murmur-dev` は検証用だった。UBS の Murmur はアーバンのアカウントに新しく立て（データは移さない）、`murmur-dev` は nvt のゲートウェイを片付けるときに消す
- `docs/stand/connect.md` の「本体の準備」はラッパーで書く
