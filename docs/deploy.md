# デプロイ

## 1. IdP にアプリを登録する

ゲートウェイへのサインインに使うアプリを登録し、リダイレクト URI を 2 つ設定します。

- `https://<ゲートウェイ>/oauth/callback`(MCP クライアントの接続)
- `https://<ゲートウェイ>/login/callback`(Web 画面のサインイン)

アプリは、その組織の中だけで使える形で登録します(1 つのデプロイ = 1 つの組織)。Entra ID はシングルテナントのアプリとして登録し、`OIDC_ISSUER` を `https://login.microsoftonline.com/<tenant-id>/v2.0` にします。Google は、Workspace のドメインを `ALLOWED_DOMAINS` に必ず指定します(空だと、どの Google アカウントでもサインインできてしまいます)。

## 2. 設定してデプロイする

デプロイ先ごとに、設定を `deployments/<名前>.jsonc` に置きます。名前は自由に付けてよく、1 つの clone で複数のデプロイを扱えます。`deployments/` はこのリポジトリの git の管理外です。設定は、デプロイする人の private リポジトリで管理し、`deployments/` に clone して使うのがおすすめです(下の「設定をリポジトリで管理する」)。`wrangler.example.jsonc` をコピーし、`$schema` と `main` のパスの先頭に `../` を付けます。Worker の `name` はデプロイごとに変え(すでに動いているデプロイの `name` は変えません。Durable Object の保管庫が Worker の名前に結びついているので、変えると登録済みの認証情報が見えなくなります。[docs/adr/0006](adr/0006-name-heddleway.md))、別の Cloudflare アカウントなら `account_id` も書きます。`vars` に `PUBLIC_URL`、組織名(`ORGANIZATION_NAME`)、IdP の設定を書きます。Microsoft Graph を使うなら `MICROSOFT_TENANT_ID` も書きます。組み込みにないサービスは `SERVICES` に足します。KV ネームスペースを作って、ID を `kv_namespaces` に設定します。

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
- 設定を変えたら、`npm run deploy -- <名前>` で出し直します。設定をリポジトリで管理しているなら、コミットしてプッシュもします。
- 新しい版で Durable Object やその migration が増えたときは(`wrangler.example.jsonc` の `durable_objects` と `migrations`)、各デプロイの設定にも同じものを足してから出し直します。deploy スキルが照らし合わせて直します。トンネル([ADR 0003](adr/0003-reverse-connection.md))の Durable Object `TUNNEL`(`TunnelConnection`、migration `v3` と、名前を変える `v4`)も、そうして足します。足していないデプロイでは、トンネルは使えません(ほかは今までどおり動きます)。

### 設定をリポジトリで管理する

`deployments/` は、このリポジトリの git が見ないディレクトリです。そこに、設定だけを入れた別の private リポジトリを clone します(サブモジュールにはしません)。

```sh
git clone git@github.com:<組織>/heddleway-deployments.git deployments
```

- 設定ファイルの `main` などの相対パス(`../src/index.ts`)は、`deployments/` の中にあるので、そのまま動きます。`tools/wrangler.mjs` も変わりません。
- 入れるのは `<名前>.jsonc` だけです。Worker の名前、`account_id`、`PUBLIC_URL`、`ORGANIZATION_NAME`、IdP の設定、KV の ID、`SERVICES` が入ります。秘密の値ではありませんが、テナント ID なども入るので、リポジトリは private にします。
- シークレット(`OIDC_CLIENT_SECRET`、`SIGNING_KEY`、`ENCRYPTION_KEY`、`OAUTH_*`)は入れません。`npm run secret` で Cloudflare に入れるだけで、ファイルには残しません。
- 別のマシンや新しい clone でデプロイするときは、ゲートウェイを clone したあと、同じように設定のリポジトリを `deployments/` に clone します。

## 3. 連携先を設定する

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

- **管理画面**(おすすめ): 「接続先の管理」の「OAuth のクライアント」で、クライアントごとに入れます。デプロイし直す必要はなく、保存すると利用者の画面に出ます(反映まで最大 30 秒)。シークレットは `ENCRYPTION_KEY` で暗号化して保存します。管理画面を使うには、デプロイの設定の `ADMINS` に自分を入れておきます(「管理画面から接続先を足す」)。
- **デプロイのシークレット**: クライアントの名前を大文字にした名前で登録します(ハイフンは `_` に)。こちらが登録されていれば、管理画面の値より優先されます。

