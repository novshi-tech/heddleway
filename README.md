# Heddleway

エージェントのための、チームのゲートウェイです(a team gateway for agents。名前は [docs/adr/0006](docs/adr/0006-name-heddleway.md))。Claude から、既存のコネクタではできない API 呼び出しを行うための汎用の API ゲートウェイで、通り抜けるやりとりを、トピック索引(内部の名前は Murmur)がトピックとして整理します。Cloudflare Workers で動くリモート MCP サーバーとして、自分の組織の Cloudflare アカウントにデプロイします。

Claude(Cowork など)のコード実行のサンドボックスから、freee や Microsoft 365 などの API を、スクリプトで直接呼べるようになります。一覧の全件取得や集計、ファイルのダウンロード・アップロードのように、コネクタのツールでは手間のかかる作業を、Claude がスクリプトを書いて進めます。1 件の取得や登録のような小さい呼び出しは、コネクタのツール `api_get` / `api_request` から、スクリプトなしで呼べます([docs/adr/0007](docs/adr/0007-call-apis-from-mcp-tools.md))。

## しくみ

```
Claude ──MCP(OAuth でサインイン)──▶ ゲートウェイ ─┐
  │  issue_token で 15 分のトークンを受け取る       │ 認証情報を注入して中継
  ▼                                                 ▼
サンドボックスのスクリプト ──REST /api/<service>/...──▶ freee・Graph・Gmail などの API
```

小さい呼び出しは、MCP のツール `api_get`(読み取り。確認なしで呼べる)と `api_request`(POST・PUT・PATCH・DELETE。呼ぶたびに確認が出る)で、ゲートウェイが同じ中継を通して呼びます。返すのはテキストだけで、長いボディは切り詰め、ファイル(バイナリ)はスクリプトに任せます。

- **Claude は認証情報を見ません。** API キーや OAuth のトークンは、ユーザーがゲートウェイの Web 画面で登録し、暗号化して保存されます。Claude が受け取るのは、寿命 15 分のゲートウェイのトークンだけです。
- **よく使うサービスは組み込みです。** freee、Microsoft Graph、Google(Gmail・Drive・Calendar・Docs・Tasks・Analytics)、Slack、Jira、Confluence、board、gBizINFO、Serper、X は `src/catalog.ts` にあり、OAuth のクライアントを登録すれば使えます。ほかのサービスは、デプロイの設定の `SERVICES` に書くか、管理画面から、ベース URL と認証方式(ヘッダーか OAuth 2.0)を書いて足します。OAuth のトークンの更新もゲートウェイが受け持ちます。
- **使い方はスキルで配ります。** API の呼び方は、Claude のスキル(プラグイン)にまとめて配布します。コネクタの URL を含めていないので、どのデプロイでも同じプラグインを使えます。

Claude の Cowork で動作を確認しています。MCP の OAuth に従っているので、ほかの Claude のクライアントや ChatGPT のコネクタにも対応する設計ですが、まだ確認していません。設計の詳細は [docs/concept.md](docs/concept.md) と [docs/auth-design.md](docs/auth-design.md) にあります。

## トピック索引(Murmur)

[`murmur/`](murmur/) は、ゲートウェイの機能の 1 つ「トピック索引」です(内部の名前は Murmur)。メール・Teams・Jira・To Do などのやりとりをトピック(アクションアイテムの候補になる会話)にまとめ、誰の番かを追います。自分が担当か、自分へのアテンションが残っているトピックが、自分のタスクです。利用者は意識せず、エージェント(Claude など)が裏で読んで「いまやるべきこと」に答えるための索引です([docs/adr/0005](docs/adr/0005-murmur-as-a-feature.md)、言葉は [murmur/docs/adr/0040](murmur/docs/adr/0040-surface-vocabulary.md))。

- ゲートウェイの Worker に入っていて、デプロイの設定に Murmur の D1 を足すと有効になります(`wrangler.example.jsonc` の末尾)。足さなければ、ゲートウェイはトピック索引なしで今までどおり動きます
- 利用者ごとに、ゲートウェイの画面で有効にします(エージェントにトピック索引への接続を頼むと、有効にする画面に案内されます)。有効にした人の接続だけを、読み取りだけで使います。「つないだサービス」の画面でいつでも無効にできます
- エージェントからは、ほかのサービスと同じく `issue_token`(`identity:murmur`)と REST(`/api/murmur/...`)で使います。使い方はプラグイン `heddleway` の `topic-index` スキルです

## 前提

- Cloudflare のアカウント(Workers、Durable Objects、KV を使います)
- サインインに使う IdP: Microsoft Entra ID か Google Workspace
- Node.js 24 と npm
- Claude のカスタムコネクタとコード実行を使えるプラン。Team / Enterprise では、組織の管理者がコード実行のネットワーク設定で、ゲートウェイのドメインを許可する必要があります。

## はじめる

いちばん楽なのは、このリポジトリを Claude Code で開いて「ゲートウェイをデプロイしたい」と頼むことです。作業用のスキル(`.agents/skills`。`.claude/skills` はそこへのリンク)が、手順に沿って対話で進めます。

