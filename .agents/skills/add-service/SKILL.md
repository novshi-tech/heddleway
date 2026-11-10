---
name: add-service
description: API ゲートウェイに、新しい連携先サービス(外部の REST / GraphQL API)を足す手順。API の認証方式を調べて SERVICES の定義を書き、OAuth のクライアントを登録し、デプロイして、Claude がその API を使うためのサービス別スキルを作るところまでを、ユーザーと対話しながら進める。「○○の API をゲートウェイに足したい」「○○を Claude から使えるようにしたい」「SERVICES に○○を追加して」「○○のスキルを作って」などの依頼で使う。ゲートウェイの初回のデプロイは deploy スキル。
---

# サービスを足す

freee、Microsoft Graph、Google(Gmail・Drive・Calendar・Docs・Analytics)、Slack、Jira、Confluence、board、gBizINFO、Serper、X は組み込み(`src/catalog.ts`)なので、足す必要はない。OAuth のものはクライアントのシークレットを登録すれば使える(README の「連携先を設定する」)。

それ以外のサービスを 1 つ足すには、次の 3 つをそろえる。

1. ゲートウェイの設定: デプロイの設定 `deployments/<名前>.jsonc` の `vars.SERVICES` にサービスの定義を書く(OAuth ならシークレットも)。`deployments/` が設定のリポジトリなら、deploy スキルの「設定の変更を残す」に従ってコミットする。ヘッダーか OAuth 2.0 のサービスは、管理者が Web 画面の「接続先の管理」から足してもよい(デプロイし直さずに済む)。
2. デプロイ: `npm run deploy -- <名前>`(deploy スキルの手順 5)。管理画面から足したなら要らない。
3. サービス別のスキル: Claude がその API をどう呼ぶかを書いた `SKILL.md`。プラグインに入れて配る。

## 1. 認証方式を調べる

API の公式ドキュメントを読んで、次を確かめる。推測で書かない。分からなければユーザーに聞く。

- ベース URL(https であること)
- 認証方式と、それが下の表のどれに当たるか
- 認証情報をどう発行するか(管理画面で API キー、OAuth アプリの登録など)
- レート制限とページングの方式(サービス別のスキルに書く)

ゲートウェイが注入できるのは、リクエストヘッダーだけ。

| API の認証 | `auth` |
| --- | --- |
| 固定の API キーやトークンをヘッダーで送る | `headers`。ヘッダーごとに `name` と、Web 画面に出す `label`。`Authorization: Bearer <トークン>` なら `"prefix": "Bearer "` |
| Basic 認証(ユーザー名とパスワード、ユーザー名とトークン) | `basic`。ユーザーが入れたユーザー名とパスワードから、ゲートウェイが `Authorization: Basic` を組み立てる。ユーザー名が決まっている上流(GitHub のトークンは `x-access-token`、Bitbucket のアクセストークンは `x-token-auth`)は `username` に書くと、ユーザーはパスワードだけを入れる。入力欄の名前は `username_label`・`password_label` |
| OAuth 2.0 の認可コード | `oauth2`。`authorization_url`、`token_url`、必要なら `scope` と `authorize_params`。トークンの要求でクライアントを Basic で送る上流は `"client_auth": "basic"`。同じ OAuth アプリを複数のサービスで使うなら `client` に共通の名前 |
| 自社の API で、ゲートウェイのサインインを信頼する(ユーザーごとの認証情報がない) | `identity`。`audience` を書く。ゲートウェイがユーザー ID を Ed25519 で署名して `Authorization: Bearer` で送り、上流は `/.well-known/jwks.json` で検証する。署名鍵 `IDENTITY_SIGNING_KEY` が要る(README の「連携先を設定する」) |

公開ルートを持たない Worker が上流なら、サービスに `"binding": "<BINDING 名>"` を書き、デプロイの設定の `services` に Service Binding を足す。

次の API は、そのままでは足せない。ユーザーに伝えて、どうするか決めてもらう。

- API キーをクエリパラメータで送る API(ヘッダーでも受け付けないかを先に調べる)
- 署名が要る API(AWS Signature など)、mTLS
- OAuth のクライアント認証が `client_secret_post`・`client_secret_basic` 以外のもの(`private_key_jwt` など)。ゲートウェイはトークンエンドポイントにクライアント ID とシークレットをフォームで送り、PKCE も付ける。`Authorization: Basic` で送る上流(X など)は、`auth` に `"client_auth": "basic"` を書く

## 2. SERVICES に書く

定義の形は `src/config.ts` の `ServiceConfig`。組み込みのサービスの定義(`src/catalog.ts`)が、ヘッダー型(`gbizinfo`、`board`)と OAuth 型(`freee`、`gmail`、`graph` など)の例になる。組み込みと同じ名前で書くと、そのサービスの定義を置き換える(スコープを絞るときなど)。