```sh
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_ID
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_SECRET
```

以下の連携先ごとの説明にある `OAUTH_..._CLIENT_ID` / `_CLIENT_SECRET` も、管理画面の同じ名前のクライアントで代わりに入れられます。

クライアントが登録されていない OAuth のサービスは、Web 画面にも `list_credentials` にも出ません。

アクセストークンは、期限の 1 分前からゲートウェイがリフレッシュします。リフレッシュトークンが失効したら、Web 画面に「再接続」が出ます。

## 管理画面から接続先を足す

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

### 人がいないときに Worker が使う接続先(`client_credentials`)

Murmur のように、夜中の通知や定期の見回りでユーザーがいないときにも上流を呼ぶ Worker のために、OAuth 2.0 の client credentials でゲートウェイ自身がトークンを取る接続先を置けます(設計は [docs/background-access.md](background-access.md))。持ち主はユーザーではなくデプロイで、Web 画面にも `list_credentials` にも出ず、REST(`/api/`)からも使えません。

> トピック索引(Murmur)の共有メールボックスは、この接続先を使いません。メンバーの委任(`Mail.Read.Shared`)で見回りで読みます(Murmur の [0042](../murmur/docs/adr/0042-shared-mailbox-by-polling.md))。デプロイの設定 `MURMUR_SHARED_SERVICES` に `shared-mailbox` を足し、Entra のアプリの API のアクセス許可(委任)に `Mail.Read.Shared`(か `Mail.ReadWrite.Shared`)を足して組織で同意すると使えます。ゲートウェイの要求するスコープには足さないでください(リフレッシュで未同意のスコープを求めて、接続が切れることがあります)。

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

### freee(`freee`)

freee のアプリ管理でアプリを作成し、コールバック URL を設定します。シークレットは `OAUTH_FREEE_CLIENT_ID` / `OAUTH_FREEE_CLIENT_SECRET` です。

### Microsoft Graph(`graph`)

サインイン用とは別の Entra アプリを登録します。プラットフォームは「Web」で、`src/catalog.ts` の `GRAPH_SCOPE` にある委任のアクセス許可を付けて、管理者の同意を与えます。`GRAPH_SCOPE` に許可が増えたとき(例: Murmur の Teams のための `ChannelMember.Read.All`)は、Entra のアプリにも足して管理者の同意をやり直し、利用者は「つないだサービス」で Microsoft Graph をつなぎ直します。デプロイの設定の `MICROSOFT_TENANT_ID` にテナント ID を書きます。シークレットは `OAUTH_MICROSOFT_CLIENT_ID` / `OAUTH_MICROSOFT_CLIENT_SECRET` です。

### Google(`gmail`・`drive`・`calendar`・`docs`・`tasks`・`chat`・`analytics`・`analytics-admin`)

Google Cloud のプロジェクトで、Gmail API、Google Drive API、Google Calendar API、Google Docs API、Google Tasks API、Google Chat API、Google Analytics Data API、Google Analytics Admin API のうち使うものを有効にし、OAuth クライアントを「ウェブ アプリケーション」として作成します。OAuth 同意画面のユーザーの種類は、Workspace の「内部」にします(別の組織のアカウントはつなげなくなります。別の組織はその組織のゲートウェイで)。承認済みのリダイレクト URI に `https://<ゲートウェイ>/connect/callback` を登録し、OAuth 同意画面に `src/catalog.ts` のスコープを追加します。8 つのサービスで 1 つの OAuth クライアントを共有します。

```sh
npm run secret -- <名前> put OAUTH_GOOGLE_CLIENT_ID
npm run secret -- <名前> put OAUTH_GOOGLE_CLIENT_SECRET
```

