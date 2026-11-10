---
name: deploy
description: heddleway を自分の Cloudflare アカウントにセルフホストする手順。IdP(Entra ID / Google)へのアプリ登録、デプロイごとの設定ファイル(deployments/<名前>.jsonc。別の private リポジトリで管理して deployments/ に clone する)の作成と管理、KV とシークレットの登録、wrangler deploy、Claude へのコネクタ追加、プラグインの導入までを、ユーザーと対話しながら進める。設定を変えたあとの再デプロイ、1 つの clone での複数デプロイの管理、新しい版で増えた Durable Object などを各デプロイの設定に反映することも扱う。「ゲートウェイをデプロイしたい」「セルフホストしたい」「初期設定をして」「設定を変えたので出し直して」「デプロイ先をもう 1 つ増やしたい」「新しい版に上げて」などの依頼で使う。サービスを足すだけなら add-service スキル。
---

# ゲートウェイをデプロイする

ゲートウェイは Cloudflare Workers で動く。デプロイ先ごとに、IdP のアプリ、設定ファイル `deployments/<名前>.jsonc`、KV、シークレットを 1 組ずつ持つ。1 つの clone で複数のデプロイを扱える。手順の正本は README の「デプロイ」の節なので、まず読んでから進める。

wrangler は直接呼ばず、名前を付けてラッパーから呼ぶ。中で `--config deployments/<名前>.jsonc` を渡している(`tools/wrangler.mjs`)。リポジトリの直下に `wrangler.jsonc` は置かない。

| やること | コマンド |
| --- | --- |
| デプロイ | `npm run deploy -- <名前>`(`--dry-run --outdir <一時ディレクトリ>` も付けられる) |
| シークレット | `npm run secret -- <名前> put <KEY>`(`list`、`delete <KEY>` も) |
| ログ | `npm run tail -- <名前> --format json` |
| ほかの wrangler のコマンド | `node tools/wrangler.mjs <コマンド> <名前> ...` |

## 進め方

1. 現状を確かめる。
   - `deployments/` にどんな設定があるか。頼まれたデプロイの設定があれば、初回ではなく更新なので、手順 5 に進む。どれのことか分からなければ、ユーザーに聞く。
   - `deployments/` が設定のリポジトリの clone か(`git -C deployments rev-parse --show-toplevel` が `deployments` を指すか)。このリポジトリの git は `deployments/` を見ない。設定は private リポジトリで管理し、`deployments/` に clone するのがおすすめ(README の「設定をリポジトリで管理する」)。
     - `deployments/` がない、または空なら、設定のリポジトリがあるかユーザーに聞き、あれば `git clone <設定のリポジトリ> deployments` する。
     - `deployments/` にファイルはあるがリポジトリになっていなければ、リポジトリで管理するよう勧める。ユーザーが private リポジトリを作ったら、`git -C deployments init`、リモートの追加、最初のコミットとプッシュを手伝う(プッシュはユーザーの確認を取ってから)。
     - 設定のリポジトリにまだプッシュしていない変更やコミットしていない変更があれば(`git -C deployments status`)、デプロイの前にユーザーに知らせる。
   - リポジトリの直下に古い形の `wrangler.jsonc` があれば、`deployments/<名前>.jsonc` へ移す(`$schema` と `main` のパスの先頭に `../` を付ける)。名前はユーザーに決めてもらう。
   - `npx wrangler whoami` で Cloudflare にログインしているか。していなければ、ユーザーに `npx wrangler login` を実行してもらう(ブラウザが要る。GUI のないマシンでは、SSH のポート転送で 8976 を通す)。
