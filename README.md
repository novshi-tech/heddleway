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
- **よく使うサービスは組み込みです。** freee、Microsoft Graph、Google(Gmail・Drive・Calendar・Docs・Tasks・Chat・Analytics)、Slack、Jira、Confluence、board、gBizINFO、Serper、X は `src/catalog.ts` にあり、OAuth のクライアントを登録すれば使えます。ほかのサービスは、デプロイの設定の `SERVICES` に書くか、管理画面から、ベース URL と認証方式(ヘッダーか OAuth 2.0)を書いて足します。OAuth のトークンの更新もゲートウェイが受け持ちます。
- **使い方はスキルで配ります。** API の呼び方は、Claude のスキル(プラグイン)にまとめて配布します。コネクタの URL を含めていないので、どのデプロイでも同じプラグインを使えます。

Claude の Cowork で動作を確認しています。MCP の OAuth に従っているので、ほかの Claude のクライアントや ChatGPT のコネクタにも対応する設計ですが、まだ確認していません。設計の詳細は [docs/concept.md](docs/concept.md) と [docs/auth-design.md](docs/auth-design.md) にあります。

## トピック索引(Murmur)

[`murmur/`](murmur/) は、ゲートウェイの機能の 1 つ「トピック索引」です(内部の名前は Murmur)。メール(Outlook・Gmail)・Teams(チャネルとチャット)・Google Chat(スペースとチャット)・Jira・To Do・Google Tasks などのやりとりをトピック(アクションアイテムの候補になる会話)にまとめ、担当とアテンションを追います。アテンションにはタスクと FYI が区別されずに入っていて、どちらかはエージェントが読んで決めます。利用者は意識せず、エージェント(Claude など)が裏で読んで「いまやるべきこと」に答えるための索引です([docs/adr/0005](docs/adr/0005-murmur-as-a-feature.md))。

- ゲートウェイの Worker に入っていて、デプロイの設定に Murmur の D1 を足すと有効になります(`wrangler.example.jsonc` の末尾)。足さなければ、ゲートウェイはトピック索引なしで今までどおり動きます
- 利用者ごとに、ゲートウェイの画面で有効にします(エージェントにトピック索引への接続を頼むと、有効にする画面に案内されます)。有効にした人の接続だけを、読み取りだけで使います。「つないだサービス」の画面でいつでも無効にできます
- 自分がメンバーになっているリスト(取り込みの状態、担当とアテンション・割当待ちの件数、共有リストのメンバー)と、リストの増やし方は、ホームの「参加中のリストを見る」(`/features/murmur`)で見られます。メンバーでない共有リストは出しません(Murmur の [0048](murmur/docs/adr/0048-my-lists-page.md))
- 個人のメールとタスクは、組織のデプロイにあるサービスで決まります。Microsoft 365 の組織は Outlook と To Do(`graph`)、Google Workspace の組織は Gmail と Google Tasks(`gmail`・`tasks`)と Google Chat のチャット(`chat`)です。Google の準備と設定は [docs/deploy.md](docs/deploy.md) の「Google」にあります
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

手作業で進める場合は、[docs/deploy.md](docs/deploy.md) に従ってください。

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

### アプリをつなぐ