- `deploy`: IdP へのアプリ登録、デプロイごとの設定(`deployments/<名前>.jsonc`)の作成、KV とシークレットの登録、デプロイ、コネクタの追加までと、設定を変えたあとの再デプロイ
- `add-service`: 新しいサービスを足す。認証方式の調査、`SERVICES` の定義、OAuth のシークレット、サービス別のスキルの作成まで。例:「kintone の API をゲートウェイに足して」

手作業で進める場合は、下の「デプロイ」に従ってください。

## 使い方

ゲートウェイの Web 画面(`https://<ゲートウェイ>/`)にサインインし、「Claude につなぐ」(`/setup`)を開くと、1 と 2 に要るもの(コネクタの URL とおすすめの名前、Claude Code のコマンド、プラグインの zip)がそろっています。利用者にはこの画面を案内してください。

1. コネクタを追加します。
   - Pro / Max: 個人の設定で、カスタムコネクタとして `https://<ゲートウェイ>/mcp` を追加します。
   - Team / Enterprise: Owner が組織の設定で同じ URL を追加し、各メンバーが接続します。
2. プラグイン `heddleway` と、使う提供元のプラグイン(`heddleway-google` など)をインストールします(下の「スキル」)。「Claude につなぐ」から zip でダウンロードできます。
3. 各ユーザーは `https://<ゲートウェイ>/` にサインインし、連携先の認証情報を登録します(OAuth のサービスは「接続」)。
4. あとは Claude に頼むだけです。Claude は `list_credentials` で認証情報を確かめ、小さい呼び出しは `api_get` / `api_request` で、大量の呼び出しやファイルは `issue_token` でトークンを受け取ってスクリプトで REST を呼びます。
5. 許可したアプリ(Claude、トピック索引など)は、Web 画面のトップの「アクセスを許可したアプリ」に 1 回の許可ごとに出ます。「取り消す」で、そのアプリのアクセストークンとリフレッシュトークンが使えなくなります。

### 複数の組織で使う

ゲートウェイは 1 つのデプロイが 1 つの組織です([ADR 0004](docs/adr/0004-one-deployment-per-organization.md))。複数の組織で仕事をするなら、組織ごとにデプロイし、それぞれを別のコネクタとして Claude に並べてつなぎます。

- コネクタには組織が分かる名前を付けます(「Acme Gateway」など)。ゲートウェイも、設定の `ORGANIZATION_NAME` を Claude と Web 画面に名乗ります。スキルはコネクタが複数あることを前提に書かれていて、作業する組織のコネクタを選びます。
- 1 人がつなげるアカウントは、1 つのサービスにつき 1 つです。別の組織のアカウントは、その組織のゲートウェイでつなぎます。アカウントを替えるときは、OAuth のサービスはつなぎ直し、API キーのサービスは削除してから追加します。以前につないだ 2 つ目以降の接続は使えるまま残り、画面に「使わないほうを削除してください」と出ます。
- コネクタを通ったデータは、そのコネクタをつないだ Claude のアカウントに入ります。どの Claude にどのゲートウェイをつなぐかは、使う側が決めます。組織が契約している Claude(Team / Enterprise)には、その組織のゲートウェイだけをつなぐのがおすすめです。

```sh
curl -H "Authorization: Bearer $TOKEN" "https://<ゲートウェイ>/api/freee/api/1/companies"
```

## スキル

このリポジトリは Claude のプラグインのマーケットプレイスを兼ねています。共通の `heddleway` を入れ、使う提供元のプラグインを足します。Microsoft 365 だけ、Google だけ、という使い方ができます。

| プラグイン | スキル | サービス名 | できること |
| --- | --- | --- | --- |
| `heddleway`(必須) | `heddleway` | — | トークンの発行と、REST の呼び出し(`gw_request.py`)の共通手順。ほかのスキルはこれを前提にする |
| | `board` | `board` | 販売管理 SaaS「board」の案件・見積・請求・発注・支払・顧客などの検索・登録・更新 |
| | `gbizinfo` | `gbizinfo` | 経済産業省の法人情報(gBizINFO)の検索 |
| | `serper` | `serper` | Serper 経由の Google 検索(ウェブ・画像・ニュース・地図・論文など) |
| | `x` | `x` | X(旧 Twitter)のポストの検索・取得、投稿・返信・画像の添付、いいね・リポスト・ブックマーク(ユーザー本人として) |
| | `topic-index` | `murmur` | トピック索引(このゲートウェイの機能)のトピック・誰の番・To Do のタスクでの追跡と経過のメモ・送信の記録。有効にする手順は上の「トピック索引(Murmur)」 |
| `heddleway-microsoft` | `microsoft-graph` | `graph` | Outlook メール、OneDrive / SharePoint、Teams、予定表 |
| `heddleway-google` | `gmail` | `gmail` | メールの検索・送信・返信・下書き、添付ファイル |
| | `google-drive` | `drive` | ファイルの検索・ダウンロード・エクスポート・アップロード、共有ドライブ |
| | `google-calendar` | `calendar` | 予定の検索・作成・更新、空き時間の確認 |
| | `google-docs` | `docs` | ドキュメントの本文の読み取り、作成、追記・置換・書式の編集 |
| | `google-analytics` | `analytics`・`analytics-admin` | GA4 のレポート取得、アカウントとプロパティの参照(読み取り専用) |
| `heddleway-freee` | `freee` | `freee` | 会計・人事労務・請求書・販売の API |
| `heddleway-slack` | `slack` | `slack` | チャンネル・DM の履歴とスレッド、検索、投稿・返信、リアクション(ユーザー本人として) |
| `heddleway-atlassian` | `jira` | `jira` | Jira Cloud の課題の検索・作成・更新、コメント、遷移、担当者 |
| | `confluence` | `confluence` | Confluence Cloud のページの検索(CQL)・取得・作成・更新、コメント、添付、ラベル |

