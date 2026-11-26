# 0021 マルチテナントの概念を本体から外し、ストレージを Cloudflare の中（D1 か Durable Object の SQLite）に移す

- 状態: 採用（2026-10-23、直樹）。**D1 にした**（2026-10-23、直樹。「D1 に移して差分の upsert まで入れ、足りなくなったら Durable Object を考える」の順）。決定の 1〜3 は実装済み（下の「実装の記録」）。4（ゲートウェイと一緒にデプロイ）は未着手。**決定 4は 0023（採用、2026-11-04）で改めた**（Murmur をゲートウェイの機能にして 1 つの Worker にした。2026-11-05 に実装）
- 関連: 0020（チーム単位でセルフホストする）、0004（投影の保存の仕方。丸ごと入れ替えるトレードオフ）、0013（テナント境界は秘匿の境界）、0018（1 つの接続 = 1 つの組織）、0003（JWKS を設定値で持つか取りに行くか）、0002（テストランナー）、0001（FC-IS）

## 背景

0020 で、Murmur は 1 チームに 1 つセルフホストすることになった。今の本体には、そこに合わないものが 2 つある。

1. **マルチテナントの概念**: Tenant のマスタがあり、イベント・投影・Party はテナントごとで、User は複数のテナントに入れる。1 デプロイ = 1 チームなら、テナントのキーは要らない
2. **外部の DB（Neon の Postgres）**: セルフホストする人に、Cloudflare とは別の DB の契約と接続文字列の管理を求めることになる。セルフホストの摩擦の中で一番大きい

1 チームに閉じるなら、Ingest もユーザーのアクセスも負荷はそれほど大きくない（よほど大きいチームでない限り）。Cloudflare の中のストレージで足りる、というのがこの ADR の仮説。

## 決定

### 1. マルチテナントの概念を外す

- 境界はデプロイ（0020）。`tenant_id` の列で分けるより強い、物理的な境界になる。チームの中の秘匿はデータソースの読者（0013・0014）がもう受け持っている
- 外すもの: Tenant のマスタ（`entities.ts`・seed の `tenants`）、イベントと投影の `tenantId`、テーブルの `tenant_id`、Webhook のパスの `:tenantId`（`/webhooks/dummy/:tenantId`）、Viewer の中のテナント、`GET /api/lists` などの `tenant` の絞り込み、管理画面のテナントごとの一覧
- 0013 の「テナント境界は秘匿の境界」は「デプロイの境界は秘匿の境界」と読み替える。0018 の「1 つの接続 = 1 つの組織」は、そのまま「1 つの接続 = 1 つのデプロイ」になる
- イベント型が変わるので、CLAUDE.md の約束どおり、zod スキーマ・fold の純関数テスト・リプレイテスト（H1）を同じ変更で直す。シナリオの fixtures（seed・expected）も直す

### 2. 投影は差分だけ書く（0004 のトレードオフの解消を前倒しする）

- 今は書き込みのたびに、テナントの投影（threads・signals・索引）を全部消して全部入れ直している（`PgProjectionStore.save`）。0004 で「パフォーマンスは度外視」として入れたプロトタイプの近道で、ストレージに関係なく直すべきもの
- 新しいイベントで変わったスレッドとシグナルだけを upsert する。どれが変わったかは fold の時点で分かる
- D1 では特に必要になる（下の「D1 の上限」）。差分にすれば、1 回の操作で書くのはイベントの数行と変わったスレッドの数行で、クエリも 10 本前後に収まる

### 3. ストレージは Cloudflare の中に移す。Postgres の実装は保守しない

- 候補は D1 と Durable Object の SQLite（下の比較）。どちらも Workers Free でも動くが、セルフホストの案内は Workers Paid（月 $5）を前提にしてよい
- 抽象は Drizzle ではなく `Repo` のインタフェース（`src/store/types.ts`）。Drizzle は方言ごとにスキーマが別（`pgTable` と `sqliteTable`）で、Drizzle だけでは両対応にならない。
  Postgres が要る人は `Repo` を自分で実装する、でよい。今の `pg` の実装は、移行が終わったら消す
- 型の置き換えは機械的: `jsonb` → TEXT の JSON（SQLite の `json_extract` が使える）、`timestamp with time zone` → ISO 形式の文字列、`generatedAlwaysAsIdentity` → `integer primary key autoincrement`
- テストは pglite から、miniflare（`@cloudflare/vitest-pool-workers`）の D1 か Durable Object に移す。0002（Node の vitest と pglite で回している逸脱）もここで見直す

### 4. デプロイはゲートウェイと一緒にする