Claude のようなエージェント(スタンド)のほかに、決まった処理をするツール(**アプリ**。カレンダーの同期、トピック索引のリストを見張ってエージェントを起動する [heddleway-dispatcher](https://github.com/novshi-tech/heddleway-dispatcher) など)をつなげます。アプリが呼べるのは、管理者が許可した API(サービス・メソッド・パスの組み合わせ)だけです([ADR 0008](docs/adr/0008-narrow-grants-for-apps.md))。

1. アプリは、OAuth のクライアントのメタデータ文書(クライアント ID の URL)に、定義 `heddleway_app` を載せて公開します。
   ```json
   {
     "client_id": "https://app.example/oauth/client.json",
     "client_name": "Dispatcher",
     "redirect_uris": ["https://app.example/oauth/callback"],
     "token_endpoint_auth_method": "none",
     "heddleway_app": {
       "name": "dispatcher",
       "description": "トピック索引のエージェント用のリストを見張り、エージェントを起動します",
       "ports": [
         { "service": "murmur", "method": "GET", "path": "^/threads$" },
         { "service": "murmur", "method": "POST", "path": "^/notes$" }
       ],
       "examples": { "allow": ["GET murmur /threads?since=2026-11-01T00:00:00Z"], "deny": ["POST murmur /sent"] }
     }
   }
   ```
   `path` はサービスのベース URL からのパス(クエリの前)に全体一致させる正規表現で、`^/` で始めて `$` で終えます。`examples` は「メソッド サービス パス」で書いた、通る呼び出しと通らない呼び出しの例です。
2. 管理者が「アプリの管理」(`/admin/apps`)にクライアント ID の URL を入れ、表示された許可する API とテストの結果を確かめて承認します。保存されるのは、承認した時点の定義です。文書を書き換えたら、もう一度読み込んで差分を確かめ、承認し直します。登録を消すと、そのアプリへの許可はすぐにすべて使えなくなります。
3. 利用者は、アプリから OAuth の認可(スコープ `app:<name>`)を受けて同意します。アプリは MCP の `list_credentials`・`issue_token`・`api_get`・`api_request` と REST の中継を、スタンドと同じように使えますが、届くのは許可した API のサービスだけで、許可にない呼び出しは上流に送る前に 403 で断られます(操作ログの `app_refused`)。

### 手元のサービスをつなぐ

自分の PC や、自分で置いたコンテナで動くサービス(boid、API のないレガシーシステムを Playwright で操作する業務コンテナなど)を、手元に入口を開けずに Claude から呼べます。サービスのほうから WebSocket でゲートウェイにつなぎに来て、ゲートウェイが中継します(逆向きの接続、[ADR 0003](docs/adr/0003-reverse-connection.md))。

1. 手元のサービスが鍵ペアを作り、ペアリングのコードを表示します(試験用のクライアントなら `node tools/reverse-client.mjs pair <ゲートウェイの URL> --name <名前> --key <鍵のファイル>`)
2. 所有者が、表示された URL(`/pair`)でコードを入れ、鍵の指紋を確かめて承認します。名前はこのとき決まります
3. 手元のサービスがつながると、所有者の `list_credentials` に `reverse:<ID>` の接続として出て、`/api/<名前>/...` で呼べます(試験用のクライアントは `node tools/reverse-client.mjs connect --key <鍵のファイル> --target http://127.0.0.1:<ポート>`)

手元のサービスから、所有者としてゲートウェイを呼び返すこともできます。初めは何も呼べず、所有者がサービスごとに選びます(Gemini のように提供元のカスタムコネクタがないハーネスでも、全部のサービスに届くトークンを手元に置かずに済みます)。鍵を持つプロセスが中継口を出し、エージェントには鍵を見せません(試験用のクライアントでは `--callback-port <ポート>` で `http://127.0.0.1:<ポート>/api/<サービス>/...` が開きます)。

呼べるのは所有者だけです。所有者はホームの「手元のサービス」で、管理者は「手元のサービスの管理」(`/admin/local-services`)で、つながっているかを見て削除できます。長い処理は、サービスの側で非同期(`202` と ID、結果は `GET`)にします。手元のサービスを作るときの約束は [docs/reverse-protocol.md](docs/reverse-protocol.md) にあります。管理者はデプロイの設定の `vars` に `"REVERSE_PAIRING": "off"` を足すとペアリングを、`"REVERSE_CALLBACK": "off"` を足すと呼び返しを止められます。

## スキル

このリポジトリは Claude のプラグインのマーケットプレイスを兼ねています。共通の `heddleway` を入れ、使う提供元のプラグインを足します。Microsoft 365 だけ、Google だけ、という使い方ができます。

| プラグイン | スキル | サービス名 | できること |
| --- | --- | --- | --- |
| `heddleway`(必須) | `heddleway` | — | トークンの発行と、REST の呼び出し(`gw_request.py`)の共通手順。ほかのスキルはこれを前提にする |
| | `board` | `board` | 販売管理 SaaS「board」の案件・見積・請求・発注・支払・顧客などの検索・登録・更新 |
| | `gbizinfo` | `gbizinfo` | 経済産業省の法人情報(gBizINFO)の検索 |
| | `serper` | `serper` | Serper 経由の Google 検索(ウェブ・画像・ニュース・地図・論文など) |
| | `x` | `x` | X(旧 Twitter)のポストの検索・取得、投稿・返信・画像の添付、いいね・リポスト・ブックマーク(ユーザー本人として) |
| | `topic-index` | `murmur` | トピック索引(このゲートウェイの機能)のトピック・担当とアテンション・To Do / Google Tasks のタスクでの追跡と経過のメモ・送信の記録。有効にする手順は上の「トピック索引(Murmur)」 |
| `heddleway-microsoft` | `microsoft-graph` | `graph` | Outlook メール、OneDrive / SharePoint、Teams、予定表 |
| `heddleway-google` | `gmail` | `gmail` | メールの検索・送信・返信・下書き、添付ファイル |
| | `google-drive` | `drive` | ファイルの検索・ダウンロード・エクスポート・アップロード、共有ドライブ |
| | `google-calendar` | `calendar` | 予定の検索・作成・更新、空き時間の確認 |
| | `google-tasks` | `tasks` | タスクのリストとタスクの一覧・作成・更新・完了・削除・移動 |
| | `google-chat` | `chat` | スペース・DM の一覧、メンバー、メッセージの検索・取得、スペースやスレッドへの投稿・返信 |
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

- ゲートウェイの Web 画面: 「Claude につなぐ」(`/setup`)に、このリポジトリのプラグインの zip が並び、サインインした人がダウンロードできます。`npm run deploy` が `tools/build-plugin-zip.py --bundle` で zip を `dist/plugins.js` に書き出し、Worker 本体に同梱してデプロイするので、いつもそのゲートウェイの版のものです。ほかのプラグイン(自社のサービスのスキルなど)は、管理者が「プラグインの配布」(`/admin/plugins`)で zip を追加すると、同じ画面に並びます([docs/deploy.md](docs/deploy.md) の「管理画面から接続先を足す」)。

スキルのスクリプトが使う共通のファイル(`gwlib.py`、`gw_request.py`、`google_paging.py`)の原本は `lib/plugin/` にあります。Claude Code はプラグインごとに別の場所にインストールし、Cowork はスキルのディレクトリを `<プラグイン>:<スキル>` と名付けるので、スキルからほかのスキルのファイルには届きません。そのため、各スキルの `scripts/` にコピーを置いています。原本を変えたら `npm run plugin:sync` でコピーを更新します(テストがずれを検出します)。

ほかのサービスのスキルは、自分のプラグインに作って足します(`add-service` スキル)。業務に寄ったサービスのスキルは、このリポジトリに入れず、別のプラグインに分けて運用するのがおすすめです。そのスキルにも `gwlib.py` と `gw_request.py` のコピーを同梱してください。

## デプロイ

手順は [docs/deploy.md](docs/deploy.md) にあります(IdP へのアプリ登録、デプロイごとの設定、シークレット、連携先ごとの OAuth のクライアントの登録、管理画面から接続先を足す方法)。Claude Code の `deploy` スキルは、この手順に沿って進めます。

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