インストールの方法:

- Claude Code: `/plugin marketplace add novshi-tech/heddleway` のあと、`/plugin install heddleway@heddleway` と、使う提供元のもの(例: `/plugin install heddleway-microsoft@heddleway`)をインストールします。提供元のプラグインは `heddleway` に依存しているので、先に入れていなくても一緒に入ります。
- Pro / Max: Customize > Plugins > Add marketplace で `novshi-tech/heddleway` を追加し、`heddleway` と使う提供元のプラグインをインストールします。
- Team / Enterprise: Owner が Organization settings > Plugins & skills で、このリポジトリ(または、これを参照する社内のマーケットプレイス用リポジトリ)を同期し、配布方法を選びます。
- zip: `npm run plugin:zip` で `dist/<プラグイン>-<version>.zip` をプラグインごとに作り、Plugins の Upload plugin で追加します。更新するときは `plugin.json` と `.claude-plugin/marketplace.json` の `version` を上げて作り直し、同じ名前でアップロードし直します。Cowork で GitHub のマーケットプレイスの同期がうまくいかないときは、zip を使ってください。

- ゲートウェイの Web 画面: 「Claude につなぐ」(`/setup`)に、このリポジトリのプラグインの zip が並び、サインインした人がダウンロードできます。`npm run deploy` が `tools/build-plugin-zip.py --bundle` で zip を `dist/plugins.js` に書き出し、Worker 本体に同梱してデプロイするので、いつもそのゲートウェイの版のものです。静的アセットにしないのは、アセットのアップロードがアップロードごとのトークンを `Authorization` で送るためで、Cloudflare の API トークンを差し込むプロキシ(Claude Code のクラウドのセッションなど)の下ではデプロイが失敗するからです。ほかのプラグイン(自社のサービスのスキルなど)は、管理者が「プラグインの配布」(`/admin/plugins`)で zip を追加すると、同じ画面に並びます(下の「管理画面から接続先を足す」)。

2026-11-05 に、プラグインの名前を `api-gateway*` から `heddleway*` に変えました([docs/adr/0006](docs/adr/0006-name-heddleway.md))。前の名前のプラグインを入れている人は、入れ直してください。

1. 前のプラグイン(`api-gateway` と `api-gateway-<提供元>`)をアンインストールします。並べて入れておくと、同じスキルが 2 つ出ます
2. 新しいプラグイン(`heddleway` と、使う提供元の `heddleway-<提供元>`)をインストールします。Claude アプリでは「Claude につなぐ」から zip をダウンロードしてアップロードし、Claude Code では `/plugin marketplace remove api-gateway-mcp` のあと、上の手順でマーケットプレイス `novshi-tech/heddleway` を足し直します
3. ほかのマーケットプレイスの、`api-gateway` に依存するプラグインは、依存を `heddleway` に変えた版に上げます

コネクタ(MCP の URL)は変わらないので、つなぎ直しは要りません。

以前の版の `api-gateway`(0.11 まで)は、全部のスキルが 1 つに入っていました。0.12 からは、使う提供元のプラグインを足します。

スキルのスクリプトが使う共通のファイル(`gwlib.py`、`gw_request.py`、`google_paging.py`)の原本は `lib/plugin/` にあります。Claude Code はプラグインごとに別の場所にインストールし、Cowork はスキルのディレクトリを `<プラグイン>:<スキル>` と名付けるので、スキルからほかのスキルのファイルには届きません。そのため、各スキルの `scripts/` にコピーを置いています。原本を変えたら `npm run plugin:sync` でコピーを更新します(テストがずれを検出します)。

ほかのサービスのスキルは、自分のプラグインに作って足します(`add-service` スキル)。業務に寄ったサービスのスキルは、このリポジトリに入れず、別のプラグインに分けて運用するのがおすすめです。そのスキルにも `gwlib.py` と `gw_request.py` のコピーを同梱してください。

## デプロイ

### 1. IdP にアプリを登録する

ゲートウェイへのサインインに使うアプリを登録し、リダイレクト URI を 2 つ設定します。

- `https://<ゲートウェイ>/oauth/callback`(MCP クライアントの接続)
- `https://<ゲートウェイ>/login/callback`(Web 画面のサインイン)