- スコープ: Gmail の `gmail.modify` はメールの読み書きと送信、Drive の `drive` は既存のファイルを含む全ファイルの閲覧と管理、Calendar の 3 つは予定の読み書き、カレンダー一覧の参照、空き時間の参照、Docs の `documents` はドキュメントの本文の読み書き、Tasks の `tasks` はタスクのリストとタスクの読み書き(トピック索引がタスクを読み取ります)、`userinfo.email` はつないだアカウントのメールアドレスの参照(トピック索引がタスクの持ち主を知るために使います。Tasks のサービスは Calendar や Drive と同じ `www.googleapis.com` を向き、Tasks の API は `/tasks/v1/` の下にあります)、Chat の 4 つはスペース・メンバー・メッセージの読み取りとメッセージの投稿(トピック索引がスペースとチャットを読み取り、エージェントが投稿します)、Analytics の `analytics.readonly` は GA4 のレポートとプロパティの読み取りに使います(Data API と Admin API はホストが別なので、サービスも 2 つに分けています)。読み取り専用にするなら、`SERVICES` に同じ名前でサービスを書いて、スコープを `gmail.readonly` / `drive.readonly` / `documents.readonly` などに変えます。詳細は [Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[Calendar](https://developers.google.com/workspace/calendar/api/auth)、[Docs](https://developers.google.com/workspace/docs/api/auth) の公式ドキュメントにあります。
- `authorize_params` の `access_type: offline` と `prompt: consent` は、リフレッシュトークンを受け取るための設定です。
- トピック索引で Gmail と Google Tasks を使うなら、Gmail API と Google Tasks API を有効にし、`tasks` のサービスの OAuth の同意のスコープ(`tasks` と `userinfo.email`)を足します。Google は変更の通知を使わず、5 分ごとの見回りで取り込むので、Outlook より最大 5 分ほど遅れます。Google Tasks の見回りの間隔は設定の `MURMUR_TASKS_POLL_MINUTES`(分。省くと毎回)で延ばせ、サービス名を変えているときは `MURMUR_GMAIL_SERVICE`・`MURMUR_TASKS_SERVICE` で指定します(`wrangler.example.jsonc` の末尾)。使う人は、ゲートウェイで Gmail と Google Tasks をつないでから、エージェントにトピック索引へのつなぎを頼みます
- トピック索引で Google Chat を使うなら、上の Chat アプリの構成を作ります。本人の DM・グループのチャット(個人リスト)はそれだけで使え、スペースを共有リストにするには、デプロイの設定 `MURMUR_SHARED_SERVICES` に `google-chat` を足します(Murmur の [0045](../murmur/docs/adr/0045-google-chat-spaces-and-chats.md))。どちらも 5 分ごとの見回りで取り込みます。Google でサインインするゲートウェイだけで使えます(スペースのメンバーを、Google のアカウントの ID でゲートウェイのユーザーに対応させるため)。サービス名を変えているときは `MURMUR_CHAT_SERVICE` で指定します。使う人は、ゲートウェイで Google Chat をつないでから、エージェントにトピック索引へのつなぎを頼みます
- トピック索引で LINE 公式アカウントを使うなら、公式アカウントの Webhook を受けて保存する業務システム(ビルメンNEXT)をゲートウェイのサービス(既定の名前 `bm-next`。変えているときは `MURMUR_BM_NEXT_SERVICE`)として登録し、デプロイの設定 `MURMUR_SHARED_SERVICES` に `line` を足します(Murmur の [0049](../murmur/docs/adr/0049-line-official-account-via-front-system.md))。取り込みは 5 分ごとの見回りです。使う人は、業務システムで LINE のメッセージを読めるロールの API キーをゲートウェイに登録してから、エージェントにトピック索引へのつなぎを頼みます
- **Google Chat を使うなら、Google Chat API を有効にしたうえで、Chat アプリの構成を作ります。** Google Cloud のコンソールで「Google Chat API」の「構成」を開き、アプリの名前・アバターの URL・説明を入れて保存します(インタラクティブ機能は無効のままでかまいません)。Chat API は、ユーザーの認証で呼ぶときもこの構成を求め、ないと 404 などで断ります。構成はプロジェクトに 1 つで、ゲートウェイの OAuth クライアントと同じプロジェクトに作ります。詳細は [Chat API の認証](https://developers.google.com/workspace/chat/authenticate-authorize-chat-user)と [Chat アプリの構成](https://developers.google.com/workspace/chat/configure-chat-api)にあります
- REST の呼び出し先の例: `/api/gmail/gmail/v1/users/me/messages`、`/api/drive/drive/v3/files`(アップロードは `/api/drive/upload/drive/v3/files`)、`/api/calendar/calendar/v3/calendars/primary/events`、`/api/docs/v1/documents/{id}`、`/api/tasks/tasks/v1/users/@me/lists`、`/api/chat/v1/spaces`、`/api/analytics/v1beta/properties/{id}:runReport`、`/api/analytics-admin/v1beta/accountSummaries`

### Slack(`slack`)

[api.slack.com/apps](https://api.slack.com/apps) でアプリを作成し(配布しないなら、使うワークスペースにだけ)、OAuth & Permissions で次を設定します。

- Redirect URLs に `https://<ゲートウェイ>/connect/callback` を追加します。
- **User Token Scopes** に、`src/catalog.ts` の `SLACK_USER_SCOPE` を追加します(Bot Token Scopes は要りません)。ゲートウェイはユーザートークン(`xoxp-`)を受け取り、API はつないだ本人として動きます。

シークレットは `OAUTH_SLACK_CLIENT_ID` / `OAUTH_SLACK_CLIENT_SECRET`(Basic Information の Client ID と Client Secret)です。ワークスペースの設定でアプリの承認が要る場合は、管理者に承認してもらいます。Token Rotation は有効にしてもしなくても動きます(有効にすると、12 時間で切れるトークンをゲートウェイが更新します)。

- REST の呼び出し先の例: `/api/slack/conversations.history?channel=C0123`、`/api/slack/chat.postMessage`

### Jira(`jira`)

[developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) で OAuth 2.0 integration のアプリを作成し、次を設定します。

- Permissions で Jira API を追加し、`src/catalog.ts` の `JIRA_SCOPE` にあるスコープ(`read:jira-work`・`write:jira-work`・`read:jira-user`・`manage:jira-webhook`)を付けます。User identity API も追加して `read:me` を付けます。
- Authorization の Callback URL に `https://<ゲートウェイ>/connect/callback` を設定します。
- 社外に配布しないなら、Distribution は「Not sharing」のままで構いません(アプリの所有者のサイトにつなげます)。

シークレットは `OAUTH_ATLASSIAN_CLIENT_ID` / `OAUTH_ATLASSIAN_CLIENT_SECRET`(Settings の Client ID と Secret)です。リフレッシュトークンは使うたびに替わり、90 日使わないと切れます(切れたら Web 画面でつなぎ直します)。

- 上流は `https://api.atlassian.com` です。Jira の API はサイトごとに `/ex/jira/<cloudid>/rest/api/3/...` の下にあり、クラウド ID は `/oauth/token/accessible-resources` で調べます。
- REST の呼び出し先の例: `/api/jira/oauth/token/accessible-resources`、`/api/jira/ex/jira/<cloudid>/rest/api/3/search/jql`

### Confluence(`confluence`)

Jira と同じ Atlassian のアプリ(`OAUTH_ATLASSIAN_CLIENT_ID` / `OAUTH_ATLASSIAN_CLIENT_SECRET`)を使います。Confluence だけを使う場合も、上の Jira の手順でアプリを作ります。

- Permissions で Confluence API を追加し、**Granular scopes** に `src/catalog.ts` の `CONFLUENCE_SCOPE` にあるスコープ(`read:page:confluence`・`write:page:confluence` など)を付けます。User identity API の `read:me` も付けます。
- ユーザーは Web 画面で、Jira とは別に Confluence をつなぎます(サービスごとに、そのスコープだけで同意します)。
- 上流は `https://api.atlassian.com` です。Confluence の API はサイトごとに `/ex/confluence/<cloudid>/wiki/api/v2/...`(v2)と `/ex/confluence/<cloudid>/wiki/rest/api/...`(v1。CQL の検索など)の下にあります。
- REST の呼び出し先の例: `/api/confluence/oauth/token/accessible-resources`、`/api/confluence/ex/confluence/<cloudid>/wiki/api/v2/pages/<pageId>?body-format=storage`

### X(`x`)

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

### board(`board`)

board の API 設定で API キーと API トークンを発行し、ユーザーが Web 画面で登録します。ゲートウェイは API キーを `x-api-key` ヘッダー、トークンを `Authorization: Bearer` で送ります。トークンごとに使えるエンドポイントが決まっているので、使う API の権限を付けて発行します。

### gBizINFO(`gbizinfo`)

gBizINFO の Web API 利用申請で API トークンを取得し、ユーザーが Web 画面で登録します。ゲートウェイは `X-hojinInfo-api-token` ヘッダーで送ります。

### Serper(`serper`)

[serper.dev](https://serper.dev) のダッシュボードで API キーを発行し、ユーザーが Web 画面で登録します。ゲートウェイは `X-API-KEY` ヘッダーで送ります。ページの本文取得(`scrape.serper.dev`)はホストが別なので、このサービスでは扱いません。