- ゲートウェイの `deploy` スキルで Murmur も同じ Cloudflare アカウントにデプロイし、次を自動にする: ゲートウェイの `SERVICES` に `murmur` と `binding` を足す、Service Binding を張る、`GATEWAY_JWKS` と `IDENTITY_ISSUER` を入れる、`WEBHOOK_SECRET` と `TIMELINE_TOKEN` を作る
- 0003 の未決（JWKS を設定値で持つか取りに行くか）は、同じアカウントの中なら Murmur → ゲートウェイの Service Binding で `/.well-known/jwks.json` を取る形で解ける。JWKS を手で写す手順がなくなる
- 利用者が Murmur のために入れるのは、実質 `ANTHROPIC_API_KEY` だけになる

## D1 の上限（2026-10-23 に Cloudflare の公式ドキュメントで確かめた値）

| | Workers Free | Workers Paid |
| --- | --- | --- |
| 1 DB の容量 | 500 MB | 10 GB |
| 1 回の Worker 実行あたりのクエリ数 | 50 | 1,000 |
| 書き込み行数 | 10 万行/日（超えると UTC 0 時までエラー） | 月 5,000 万行まで込み、超過は 100 万行あたり $1 |
| 読み取り行数 | 500 万行/日 | 月 250 億行まで込み |

- 共通: 1 行・1 値は 2 MB まで、1 文は 100 KB まで、バインド変数は 1 文あたり 100 個まで、クエリは 30 秒まで
- 1 DB は 1 スレッドで、クエリを 1 本ずつ処理する。平均 1 ms のクエリなら毎秒約 1,000 本、100 ms なら毎秒 10 本。あふれるとキューに積まれ、キューもいっぱいになると overloaded のエラー
- 容量: メール 1 通を本文込みで 10 KB とすると、10 GB で約 100 万通。投影に本文が二重に入っても、1 日 500 通のチームで数年はもつ

## D1 にしたときに直すところ

1. **対話的なトランザクションがない**: 原子的にできるのは `batch()` だけ（中の 1 文が失敗すれば全体がロールバックされるが、途中の結果を見て分岐はできない）。今の `db.transaction()` は 4 か所
   - `append`: 最大の seq を読んで比べてから挿入している。主キー `(seq)` の一意制約だけで足りる。挿入を `batch()` でまとめ、一意制約の違反を `ConcurrencyError` にする（`isUniqueViolation` の分岐はもうある）
   - `save`・`clear`・`replaceSeed`: `batch()` に置き換える
2. **バインド変数が 1 文 100 個まで**: 今の `insertChunked` は 500 行ずつで、そのままでは通らない。threads（列 4 つ）なら 1 文 25 行まで
3. **全件を書き直す操作**: `rebuild`（イベントから投影を作り直す）と seed の投入は、差分にしても全件を書く。1 回の実行のクエリ数の上限に当たるので、分割して実行するか `wrangler d1 execute` で流す
4. **`projection_meta.idx`**: 索引の JSON を 1 行にまるごと持っているので、いつか 2 MB に当たる。何件で届くかを測り、必要なら行に分ける
5. **場所**: DB の置き場所は作るときに決まる。日本のチームなら `--location apac` で作る。`load()` のように 1 回で何本もクエリを投げるので、Worker と DB の距離が往復の回数分効く
6. **使わないもの**: リードレプリカ（オプトイン。有効にすると Sessions API で読み書きの整合を取る必要がある）

運用: Time Travel で 30 日以内の任意の時点に戻せる（Paid）、`wrangler d1 export` でダンプが取れる、`wrangler d1 migrations apply` でマイグレーションを当てる（SQLite は `ALTER COLUMN` がないので、列の型を変えるときはテーブルを作り直す）。

## もう 1 つの候補: Durable Object の SQLite

SQLite を裏に持つ Durable Object は、1 つごとに専用の SQLite を持ち、`ctx.storage.sql.exec()` で生の SQL を同期的に流せる。ゲートウェイの `UserVault` もすでにこの種類の Durable Object（キーバリューの API だけ使っている）。

- 名前で呼ぶと必ず同じ 1 つのインスタンスに届き、その中ではリクエストが基本的に 1 本ずつ処理される。使っている間はメモリに状態を持てる
- `ctx.storage.transactionSync()` で、読んで判断して書くまでが 1 つのトランザクションになる。処理が直列なので、楽観ロックの再試行も要らない
- 書き込みが永続化されるまで外への応答は送られない（output gate）
- 計算と DB が同じ場所にあるので、1 クエリごとの往復がない。投影をインスタンスのフィールドに持てば、`load()` がほぼ消える
- 1 つあたり 10 GB（Paid。Free は 1 GB という記載もある）、毎秒約 1,000 リクエストが目安の上限。30 日以内の任意の時点に戻せる。`drizzle-orm/durable-sqlite` がある
- マルチテナントを外すと、1 デプロイ = Durable Object 1 つになる。Cron は Durable Object のアラームに置き換える