アプリは、その組織の中だけで使える形で登録します(1 つのデプロイ = 1 つの組織)。Entra ID はシングルテナントのアプリとして登録し、`OIDC_ISSUER` を `https://login.microsoftonline.com/<tenant-id>/v2.0` にします。Google は、Workspace のドメインを `ALLOWED_DOMAINS` に必ず指定します(空だと、どの Google アカウントでもサインインできてしまいます)。

### 2. 設定してデプロイする

デプロイ先ごとに、設定を `deployments/<名前>.jsonc` に置きます。名前は自由に付けてよく、1 つの clone で複数のデプロイを扱えます。`deployments/` はこのリポジトリの git の管理外です。設定は、デプロイする人の private リポジトリで管理し、`deployments/` に clone して使うのがおすすめです(下の「設定をリポジトリで管理する」)。`wrangler.example.jsonc` をコピーし、`$schema` と `main` のパスの先頭に `../` を付けます。Worker の `name` はデプロイごとに変え(すでに動いているデプロイの `name` は変えません。Durable Object の保管庫が Worker の名前に結びついているので、変えると登録済みの認証情報が見えなくなります。[docs/adr/0006](docs/adr/0006-name-heddleway.md))、別の Cloudflare アカウントなら `account_id` も書きます。`vars` に `PUBLIC_URL`、組織名(`ORGANIZATION_NAME`)、IdP の設定を書きます。Microsoft Graph を使うなら `MICROSOFT_TENANT_ID` も書きます。組み込みにないサービスは `SERVICES` に足します。KV ネームスペースを作って、ID を `kv_namespaces` に設定します。

wrangler は、`npm run deploy` / `npm run secret` / `npm run tail` に名前を付けて呼びます(`tools/wrangler.mjs` が `--config deployments/<名前>.jsonc` を渡します)。リポジトリの直下には `wrangler.jsonc` を置かないので、名前を付けずに `npx wrangler deploy` を打っても、どこにもデプロイされません。

```sh
npm ci
mkdir -p deployments   # 設定をリポジトリで管理するなら、代わりに git clone <設定のリポジトリ> deployments
sed -e 's|"node_modules/|"../node_modules/|' -e 's|"src/index.ts"|"../src/index.ts"|' wrangler.example.jsonc > deployments/acme.jsonc
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
npm run secret -- acme put OIDC_CLIENT_SECRET
openssl rand -base64 32 | npm run secret -- acme put SIGNING_KEY
openssl rand -base64 32 | npm run secret -- acme put ENCRYPTION_KEY
npm run deploy -- acme
```

- `ENCRYPTION_KEY` を変えると、登録済みの認証情報は復号できなくなります。
- `SIGNING_KEY` を変えると、発行済みのトークンと MCP の接続が無効になり、ユーザーは接続し直しになります。
- `IDENTITY_SIGNING_KEY` を変えると、`identity` の上流が古い公開鍵をキャッシュしている間は検証に失敗します。上流が JWKS を取り直すまで待つか、上流の公開鍵を差し替えます。
- 以前の版で設定に足した `assets`(`"directory": "../dist/assets"`)は、もう使いません。消してください。
- 設定を変えたら、`npm run deploy -- <名前>` で出し直します。設定をリポジトリで管理しているなら、コミットしてプッシュもします。
- 新しい版で Durable Object やその migration が増えたときは(`wrangler.example.jsonc` の `durable_objects` と `migrations`)、各デプロイの設定にも同じものを足してから出し直します。deploy スキルが照らし合わせて直します。

#### 設定をリポジトリで管理する

`deployments/` は、このリポジトリの git が見ないディレクトリです。そこに、設定だけを入れた別の private リポジトリを clone します(サブモジュールにはしません)。

```sh
git clone git@github.com:<組織>/heddleway-deployments.git deployments
```

- 設定ファイルの `main` などの相対パス(`../src/index.ts`)は、`deployments/` の中にあるので、そのまま動きます。`tools/wrangler.mjs` も変わりません。
- 入れるのは `<名前>.jsonc` だけです。Worker の名前、`account_id`、`PUBLIC_URL`、`ORGANIZATION_NAME`、IdP の設定、KV の ID、`SERVICES` が入ります。秘密の値ではありませんが、テナント ID なども入るので、リポジトリは private にします。
- シークレット(`OIDC_CLIENT_SECRET`、`SIGNING_KEY`、`ENCRYPTION_KEY`、`OAUTH_*`)は入れません。`npm run secret` で Cloudflare に入れるだけで、ファイルには残しません。
- 別のマシンや新しい clone でデプロイするときは、ゲートウェイを clone したあと、同じように設定のリポジトリを `deployments/` に clone します。

### 3. 連携先を設定する

ヘッダーで認証するサービス(組み込みの `board`・`gbizinfo`・`serper` など)は、設定は要りません。ユーザーが Web 画面で API キーやトークンを登録します。