```jsonc
"<service>": {
  "display_name": "Web 画面での表示名",
  // 接続を追加する画面で、この名前ごとにまとめて並ぶ。なければ「その他」
  "provider": "提供元",
  "base_url": "https://api.example.com",
  "auth": { "type": "headers", "headers": [{ "name": "x-api-key", "label": "API キー" }] }
}
```

- サービス名は小文字の英数字とハイフン(`^[a-z0-9][a-z0-9-]*$`)。REST のパス `/api/<service>/...` と、スキルでの呼び名になる。
- `base_url` には、API のパスの共通部分を含めてもよい。上流のパスがそのあとにつながる。
- OAuth では、連携先にアプリを登録してもらい、コールバック URL に `<PUBLIC_URL>/connect/callback` を指定してもらう。リフレッシュトークンを出すのに特別なパラメータが要るサービスがある(Google は `access_type: offline` と `prompt: consent`、Entra は `offline_access` のスコープ)。
- OAuth のクライアント ID とシークレットは、管理者が Web 画面の「接続先の管理」→「OAuth のクライアント」で、`auth.client` の名前(なければサービス名)のクライアントに入れる(デプロイし直さずに済む)。シークレットで入れるなら、その名前を大文字にしてハイフンを `_` にした名前で登録する(こちらが優先)。値はユーザーに直接入れてもらい、会話に貼らせない。クライアントが登録されるまで、そのサービスは Web 画面にも `list_credentials` にも出ない。

```sh
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_ID
npm run secret -- <名前> put OAUTH_<CLIENT>_CLIENT_SECRET
```

書いたら `npm run typecheck` と `npm test` を通して、ユーザーに確認してからデプロイする。デプロイのあと、ユーザーに Web 画面で認証情報を登録(OAuth なら接続)してもらい、`heddleway` スキルの `gw_request.py` で 1 回呼んで確かめる。

## 3. サービス別のスキルを作る

スキルの置き場所をユーザーと決める。

- 自分だけ・自社だけで使うサービス: ユーザー自身のプラグイン(別リポジトリ)に置く。このリポジトリには入れない。
- 誰でも使えそうな汎用のサービスで、このリポジトリに取り込んでほしい場合: 定義は `SERVICES` ではなく `src/catalog.ts` に足し、スキルは、小さいものは共通の `plugins/heddleway/skills/<skill>/` に、大きい提供元のものは提供元のプラグイン(`plugins/heddleway-<提供元>/`。なければ作り、`marketplace.json` に `dependencies: ["heddleway"]` つきで足す)に置く。テストと README も足して PR にする。

スキルは、既存の `plugins/heddleway/skills/gbizinfo`(小さい例)や `plugins/heddleway-freee/skills/freee`(ページングのスクリプトつき)をまねる。

- `SKILL.md` のフロントマターの `name` はディレクトリ名と同じにする。`description` には、何ができるかと、どんな依頼で使うかを具体的に書く(Claude はこれを見てスキルを選ぶ)。
- 本文は「`heddleway` スキルの手順でトークンを発行する」から始めて、サービス名、API の要点(パス、ページング、レート制限、よくあるエラー)、呼び出しの例を書く。
- エンドポイントが多い API は、`references/` に一覧を分けて、`grep` で必要な節だけ読ませる。公開の OpenAPI や GraphQL のスキーマがあれば、生成スクリプトを `tools/` に置く。
- スキルは自分の `scripts/` に `gw_request.py` と `gwlib.py` のコピーを持ち、手順では `GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"` で呼ぶ。ほかのスキルのディレクトリは探さない(Claude Code はプラグインごとに別の場所にインストールし、Cowork はディレクトリを `<plugin>:<skill>` と名付ける)。
  - このリポジトリでは、`scripts/` を作って `npm run plugin:sync` を実行すれば、`lib/plugin/` の原本がコピーされる。
  - 別のリポジトリのプラグインなら、`lib/plugin/` からコピーして同梱する。
- 全件取得などのスクリプトは `scripts/` に置き、`import gwlib` で使う(User-Agent、リトライ、CSV 出力がそろっている。スクリプトと同じディレクトリにあるので、パスの細工は要らない)。

## 4. テスト

- このリポジトリの例(`wrangler.example.jsonc`)にサービスを足したときは、`test/gateway.test.ts` の「sends the gBizINFO API token in its own header」にならって、認証情報が正しいヘッダーで上流に届くテストを足す。`list_credentials` のテストにあるサービス一覧も更新する。
- スクリプトを足したときは、`test/scripts/test_skill_scripts.py` の偽のゲートウェイに応答を足して、ページングや CSV のテストを書く。`SkillDocsTest` が、フロントマターと相対リンクを検査する。
- プラグインのスキルを変えたら、`plugin.json` と `.claude-plugin/marketplace.json` の両方で、そのプラグインの `version` を上げる(テストが一致を検査する)。