2. ユーザーに決めてもらう。推測で埋めない。
   - デプロイの名前(`deployments/<名前>.jsonc` のファイル名。英小文字・数字・ハイフン)と、Worker の名前(`name`。同じ Cloudflare アカウントの中で、ほかのデプロイと違うもの)。
   - Cloudflare のアカウント(`account_id`)。**必ず書く**。ログインやトークンから複数のアカウントが見えると、wrangler はどれに出すかを聞いてきて、クラウドのセッションではそこで止まる。組織ごとにアカウントを分けているなら、その組織のアカウントにする。見えるアカウントは `npx wrangler whoami` で確かめる。
   - 組織名(`ORGANIZATION_NAME`)。1 つのデプロイ = 1 つの組織(`docs/adr/0004`)。Claude のコネクタの説明と Web 画面に出て、複数の組織のゲートウェイを並べてつないだときの見分けに使う。ユーザーがすでに別の組織のデプロイを持っていて、同じ組織のつもりなら、デプロイを分けずにそちらにサービスを足す。
   - 公開 URL(`PUBLIC_URL`)。workers.dev なら `https://heddleway.<サブドメイン>.workers.dev`。独自ドメインなら、その設定もする。
   - IdP: Microsoft 365 の組織なら Entra ID、Google Workspace なら Google。
   - 最初に使うサービス。組み込み(`src/catalog.ts`)のうち OAuth のもの(freee、Google、Microsoft Graph)は、クライアントを登録したものだけが使えるようになるので、どれを使うかを決める。組み込みにないサービスは、デプロイのあとで add-service スキルで足す。
3. IdP にアプリを登録してもらう。Claude が IdP の管理画面を操作することはできないので、README の手順を示して、ユーザーにやってもらう。
   - リダイレクト URI: `<PUBLIC_URL>/oauth/callback` と `<PUBLIC_URL>/login/callback`
   - 受け取るもの: クライアント ID と、Entra ならテナント ID。クライアントシークレットは会話に貼らせず、手順 4 で直接 `wrangler secret put` に入れてもらう。