Basic 認証のサービス(`auth.type` が `basic`)は、ユーザーが Web 画面でユーザー名とパスワードを登録し、ゲートウェイが `Authorization: Basic …` を組み立てて送ります。ユーザー名が決まっている上流は `username` に書くと、ユーザーはパスワードだけを入れます。git の smart HTTP もこれで中継できます(`docs/adr/0002`)。

```jsonc
"github-git": {
  "display_name": "GitHub(git)",
  "base_url": "https://github.com",
  "auth": { "type": "basic", "username": "x-access-token", "password_label": "GitHub の personal access token" }
}
```

```sh
git -c http.extraHeader="Authorization: Bearer $GW_TOKEN" clone https://<ゲートウェイ>/api/github-git/<owner>/<repo>.git
```

Claude からは、組み込みのプラグイン `heddleway` の `git` スキルが、トークンを `.git/config` に残さずに git を呼びます。

OAuth 2.0 のサービス(`auth.type` が `oauth2`)は、Web 画面から認可コード + PKCE で接続します。連携先にアプリを登録し、コールバック URL に `https://<ゲートウェイ>/connect/callback` を指定します。クライアントは、組み込みのサービスでは `freee`・`google`・`microsoft`・`slack`・`atlassian`・`x` で、Google の 6 つのサービスは 1 組を共有します(Jira と Confluence も)。`SERVICES` に足したサービスは、`auth.client` に書いた名前か、なければサービス名がクライアントの名前です。

クライアント ID とシークレットは、次のどちらかで登録します。

- **管理画面**(おすすめ): 「接続先の管理」の「OAuth のクライアント」で、クライアントごとに入れます。デプロイし直す必要はなく、保存すると利用者の画面に出ます(反映まで最大 30 秒)。シークレットは `ENCRYPTION_KEY` で暗号化して保存します。管理画面を使うには、デプロイの設定の `ADMINS` に自分を入れておきます(下の「管理画面から接続先を足す」)。
- **デプロイのシークレット**: クライアントの名前を大文字にした名前で登録します(ハイフンは `_` に)。こちらが登録されていれば、管理画面の値より優先されます。

```sh
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_ID
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_SECRET
```

以下の連携先ごとの説明にある `OAUTH_..._CLIENT_ID` / `_CLIENT_SECRET` も、管理画面の同じ名前のクライアントで代わりに入れられます。

クライアントが登録されていない OAuth のサービスは、Web 画面にも `list_credentials` にも出ません。以前のサービスごとの名前(`OAUTH_GMAIL_CLIENT_ID` など)は読まなくなったので、古いデプロイでは `OAUTH_GOOGLE_*` / `OAUTH_MICROSOFT_*` を登録し直してください。

アクセストークンは、期限の 1 分前からゲートウェイがリフレッシュします。リフレッシュトークンが失効したら、Web 画面に「再接続」が出ます。

### 管理画面から接続先を足す

デプロイの設定の `ADMINS` にユーザー ID をカンマ区切りで書くと、その人の画面に「接続先の管理」が出ます。ユーザー ID は、Web 画面のトップの一番下にある「アカウントの情報」を開くと表示されます(Entra は `entra_<テナント ID>_<オブジェクト ID>`、Google は `google_<sub>`)。

同じ人の画面には「プラグインの配布」も出ます。プラグインの zip(`.claude-plugin/plugin.json` を含むもの、2 MB まで)を追加すると、全員の「Claude につなぐ」からダウンロードできるようになります。名前と版は zip の中の `plugin.json` から読み、同じ名前で追加し直すと置き換わります。組み込みのプラグインと同じ名前は使えません。zip は Durable Object(`Registry`)に保管します。

管理画面で足した接続先(ヘッダー、Basic 認証、OAuth 2.0)は、デプロイし直さなくても、全員の「接続を追加」に出ます(反映まで最大 30 秒)。定義は Durable Object(`Registry`)に、OAuth のクライアントシークレットは暗号化して保管します。組み込みと同じ名前は使えず、`SERVICES` に同じ名前があれば `SERVICES` が勝ちます。ベース URL のホストやトークンの URL、クライアント ID を変えると、その接続先の既存の接続は使えなくなり、利用者はつなぎ直すことになります(鍵が新しい向き先に送られないようにするため)。

ゲートウェイのサインインを信頼する自社の API(`auth.type` が `identity`)は、ユーザーが何も登録しません。ゲートウェイがサインイン中のユーザーの ID(`sub`)を Ed25519 で署名し、`Authorization: Bearer <JWT>` として送ります。JWT は `iss` がゲートウェイの URL、`aud` が設定の `audience`、寿命は 5 分です。上流は `https://<ゲートウェイ>/.well-known/jwks.json` の公開鍵で検証します。Claude からは、`list_credentials` に `identity:<サービス名>` という認証情報として見えます。

```jsonc
"murmur": {
  "display_name": "トピック索引",
  "base_url": "https://murmur.internal/api",
  // 公開ルートを持たない Worker には、Service Binding で中継する
  "binding": "MURMUR",
  "auth": { "type": "identity", "audience": "murmur" }
}
```

