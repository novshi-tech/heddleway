# 0005 Murmur をゲートウェイの機能として持つ

- 状態: 採用(2026-11-04、直樹とのディスカッション)。段取り 1〜4 を終えた(2026-11-05 に UBS を移し、別の Worker の Murmur とそのコードを消した)
- 2026-11-25: 機能の名前を `murmur` から `topic-index` に変えた([0009](0009-rename-murmur-to-topic-index.md))。本文は当時の名前のまま
- 関連: Murmur の [`topic-index/docs/adr/0023`](../../topic-index/docs/adr/0023-murmur-as-gateway-feature.md)(本体の決定。理由・脅威の整理・段取りはそちら)、[0004](0004-one-deployment-per-organization.md)(1 つのデプロイ = 1 つの組織)、[background-access.md](../background-access.md)

## 決定

Murmur(チームの仕事の記憶)を、ゲートウェイの機能にする。1 つのリポジトリ、1 つの Worker、1 つのデプロイ。詳細は Murmur の 0023 に書いた。ゲートウェイの側から見た要点だけをここに置く。

1. **ゲートウェイは Murmur なしでも動く。** Murmur は機能として無効にでき、無効なら今のゲートウェイと同じ。デプロイの設定に Murmur の束縛(D1・キュー)がなければ無効
2. **コードの境界は vertical slice。** ゲートウェイの中核と Murmur は互いの実装を import しない。env を受け取るのは Worker の入口だけで、Murmur には Murmur の束縛と秘密だけを渡す。ゲートウェイは Murmur にトークンや鍵を渡さず、「この人の接続で、この口を読む」能力(関数)だけを渡す。Murmur は実行時の依存を足さない
3. **MCP のツールは `list_credentials` と `issue_token` の 2 つのまま。** Murmur の API は REST で、`issue_token` で発行した短命のトークンで認可する。使い方はプラグイン `api-gateway-murmur` のスキル
   - **[0007](0007-call-apis-from-mcp-tools.md) で改めた(2026-11-07)**: どのサービスも MCP のツール `api_get`・`api_request` から呼べるようにした。Murmur にも同じトークンの確かめを通って届く。Murmur 専用のツールは作らない
4. **デプロイのドメインは変えない。** 各デプロイの `PUBLIC_URL` の下に Murmur の API・Webhook・画面が入る。利用者のコネクタの URL と、上流の OAuth のアプリのコールバックはそのまま
5. **プラグイン名(`api-gateway-*`)は変えない。** 変えると利用者が入れ直すことになる。製品の総称(「○○ Gateway」)の単語は保留
   - **[0006](0006-name-heddleway.md) で改めた(2026-11-05)**: 製品の名前を Heddleway にし、プラグイン名も `heddleway-*` に変える

## 段取り(Murmur の 0023 の「移し方」)

1. **リポジトリをまとめる**(済み、2026-11-04): Murmur を `topic-index/` に `git subtree` で取り込んだ(履歴つき)。`topic-index/` は別のパッケージ(npm。pnpm から移した)で、ルートのテストからは外し、CI では別のジョブで回す。Worker はまだ 2 つで、動きは変えていない。ADR の番号は、ゲートウェイは `docs/adr/`、Murmur は `topic-index/docs/adr/` で別々に振る
2. **中核の口を作る**(済み、2026-11-04): Murmur の側で、ゲートウェイを呼ぶところを口(`topic-index/src/ports/gateway.ts`)の後ろにまとめた。読める口の許可リストは口の実装が強制する。実行時の依存は `zod` と `drizzle-orm` だけにした(`@anthropic-ai/sdk`・`hono` を外した)。段取り 3 では、ゲートウェイの中核がこの口を実装する
3. **1 つの Worker にする**(済み、2026-11-04): 下の「段取り 3 の形」

4. **既存のデプロイを移す**(済み、2026-11-05): 今の D1 とキューをゲートウェイの設定(`deployments/<名前>.jsonc`)に束ね、Graph のサブスクリプションと Jira の Webhook は新しい通知先で作り直した。別の Worker の Murmur とそのコード(CIMD・JWKS の検証)を消した

## 段取り 3 の形(2026-11-04)

- **機能(feature)の口**: 中核にあるのは汎用の `src/features.ts` だけ(名前・同意の文言・`fetch`・`scheduled`・`queue`、任意で本人の画面 `userPage`)。Murmur を組み立てて登録するのは入口(`src/index.ts` が読み込む `src/topic-index-feature.ts`)だけで、中核のほかのファイルは Murmur を import しない。Murmur から中核が読むのは口の取り決め(`topic-index/src/ports/gateway.ts`)だけ。境界は `topic-index/test/architecture.test.ts` が検査する
- **Murmur の口の実装**: `src/feature-port.ts`。本人の接続で上流を読む関数を渡し、トークンは中核の中だけで使う。読める口は入口が種類ごとに固定し(Graph・Jira)、外れた呼び出しは送る前に断る。本人が有効にしていなければ何も読めない
- **スタンドから見た API は変えない**: 今までどおり `issue_token` の `identity:murmur` と `/api/murmur/...`。中継(`proxy.ts`)が、別の Worker に送る代わりに同じ Worker の Murmur に渡す。Murmur はトークンを口でもう一度確かめる。同じ名前の `SERVICES` の定義(別の Worker の Murmur)より機能が優先する。スキルは文言だけ直した(`api-gateway-murmur` 0.1.7)
- **公開の経路**は `/murmur/...`(Graph と Jira の Webhook、Murmur の参照専用の画面)。`/murmur/api/` は経路にしない(API は中継の後ろだけ)
- **同意**: Murmur に接続をつなぐよう頼むと、`/features/murmur/consent` に案内される。本人がサインインして「有効にする」を押すと、保管庫(`UserVault`)に印が残り、Murmur の画面に戻る(サインインの戻り先 `next` を足した)。ホームの「このゲートウェイの機能」から無効にできる
- **本人の画面**: 機能は任意で `userPage` を持てる。ゲートウェイが `/features/<name>` でサインインを確かめ、本人の User ID で本文(HTML の断片)を描かせて、自分の枠に入れて出す。Murmur は「参加中のリスト」を出す(Murmur の [0048](../../topic-index/docs/adr/0048-my-lists-page.md))
- **cron とキュー**: 毎日の `0 18 * * *` は今までどおり期限切れの許可の掃除、ほかの cron は機能に渡す(Murmur の見回り)。キューは機能に渡す
- **有効にする条件**: `MURMUR_DB` と `ANTHROPIC_API_KEY`。Webhook(Graph・Jira)は `MURMUR_WEBHOOK_SECRET` も要る。Murmur に渡すのはこれらと口だけで、ゲートウェイの鍵は渡さない
- **ルートの `npm install`** が `topic-index/` の依存も入れる(`postinstall`)。CI は Worker のドライランのビルドも行う
- **別の Worker の Murmur**(Service Binding・identity・CIMD の形)は段取り 4 で消した。ゲートウェイの `identity` は boid の逆接続のため残る([0003](0003-reverse-connection.md))
