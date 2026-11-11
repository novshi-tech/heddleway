# スタンドからの接続手順（Cowork / Claude Code）

スタンドから見える MCP は API ゲートウェイの 1 つだけ。Murmur はゲートウェイの Worker の機能として動き（`docs/adr/0023`、heddleway の `docs/adr/0005`）、
スタンドはほかのサービスと同じく `issue_token`（`identity:murmur`）で発行したトークンで `<ゲートウェイ>/api/murmur/...` を呼ぶ。

## ゲートウェイで Murmur を有効にする（デプロイする人）

リポジトリのルートの `wrangler.example.jsonc` の末尾のとおり、ゲートウェイのデプロイの設定（`deployments/<名前>.jsonc`）に Murmur の D1・キュー・cron を足す。

```sh
# リポジトリのルートで（npm install が murmur/ の依存も入れる）
npm install
# D1 とキューを作り（日本のチームなら apac）、database_id を deployments/<名前>.jsonc の MURMUR_DB に書く（初回だけ）
npx wrangler d1 create <名前>-murmur --location apac
npx wrangler queues create <名前>-murmur-sync
# マイグレーション（murmur/drizzle を MURMUR_DB に当てる。スキーマを変えたらデプロイの前に手で当てる）
npm run d1-migrate -- <名前>
# secrets
npm run secret -- <名前> put ANTHROPIC_API_KEY
npm run secret -- <名前> put MURMUR_WEBHOOK_SECRET   # openssl rand -base64 32。Graph・Jira の Webhook
npm run secret -- <名前> put MURMUR_TIMELINE_TOKEN   # 管理画面（/murmur/admin・/murmur/timeline.html）を見る人だけに渡す
npm run deploy -- <名前>
```

`MURMUR_DB` と `ANTHROPIC_API_KEY` がそろうと有効になる。なければゲートウェイは Murmur なしで動く。設定を変えたら、設定のリポジトリにコミットしてプッシュする。CI はデプロイしない。

利用者は、スタンドから Outlook・Gmail・To Do・Google Tasks や Jira をつなぐよう頼んだときに、ゲートウェイの画面「Murmur を有効にしますか?」に案内されて有効にする。無効にするのはゲートウェイのホームの「このゲートウェイの機能」から。

マスタの `User.id` は、ゲートウェイの User ID（`entra_<tenant-id>_<object-id>` / `google_<sub>`）にする。
マスタ（seed）の投入は `murmur/` で `npm run seed <scenario> -- --deployment <名前> --user <seed の User ID>=<ゲートウェイの User ID>`（SQL を作って `wrangler d1 execute` で MURMUR_DB に流す）。
DB を空にしてから `fixtures/<scenario>/seed.json` を入れるので、シナリオは 1 つずつ回す。受信は `POST <ゲートウェイ>/murmur/webhooks/dummy`（本文は InboundSignal の配列、`x-murmur-signature` は
MURMUR_WEBHOOK_SECRET の HMAC-SHA256 hex）で流し込む（`npm run send`）。

スタンド用スキルは、ゲートウェイに同梱の共通のプラグイン `heddleway` に入っている（スキル `topic-index`。0.21 までは `murmur`）。

## Cowork

1. Cowork の設定で API ゲートウェイの MCP コネクタを有効にする（既存のもの。追加の MCP は不要）
2. プラグイン `heddleway` をインストールし（ゲートウェイの「Claude につなぐ」からダウンロードできる）、スキル `topic-index` を有効にする
3. 「今日やることは?」で `GET /threads?filter=my_turn`（list_threads）が呼ばれることを確認する

## Claude Code

1. `claude mcp add` でゲートウェイの MCP を追加する（既に使っていればそのまま）
2. マーケットプレイス `novshi-tech/heddleway` を追加し、プラグイン `heddleway` をインストールする
3. 同じく list_threads で確認する

## 複数の組織を使い分けるとき（`docs/adr/0018`、heddleway の `docs/adr/0004`）

Murmur とゲートウェイは「1 つの接続 = 1 つの組織（IdP が 1 つ）」が前提。1 人のユーザが複数の組織にまたがる対応は本体にもゲートウェイにも入れない（適切なセキュリティ境界を引けないため）。
別の組織の Murmur を使うときは、その組織のゲートウェイを**別のコネクタとして並べてつなぐ**。切り替えは要らない。

- Cowork / Claude Code とも、組織ごとのゲートウェイの `<ゲートウェイ>/mcp` を別々のコネクタとして追加する。コネクタには組織が分かる名前を付ける。ゲートウェイの設定 `ORGANIZATION_NAME` が、コネクタの説明と `list_credentials` の `gateway.organization` に出る
- スキルは 1 回入れれば全部のコネクタで使う。`heddleway` スキル（0.14.0 から）の「コネクタの選び方」で作業する組織のコネクタを選び、Murmur の記録もその組織のコネクタで行う
- どの Claude にどのゲートウェイをつなぐかは使う側が決める。組織が契約している Claude（Team / Enterprise）には、その組織のゲートウェイだけをつなぐ

## H7（スタンド主導の完走）の回し方

1. `fixtures/absence` と `fixtures/complaint` の seed を投入し、`signals.jsonl` の受信だけを Webhook で時刻順に流す
2. ユーザーは Claude に指示（「この欠勤の代わりを探して」「送って」）と送信の確認だけを出し、持ち主・メモ・リンク・属性・送信の記録はスタンドに任せる
3. 終わったら、実際に呼ばれたツールと引数を `signals.jsonl` の action 行に、確かめた結果を `expected.json` に固め、
   `scenario.json` の `status` を `stand-recorded` にする

## 管理画面（参照専用）

`https://<ゲートウェイ>/murmur/admin?token=<MURMUR_TIMELINE_TOKEN>` でリスト一覧 → リストのスレッドの一覧（誰の番・結び・属性・状態）→ スレッドの詳細（結び・結び候補・属性・結んだ先も含むタイムライン）を辿れる。
書き込みはできない。全データソースが見えるので、トークンは運用する人だけに渡す。全スレッドを 1 枚で見るときは `/murmur/timeline.html?token=...`

H7 で absence をスタンド主導で回す手順は `docs/stand/h7-absence.md`。