```sh
# 署名鍵(Ed25519 の秘密鍵の JWK)を作って登録する
node -e "crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))" | npm run secret -- <名前> put IDENTITY_SIGNING_KEY
```

`binding` を書いたサービスは、公開のインターネットではなく、デプロイの設定の `services` に書いた Service Binding(`{ "binding": "MURMUR", "service": "murmur" }`)で上流を呼びます。`base_url` のホスト名は使われず、パスだけが意味を持ちます。

#### 人がいないときに Worker が使う接続先(`client_credentials`)

Murmur のように、夜中の通知や定期の見回りでユーザーがいないときにも上流を呼ぶ Worker のために、OAuth 2.0 の client credentials でゲートウェイ自身がトークンを取る接続先を置けます(設計は [docs/background-access.md](docs/background-access.md))。持ち主はユーザーではなくデプロイで、Web 画面にも `list_credentials` にも出ず、REST(`/api/`)からも使えません。

- 管理画面の「接続先を追加」で認証方式に「OAuth 2.0(client credentials)」を選び、トークンの URL・スコープ・クライアント ID・シークレットを入れます。設定ファイルに書くこともできます(クライアントは `OAUTH_<CLIENT>_CLIENT_ID` / `_CLIENT_SECRET`)。
- 呼べるのは、同じ Cloudflare アカウントの Worker が名前付きのエントリポイント `Background` に張った Service Binding からだけです。名前付きのエントリポイントはインターネットに出ないので、呼び出し元との間のシークレットは要りません。そのアカウントに Worker をデプロイできる人は使える、という信頼の置き方です。
- パスは `/<サービス名>/<上流のパス>`(`/api` は付けない)。ヘッダーの扱いとリダイレクトは REST と同じです。
- アクセストークンは期限の 1 分前まで Worker のメモリで使い回し、保管しません。
- 上流のアプリの権限は、読ませるものだけに絞ってください。Microsoft Graph で共有メールボックスを読ませるなら、下の手順で Exchange の RBAC for Applications を使います。

Microsoft Graph で共有メールボックスだけを読ませる手順(テナントの管理者):

1. Entra 管理センターの「アプリの登録」でアプリを登録し(シングルテナント、リダイレクト URI なし)、クライアント シークレットを作ります。クライアント ID と、「エンタープライズ アプリケーション」の側のオブジェクト ID を控えます。
2. **「API のアクセス許可」には何も足しません。** Entra で `Mail.Read` などのアプリの権限に管理者の同意をすると、テナントの全員の箱に届き、Exchange のスコープでは絞れなくなります。
3. Exchange Online の PowerShell で、権限をスコープ付きで渡します。

```powershell
Connect-ExchangeOnline
New-ServicePrincipal -AppId <クライアント ID> -ObjectId <エンタープライズ アプリのオブジェクト ID> -DisplayName "<名前>"
Set-Mailbox shared@example.com -CustomAttribute15 "gateway-app"   # 読ませる箱ごとに
New-ManagementScope -Name "<スコープ名>" -RecipientRestrictionFilter "CustomAttribute15 -eq 'gateway-app'"
New-ManagementRoleAssignment -App <クライアント ID> -Role "Application Mail.Read" -CustomResourceScope "<スコープ名>"
Test-ServicePrincipalAuthorization -Identity <クライアント ID> -Resource shared@example.com   # InScope が True になる
```

