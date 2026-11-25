# 0006 製品の名前を Heddleway にする。説明の言葉は「チームのゲートウェイ」

- 状態: 採用(2026-11-05、直樹とのディスカッション)。段取り 1〜5 を終えた(2026-11-05。リポジトリの改名は直樹が GitHub で行った)
- 関連: [0004](0004-one-deployment-per-organization.md)(1 つのデプロイ = 1 つの組織)、[0005](0005-murmur-as-a-feature.md)(Murmur をゲートウェイの機能にする。決定 5 で製品の総称を保留した)、Murmur の [`topic-index/docs/adr/0020`](../../topic-index/docs/adr/0020-team-unit-self-hosted.md)(1 チームに 1 つ、ゲートウェイとは 1 対 1)

## 背景

0005 で Murmur をゲートウェイの機能にまとめたので、このリポジトリの中身は「API を中継する門」だけではなくなった。通り抜ける連絡がスレッドとして整理され、追跡される。`api-gateway-mcp`(汎用の API ゲートウェイ、MCP サーバー)という名前では、この半分しか言えていない。0005 の決定 5 は、製品の総称(「○○ Gateway」)を保留にしていた。

「○○ gateway」の形で探した候補はどれも足りなかった。

- task gateway: Murmur はタスク管理ツールではない(Murmur の 0012)。資格情報の中継(会計や業務アプリの API)はタスクと関係ない
- communication gateway: Murmur の側には合うが、資格情報の中継を言えない。メールの中継サーバーに聞こえる
- agent gateway: 分かりやすいが、同じ名前のプロジェクトが多すぎる

そこで、一語の固有の名前と、何をするかを言う説明の言葉に分けることにした。一語の名前の候補は次のように調べた(2026-11-05、npm・GitHub・Web 検索)。

- Heddle(綜絖。織機で経糸を 1 本ずつ通して並べる部品)と Sluice(水門)は、意味は合う。ただ、MCP のポリシーの層、LLM のゲートウェイ、MCP のセキュリティゲートといった同じ分野に、同名の小さな OSS がいくつもある。「通り抜けると整う」という比喩は、みんな同じことを考えている
- 派生の Heddleway・Heddlegate・Sluicehouse は、npm と GitHub のどちらも空いていて、Web でもソフトウェアとしては見つからない。Sluicegate は、AI のプロキシゲートウェイに同名の OSS がある

大々的に売り出す製品ではない。各デプロイは自分の組織のドメインのサブドメインで動く(0004)。だから、名前は覚えやすさと、同じ分野でまぎれないことだけ満たせばよい。

## 決定

### 1. 製品の名前は Heddleway

- 綜絖(heddle)と「道・門」(-way)。チームの連絡というスレッドが 1 本ずつ通り抜けて整列する、という Murmur の見方と、ゲートウェイの「-way」を両方残す
- 表記は `Heddleway`(先頭だけ大文字)。識別子は `heddleway`(小文字)
- 日本語の文章でも `Heddleway` と書き、カタカナ(ヘドルウェイ)は使わない

### 2. 説明の言葉は「チームのゲートウェイ」(a team gateway for agents)

- 一語の名前は何をするかを言わないので、説明は README の 1 行目、MCP サーバーの説明、画面の見出しの横で受け持つ
- 「チーム」は Murmur の 0020 に合わせる。1 チームに 1 つセルフホストする。資格情報もスレッドもそのチームのもので、チームの境界を越えるときは要約のレベルを変える
- 例: 「Heddleway — エージェントのための、チームのゲートウェイ」/「Heddleway — a team gateway for agents」

### 3. Murmur は Heddleway の機能の名前として残す

- Murmur(チームの仕事の記憶)は 0005 のとおり Heddleway の機能の 1 つ。機能の名前・REST の経路(`/api/murmur/...`・`/murmur/...`)・`identity:murmur`・`topic-index/` のディレクトリは変えない
- Murmur の ADR の番号(`topic-index/docs/adr/`)もそのまま続ける

### 4. 変えるもの

利用者から見える名前は、すべて Heddleway にそろえる。0005 の決定 5(「プラグイン名は変えない」)は、この ADR で改める。利用者は一度だけプラグインを入れ直すことになるが、利用者が少ない今のうちに済ませる。

| 対象 | 今 | 新しい名前 |
|---|---|---|
| GitHub のリポジトリ | `novshi-tech/api-gateway-mcp` | `novshi-tech/heddleway` |
| マーケットプレイス(`.claude-plugin/marketplace.json` の `name`) | `api-gateway-mcp` | `heddleway` |
| 共通のプラグイン | `api-gateway` | `heddleway` |
| 提供元ごとのプラグイン | `api-gateway-<提供元>`(google・microsoft・atlassian・freee・slack) | `heddleway-<提供元>` |
| Murmur のスキル | プラグイン `api-gateway-murmur` | 共通のプラグイン `heddleway` のスキル `murmur`(下の「Murmur のスキルの置き場所」) |
| プラグインの表示名(`displayName`) | `API Gateway`、`API Gateway: <提供元>` | `Heddleway`、`Heddleway: <提供元>` |
| 共通のスキル | `api-gateway` | `heddleway` |
| MCP サーバーの `name` / `title` | `api-gateway-mcp` / `API Gateway (<組織名>)` | `heddleway` / `Heddleway (<組織名>)` |
| OAuth の保護リソースの `resource_name` | `API Gateway MCP` | `Heddleway` |
| 画面の見出し・許可の画面 | `API ゲートウェイ · <組織名>` など | `Heddleway · <組織名>` など |
| スクリプトの User-Agent | `api-gateway-client` / `api-gateway-mcp-tools` | `heddleway-client` / `heddleway-tools` |
| `package.json` の `name`、README の題 | `api-gateway-mcp` | `heddleway` |