4. 設定とシークレット。
   - 設定を `wrangler.example.jsonc` から作る。`$schema` と `main` のパスの先頭に `../` を付ける(README の `sed` のとおり)。そのうえで、`name`、`PUBLIC_URL`、`ORGANIZATION_NAME`、`IDP_TYPE`、`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`ALLOWED_TENANTS` / `ALLOWED_DOMAINS` を書く。Microsoft Graph を使うなら `MICROSOFT_TENANT_ID`。`SERVICES` は組み込みにないサービスがあるときだけ。Google では `ALLOWED_DOMAINS` を必ず指定する(空だと誰でもサインインできてしまう)。
   - `npx wrangler kv namespace create OAUTH_KV` の結果の ID を `kv_namespaces` に書く。
   - シークレット: `OIDC_CLIENT_SECRET` はユーザーに対話で入れてもらう(`npm run secret -- <名前> put OIDC_CLIENT_SECRET`)。`SIGNING_KEY` と `ENCRYPTION_KEY` は `openssl rand -base64 32 | npm run secret -- <名前> put <KEY>` で作る。値を表示したり、ファイルに残したりしない。
   - OAuth の連携先は、クライアントごとに ID とシークレットが要る: `freee`、`google`(Google の 6 サービスで共通)、`microsoft`(Graph)、`slack`、`atlassian`(Jira・Confluence)、`x`。デプロイのあとに、管理者が Web 画面の「接続先の管理」→「OAuth のクライアント」で入れるのがおすすめ(デプロイし直さずに済む。`ADMINS` に管理者のユーザー ID が要る)。シークレット `OAUTH_<CLIENT>_CLIENT_ID` / `_CLIENT_SECRET` で入れてもよく、そちらが優先される。README の「連携先を設定する」に従う。
5. デプロイする。
   - 先に `npm ci`、`npm run typecheck`、`npm test` を通す。
   - 設定の共通部分が、ひな形と合っているかを確かめる(下の「新しい版に上げるとき」)。
   - `npm run deploy -- <名前> --dry-run --outdir <一時ディレクトリ>` で、ビルドと設定の読み込みを先に確かめる(アップロードはしない)。
   - `npm run deploy -- <名前>`。デプロイは外に出る操作なので、実行前にユーザーに確認する。エージェントの権限設定で止められたら、ユーザー自身に実行してもらう(Claude Code なら `! npm run deploy -- <名前>`)。
   - 失敗したら、エラーをそのまま見せる。`SERVICES` の検証エラー(`invalid service name`、`must be https`、`unsupported auth`)は `src/config.ts` の `parseServices` が出している。
6. 動作を確かめる。
   - `<PUBLIC_URL>/` をユーザーに開いてもらい、サインインと認証情報の登録ができるか見てもらう。
   - コネクタとプラグインの入れ方は、Web 画面の「Claude につなぐ」(`<PUBLIC_URL>/setup`)にまとまっている。利用者にはそこを案内する。業務向けのプラグイン(別のリポジトリのもの)を配るなら、管理者が「プラグインの配布」(`<PUBLIC_URL>/admin/plugins`)に zip を追加する。
   - Claude にコネクタ `<PUBLIC_URL>/mcp` を追加してもらう(Pro / Max は個人の設定、Team / Enterprise は Owner が組織の設定)。コネクタの名前は組織が分かるものにする(ほかの組織のゲートウェイと並べてつなぐことがあるので)。組織が契約している Claude には、その組織のゲートウェイだけをつなぐよう勧める(README の「複数の組織で使う」)。
   - プラグイン `heddleway` を入れてもらう(README の「スキル(プラグイン)」)。Team / Enterprise では、コード実行のネットワーク設定でゲートウェイのドメインを許可する必要がある。
   - 調べるときは `npm run tail -- <名前> --format json` をバックグラウンドで流して、ユーザーに操作を再現してもらう。

## 新しい版に上げるとき

設定は合成せず、各デプロイのファイルに全部書いてある。ひな形 `wrangler.example.jsonc` の共通部分が変わったら、`deployments/` の全ファイルに同じ変更を入れる。

- 照らし合わせるもの: `compatibility_date`、`compatibility_flags`、`observability`、`triggers`、`durable_objects`、`migrations`、`vars` のキー(値はデプロイごとに違うので、増えたキーだけ足す。既定値はひな形のもの)。
- ひな形にないキーが残っていたら消す(例: 以前の版の `assets`。プラグインの zip は Worker 本体に同梱するようになった)。
- `migrations` は、ひな形にある tag をすべて、同じ順で持っていること。足りない tag を末尾に足す。既にある tag を書き換えたり消したりしない(Durable Object のデータを失う)。
- 直したら、デプロイごとに `--dry-run` を通し、ユーザーにデプロイしてもらう。
- 設定のリポジトリにコミットしてプッシュする(下の「設定の変更を残す」)。

## 設定の変更を残す

`deployments/` の設定を作った・直したら(初回のデプロイ、設定の変更、版を上げたときの共通部分の反映、add-service での `SERVICES` の追加)、`deployments/` が設定のリポジトリなら、そこにコミットしてプッシュする。

- コミットは `git -C deployments ...` で、設定のリポジトリに対して行う。ゲートウェイのリポジトリには何も入れない。
- 何を変えたかをメッセージに書く(例: `acme: ORGANIZATION_NAME を足す`)。
- プッシュは外に出る操作なので、ユーザーに確認してから。ユーザーが自分でやると言ったら、変更の要約とコマンドを示すだけにする。
- シークレットの値をファイルに書かない。差分にシークレットらしい値(`OIDC_CLIENT_SECRET` などの値)が入っていたら、コミットせずに止める。

## 注意

- `ENCRYPTION_KEY` を作り直すと、登録済みの認証情報はすべて復号できなくなる。更新のデプロイでは触らない。
- `SIGNING_KEY` を作り直すと、発行済みのトークンと MCP の接続が切れる。ユーザーは接続し直しになる。
- `deployments/` には KV の ID やテナント ID が入る。ゲートウェイのリポジトリには入れない(`.gitignore` 済み)。管理するなら、別の private リポジトリで。