| | D1 | Durable Object の SQLite |
| --- | --- | --- |
| トランザクション | `batch()` だけ | 本物（同期） |
| 1 クエリの往復 | ネットワーク越し | ほぼゼロ |
| 外から SQL で覗く | `wrangler d1 execute`、ダッシュボード | 手軽ではない（自前の管理用エンドポイントが要る） |
| 移行の大きさ | ストアの実装（`Repo`）の差し替え | サービスの層を Durable Object の中に移す |
| 伸ばし方 | 1 DB の中で | 数を増やす（1 つを大きくする道はない） |

どちらでも FC-IS（0001）は変わらない。D1 でも Durable Object でもシェルの側で、`src/domain/` は純関数のまま。

## 実装の記録（2026-10-23、クラウドセッション）

3 つのコミットに分けた（マルチテナントを外す → 投影を差分で書く → D1 に移す）。決定から外れたところと、決めた細部:

- **テナント**: イベントの payload にはテナントがなかったので、封筒（`DomainEvent`）・投影・スレッドから外すだけで済み、AI の記録のキーも変わらない（再生で 4 本とも一致）。
  User の Party は 1 つまで（`seedProblems`）、Party のない User は何も見えない。fixtures の別テナントは Party・データソース・リストを外して User だけ残し、「チームの外の人は何も見えない」の確かめに読み替えた。
  API は `/me` が `party`（なければ `null`）を返し、`list_threads`・`list_lists`・`add_note` の `tenant` を外した。Webhook は `/webhooks/dummy`
- **差分**: `foldChanges` が、base から変わったスレッド（`recompute` を通ったもの）・シグナル・索引を返す。`ProjectionStore.save(p, changes)` は変わった行だけ upsert し、`changes` がなければ丸ごと入れ替える（作り直し）。
  メモリ実装も差分を当てるので、取りこぼしはシナリオの H1 比較で見つかる。全シナリオのイベント列で「差分は実際に変わったものを必ず含む」をテストしている
- **追記の楽観ロック**: 「主キー `(seq)` の一意制約だけで足りる」と書いたが、それだけでは期待より先の seq（飛び）を弾けない。
  各文を `INSERT ... SELECT ... WHERE (SELECT coalesce(max(seq), 0) FROM events) = <期待>` にし、batch の最初の文が 0 行なら `ConcurrencyError` にした
- **drizzle の batch はパラメータ付きの生 SQL を扱えない**（`db.run(sql...)` を batch に入れると落ちる。drizzle-orm 0.45.4）。追記だけ D1 の API（`db.$client`）を直に使う
- **ダミー上流のキュー**は `UPDATE ... RETURNING` で取り出しと消費を 1 文にした
- **テスト**: `@cloudflare/vitest-pool-workers` には移さず、Node の vitest のまま Miniflare の D1（`scripts/lib/d1.ts`、本物と同じ workerd の実装）を使う。0002 の逸脱（pglite）はこれで解消。
  Miniflare 5（beta、wrangler 4.151 が使う版）は設定の形が変わったので `convertV4MiniflareOptions` で旧い形を渡している
- **seed**: `pnpm seed <scenario> --env dev` は SQL を作って `wrangler d1 execute` で流す（Cloudflare の認証は wrangler のもの）
- **まだのこと**: `wrangler.jsonc` の prod の `database_id` は仮の値（dev は作成済み）。
  `projection_meta.idx` が何件で 2 MB に届くかは測っていない。決定の 4（ゲートウェイの `deploy` スキルで一緒にデプロイ、Service Binding で JWKS を取る）は未着手

## 未決

1. ~~**D1 か Durable Object の SQLite か**~~ → D1（2026-10-23、直樹）。以下は決める前の材料。判断の材料: セルフホストする人が中を覗いて直す場面を重く見るなら D1。トランザクションと速さ、個人の Murmur（0022）との相性を重く見るなら Durable Object。
   D1 に移して差分の upsert まで入れ、足りなくなったら Durable Object を考える、という順もある
2. **1 チームが上限を超えたとき**: Durable Object 1 つ（または D1 1 つ）の容量か速さを超えたら、データソースごとに分ける（リストはもともとデータソースごと）。
   ただし「自分の番」のようにデータソースをまたぐクエリは、複数に聞いて束ねる形になる。チームの規模の前提（0020）なら当面は要らない
3. ~~**着手の時期**~~ → 2026-10-23 に着手して、決定の 1〜3 を実装した

## 代案

- **Neon（Postgres）のまま**: 速さと機能は十分だが、セルフホストする人に別の契約を求める。採らない
- **Turso（libSQL）**: Cloudflare の外からもつなげ、手元に複製を持てる。Murmur は Workers の中で完結するので、別の契約を増やしてまで選ぶ理由がない
- **Postgres と D1 の両方を保守する**: `Repo` の実装が 2 つになり、テストも 2 系統になる。D1（か Durable Object）に寄せきる