- スキルの本文の「API ゲートウェイ」「ゲートウェイ」という言い方は、仕組みを説明する一般名詞として残してよい(「Heddleway のゲートウェイの機能」)。名前として指すところだけ直す
- ほかのマーケットプレイスにある、`api-gateway` に依存するプラグイン(業務向けのスキル集など)は、それぞれの持ち主が `dependencies` と本文の「api-gateway プラグイン」を直す。この ADR の範囲は、このリポジトリが配るものだけ

### 4a. Murmur のスキルは共通のプラグインに入れる(2026-11-05 に足した)

最初は `api-gateway-murmur` を `heddleway-murmur` に改名した(PR #49)。しかし、Cowork では `heddleway-murmur:murmur` と出て、Murmur が Google や freee と同じ「外のサービス」に見える。Murmur は Heddleway の機能(決定 3)なので、`murmur` スキルを共通のプラグイン `heddleway`(git・board・gBizINFO・Serper のスキルと同じ場所)に移し、`heddleway-murmur` はなくした。

- 誰も入れ直す前だったので、利用者の作業は増えない
- Murmur を有効にしていないデプロイでもスキルは見えるが、ほかの小さいスキルと同じ扱い。スキルの冒頭に、デプロイによっては無効なことを書いた

### 5. 変えないもの

- **各デプロイの Worker の名前(`deployments/<名前>.jsonc` の `name`)は変えない。** Durable Object(`UserVault`・`Registry`)のデータは Worker の名前に結びついている。名前を変えると別の Worker として作られ、保管庫の中身(利用者の認証情報)が見えなくなる。`wrangler.example.jsonc` の名前だけ、新しいデプロイ向けに `heddleway` にする
- **各デプロイのドメインと `PUBLIC_URL` は変えない。** コネクタの URL と、上流の OAuth のアプリのコールバックが変わってしまう。サブドメインを新しく取るかどうかは、デプロイする人が決める(0004)
- **MCP のツール名(`list_credentials`・`issue_token`)と、トークンの形・REST の形は変えない。** 名前の変更だけで、動きは変えない
- **利用者が Claude に付けたコネクタ名**は、利用者のもの。README とスキルでは「組織が分かる名前を付ける」(0004)のまま
- **デプロイの設定のリポジトリ**(README の「設定をリポジトリで管理する」)の名前は、デプロイする人が決める。README の例だけ `<組織>/heddleway-deployments` に直す

## 段取り

1. **表示を変える**(コードだけ、利用者の作業なし): MCP サーバーの `title`、`resource_name`、画面の見出し、許可の画面、README の題と 1 行目。テスト(`test/gateway.test.ts` など)の期待値も直す。デプロイし直せば、どの組織のコネクタでも新しい名前が出る
2. **リポジトリを改名する**: GitHub で `api-gateway-mcp` を `heddleway` に変える。GitHub は旧い URL を転送するので、clone 済みの手元とマーケットプレイスの登録はしばらく動く。`marketplace.json` の `url`、README とセットアップ画面の `/plugin marketplace add`、テストの期待値を新しい URL に直す
3. **プラグインを改名する**: ディレクトリ(`plugins/api-gateway*` → `plugins/heddleway*`)、`plugin.json` と `marketplace.json` の `name` と `dependencies`、スキルの中の相互参照(`api-gateway` スキルを前提とする書き方)、セットアップ画面の zip の名前を変える。版は上げる。README・`docs/`、Murmur の `CLAUDE.md`・`docs/stand/`・`docs/HANDOFF.md` などの「プラグイン `api-gateway-murmur`」も直す
4. **利用者に入れ直してもらう**: 旧い `api-gateway*` を外し、`heddleway*` を入れる手順を README とセットアップ画面に書く。旧い名前のプラグインは配らない(並べて置くと、同じスキルが 2 つ出る)
5. **残りの識別子**: User-Agent、`package.json` の `name`、`wrangler.example.jsonc` の Worker の名前

段取り 1 は単独で先にやってよい。段取り 2〜4 は、同じ日にまとめてやる。プラグインの名前とリポジトリの URL が食い違う期間を作らないため。

## 検討した他の案

- **プラグイン名は `api-gateway-*` のまま、表示だけ Heddleway にする**(0005 の決定 5 を守る): 入れ直しは要らないが、製品の名前とプラグインの名前が別になり、スキルの中の説明がずっと二重になる。利用者が少ない今が一番安く変えられるので採らない
- **Sluice / Sluicegate / Sluicehouse**: 水門の比喩は分かりやすいが、Sluice と Sluicegate には同じ分野の同名がある。Sluicehouse は空いているが、スレッドとのつながりがない
- **Heddle(一語)**: 同じ分野に同名の OSS が複数ある
- **「○○ gateway」の形**(task・communication・agent): 背景のとおり