反映には時間がかかることがあります。読ませる箱を増やすときは、その箱に同じ印を付けるだけです。詳しくは [Role Based Access Control for Applications in Exchange Online](https://learn.microsoft.com/Exchange/permissions-exo/application-rbac)。

```jsonc
"graph-app": {
  "display_name": "Microsoft Graph(アプリ)",
  "provider": "Microsoft",
  "base_url": "https://graph.microsoft.com",
  "auth": {
    "type": "client_credentials",
    "client": "murmur-app",
    "token_url": "https://login.microsoftonline.com/<テナント ID>/oauth2/v2.0/token",
    "scope": "https://graph.microsoft.com/.default"
  }
}
```

```jsonc
// 呼び出す側(Murmur)の wrangler の設定
"services": [{ "binding": "GATEWAY", "service": "<ゲートウェイの Worker 名>", "entrypoint": "Background" }]
// コード: await env.GATEWAY.fetch("https://gateway/graph-app/v1.0/users/shared@example.com/mailFolders/inbox/messages/delta")
```

#### freee(`freee`)

freee のアプリ管理でアプリを作成し、コールバック URL を設定します。シークレットは `OAUTH_FREEE_CLIENT_ID` / `OAUTH_FREEE_CLIENT_SECRET` です。

#### Microsoft Graph(`graph`)

サインイン用とは別の Entra アプリを登録します。プラットフォームは「Web」で、`src/catalog.ts` の `GRAPH_SCOPE` にある委任のアクセス許可を付けて、管理者の同意を与えます。`GRAPH_SCOPE` に許可が増えたとき(例: Murmur の Teams のための `ChannelMember.Read.All`)は、Entra のアプリにも足して管理者の同意をやり直し、利用者は「つないだサービス」で Microsoft Graph をつなぎ直します。デプロイの設定の `MICROSOFT_TENANT_ID` にテナント ID を書きます。シークレットは `OAUTH_MICROSOFT_CLIENT_ID` / `OAUTH_MICROSOFT_CLIENT_SECRET` です。

#### Google(`gmail`・`drive`・`calendar`・`docs`・`tasks`・`analytics`・`analytics-admin`)

Google Cloud のプロジェクトで、Gmail API、Google Drive API、Google Calendar API、Google Docs API、Google Tasks API、Google Analytics Data API、Google Analytics Admin API のうち使うものを有効にし、OAuth クライアントを「ウェブ アプリケーション」として作成します。OAuth 同意画面のユーザーの種類は、Workspace の「内部」にします(別の組織のアカウントはつなげなくなります。別の組織はその組織のゲートウェイで)。承認済みのリダイレクト URI に `https://<ゲートウェイ>/connect/callback` を登録し、OAuth 同意画面に `src/catalog.ts` のスコープを追加します。7 つのサービスで 1 つの OAuth クライアントを共有します。

```sh
npm run secret -- <名前> put OAUTH_GOOGLE_CLIENT_ID
npm run secret -- <名前> put OAUTH_GOOGLE_CLIENT_SECRET
```

- スコープ: Gmail の `gmail.modify` はメールの読み書きと送信、Drive の `drive` は既存のファイルを含む全ファイルの閲覧と管理、Calendar の 3 つは予定の読み書き、カレンダー一覧の参照、空き時間の参照、Docs の `documents` はドキュメントの本文の読み書き、Tasks の `tasks` はタスクのリストとタスクの読み書き(トピック索引がタスクを読み取ります)、Analytics の `analytics.readonly` は GA4 のレポートとプロパティの読み取りに使います(Data API と Admin API はホストが別なので、サービスも 2 つに分けています)。読み取り専用にするなら、`SERVICES` に同じ名前でサービスを書いて、スコープを `gmail.readonly` / `drive.readonly` / `documents.readonly` などに変えます。詳細は [Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[Calendar](https://developers.google.com/workspace/calendar/api/auth)、[Docs](https://developers.google.com/workspace/docs/api/auth) の公式ドキュメントにあります。
- `authorize_params` の `access_type: offline` と `prompt: consent` は、リフレッシュトークンを受け取るための設定です。
- REST の呼び出し先の例: `/api/gmail/gmail/v1/users/me/messages`、`/api/drive/drive/v3/files`(アップロードは `/api/drive/upload/drive/v3/files`)、`/api/calendar/calendar/v3/calendars/primary/events`、`/api/docs/v1/documents/{id}`、`/api/tasks/tasks/v1/users/@me/lists`、`/api/analytics/v1beta/properties/{id}:runReport`、`/api/analytics-admin/v1beta/accountSummaries`

#### Slack(`slack`)

[api.slack.com/apps](https://api.slack.com/apps) でアプリを作成し(配布しないなら、使うワークスペースにだけ)、OAuth & Permissions で次を設定します。

- Redirect URLs に `https://<ゲートウェイ>/connect/callback` を追加します。
- **User Token Scopes** に、`src/catalog.ts` の `SLACK_USER_SCOPE` を追加します(Bot Token Scopes は要りません)。ゲートウェイはユーザートークン(`xoxp-`)を受け取り、API はつないだ本人として動きます。

シークレットは `OAUTH_SLACK_CLIENT_ID` / `OAUTH_SLACK_CLIENT_SECRET`(Basic Information の Client ID と Client Secret)です。ワークスペースの設定でアプリの承認が要る場合は、管理者に承認してもらいます。Token Rotation は有効にしてもしなくても動きます(有効にすると、12 時間で切れるトークンをゲートウェイが更新します)。

- REST の呼び出し先の例: `/api/slack/conversations.history?channel=C0123`、`/api/slack/chat.postMessage`

#### Jira(`jira`)

[developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) で OAuth 2.0 integration のアプリを作成し、次を設定します。

- Permissions で Jira API を追加し、`src/catalog.ts` の `JIRA_SCOPE` にあるスコープ(`read:jira-work`・`write:jira-work`・`read:jira-user`・`manage:jira-webhook`)を付けます。User identity API も追加して `read:me` を付けます。
- Authorization の Callback URL に `https://<ゲートウェイ>/connect/callback` を設定します。
- 社外に配布しないなら、Distribution は「Not sharing」のままで構いません(アプリの所有者のサイトにつなげます)。

シークレットは `OAUTH_ATLASSIAN_CLIENT_ID` / `OAUTH_ATLASSIAN_CLIENT_SECRET`(Settings の Client ID と Secret)です。リフレッシュトークンは使うたびに替わり、90 日使わないと切れます(切れたら Web 画面でつなぎ直します)。

- 上流は `https://api.atlassian.com` です。Jira の API はサイトごとに `/ex/jira/<cloudid>/rest/api/3/...` の下にあり、クラウド ID は `/oauth/token/accessible-resources` で調べます。
- REST の呼び出し先の例: `/api/jira/oauth/token/accessible-resources`、`/api/jira/ex/jira/<cloudid>/rest/api/3/search/jql`

#### Confluence(`confluence`)

Jira と同じ Atlassian のアプリ(`OAUTH_ATLASSIAN_CLIENT_ID` / `OAUTH_ATLASSIAN_CLIENT_SECRET`)を使います。Confluence だけを使う場合も、上の Jira の手順でアプリを作ります。

- Permissions で Confluence API を追加し、**Granular scopes** に `src/catalog.ts` の `CONFLUENCE_SCOPE` にあるスコープ(`read:page:confluence`・`write:page:confluence` など)を付けます。User identity API の `read:me` も付けます。
- ユーザーは Web 画面で、Jira とは別に Confluence をつなぎます(サービスごとに、そのスコープだけで同意します)。
- 上流は `https://api.atlassian.com` です。Confluence の API はサイトごとに `/ex/confluence/<cloudid>/wiki/api/v2/...`(v2)と `/ex/confluence/<cloudid>/wiki/rest/api/...`(v1。CQL の検索など)の下にあります。
- REST の呼び出し先の例: `/api/confluence/oauth/token/accessible-resources`、`/api/confluence/ex/confluence/<cloudid>/wiki/api/v2/pages/<pageId>?body-format=storage`

#### X(`x`)

[X の開発者ポータル](https://developer.x.com/en/portal/dashboard) で、プロジェクトの中にアプリを作り、User authentication settings で次を設定します。

- App permissions は「Read and write」、Type of App は「Web App, Automated App or Bot」(confidential client)にします。
- Callback URI に `https://<ゲートウェイ>/connect/callback` を、Website URL にゲートウェイの URL を入れます。

クライアントは `x`(管理画面の「OAuth のクライアント」、またはシークレット `OAUTH_X_CLIENT_ID` / `OAUTH_X_CLIENT_SECRET`)で、Keys and tokens の「OAuth 2.0 Client ID and Client Secret」を入れます(API Key や Bearer Token ではありません)。開発者アカウントの利用料は、このアプリにまとめてかかります。

X は OAuth 1.0a のユーザー認証を 2027 年 1 月 31 日で終えるので、ゲートウェイは OAuth 2.0 だけを扱います。

- X はトークンの要求で、クライアント ID とシークレットを `Authorization: Basic` で受け取ります。組み込みの定義には `"client_auth": "basic"` が入っています(ほかの OAuth のサービスも、`SERVICES` か管理画面で同じ指定ができます)。
- スコープは `src/catalog.ts` の `X_SCOPE` です(ポストの読み書き、いいね・ブックマーク・リストの読み書き、フォローの読み取り、画像のアップロード、リフレッシュトークンのための `offline.access`)。DM などを足すときは、デプロイの設定の `SERVICES` に同じ名前 `x` で定義を書いて上書きし、利用者はつなぎ直します。
- アクセストークンは 2 時間で切れ、ゲートウェイが更新します。リフレッシュトークンは使うたびに替わります。
- API は従量課金かプランの上限つきです。使える量と料金は、開発者ポータルで確かめてください。
- REST の呼び出し先の例: `/api/x/2/users/me`、`/api/x/2/tweets/search/recent?query=...`、`/api/x/2/tweets`(投稿)

#### board(`board`)

board の API 設定で API キーと API トークンを発行し、ユーザーが Web 画面で登録します。ゲートウェイは API キーを `x-api-key` ヘッダー、トークンを `Authorization: Bearer` で送ります。トークンごとに使えるエンドポイントが決まっているので、使う API の権限を付けて発行します。

#### gBizINFO(`gbizinfo`)

gBizINFO の Web API 利用申請で API トークンを取得し、ユーザーが Web 画面で登録します。ゲートウェイは `X-hojinInfo-api-token` ヘッダーで送ります。

#### Serper(`serper`)

[serper.dev](https://serper.dev) のダッシュボードで API キーを発行し、ユーザーが Web 画面で登録します。ゲートウェイは `X-API-KEY` ヘッダーで送ります。ページの本文取得(`scrape.serper.dev`)はホストが別なので、このサービスでは扱いません。

## 注意

- スクリプトから直接 HTTP を送るときは、`User-Agent` を明示してください。Python の `urllib` の既定値などは、Cloudflare に Error 1010 で拒否されることがあります(付属のスクリプトは設定済み)。
- 調べるときは `npm run tail -- <名前> --format json` でログを流します。ゲートウェイは、中継したリクエストごとに、ユーザー・サービス・パス・ステータスの監査ログを出します。

## 開発

```sh
npm install
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev       # wrangler.example.jsonc で動かす
npm run typecheck
npm test          # Worker のテストと、スキルのスクリプトのテスト
```

Murmur は `murmur/` の中で別のパッケージになっています。ルートの `npm install` が `murmur/` の依存も入れます(Worker が Murmur を一緒にバンドルするため)。Murmur のテストは `cd murmur && npm test`(詳しくは [murmur/CLAUDE.md](murmur/CLAUDE.md))。

## License

[MIT](LICENSE).
