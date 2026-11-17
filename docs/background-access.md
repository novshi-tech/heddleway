# 人がいないときの利用者(Murmur)に接続を使わせる

> 2026-11-05: Murmur はゲートウェイの Worker の機能になった([adr/0005](adr/0005-murmur-as-a-feature.md))。個人の箱は、Murmur が OAuth のクライアントになる形(下の CIMD)ではなく、本人がゲートウェイの画面で Murmur を有効にし、ゲートウェイの中核が本人の接続を読む関数を渡す形になった。共有の箱(`client_credentials`)の考え方はこのまま。
>
> 2026-11-16: Murmur の共有メールボックスは、この経路を使わないことにした(Murmur の [0042](../murmur/docs/adr/0042-shared-mailbox-by-polling.md))。変更通知をあきらめ、メンバーの委任(`Mail.Read.Shared`)で見回りの delta だけで読む。`client_credentials` と `Background` の入口はゲートウェイの機能として残す。

更新日: 2026-10-29

状態: 1〜3 を実装した(2026-10-29)。

構想: [concept.md](concept.md)
認可の設計: [auth-design.md](auth-design.md)
運用開始後の見直し: [redesign.md](redesign.md)
Murmur の側の決定: novshi-tech/murmur の `docs/adr/0024-connectors-own-webhooks.md`

## 背景

Murmur(連絡の索引)は、Outlook のメールを Microsoft Graph の変更通知(Webhook)と delta クエリで取り込む。取り込みは人がいないとき(夜中の通知、定期の見回り)にも動くので、Murmur がゲートウェイを通して上流を呼ぶ経路が要る。

Murmur の側で議論した結果、次のように分けた。

- **Webhook の管理(サブスクリプションの作成・更新・再認可・作り直し)は Murmur が持つ。** ゲートウェイには置かない。ゲートウェイは HTTP と OAuth2 だけを知り、サービスを足してもコードを変えない、という性格を保つ。ゲートウェイから Murmur へ処理を投げ返す経路も作らない。
- **個人のメールボックスは本人の権限で読む。** Murmur は Claude と同じく、ゲートウェイの OAuth クライアントになる。本人が同意し、Murmur は `issue_token` で短命トークンをもらって REST を呼ぶ。**ゲートウェイの変更は要らない**。Murmur は本人の `graph` の接続をそのまま使う。
- **共有メールボックスはアプリの権限で読む。** Graph の仕様で、委任の権限では本人の箱の通知しか受けられない(`Mail.Read.Shared` は通知に使えない)。アプリの資格情報には同意する人がいないので、テナントの管理者が管理画面で登録する。

このドキュメントは、そのためにゲートウェイに足すものを決める。

## 足すもの

### 1. 認証方式 `client_credentials`

OAuth2 の client credentials で上流のトークンを取る認証方式を足す。持ち主はユーザーではなくデプロイ。

```jsonc
"graph-app": {
  "display_name": "Microsoft Graph(アプリ)",
  "provider": "Microsoft",
  "base_url": "https://graph.microsoft.com",
  "auth": {
    "type": "client_credentials",
    "client": "murmur-app",
    "token_url": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token",
    "scope": "https://graph.microsoft.com/.default"
  }
}
```

- **管理画面から登録する**(デプロイはシンプルなまま)。接続先の登録画面の認証方式に「OAuth 2.0(client credentials)」を足し、トークンの URL・スコープ・client id・client secret を入れる。定義は `Registry` の `svc:`、client id と secret は今の OAuth のクライアントと同じく `Registry` の `client:` に `ENCRYPTION_KEY` で暗号化して置く。設定ファイル(`SERVICES`)に書いて、client を `OAUTH_<CLIENT>_CLIENT_ID` / `_CLIENT_SECRET` で入れることもできる(ほかの認証方式と同じ)。
- 上の例は設定ファイルに書いた場合。管理画面で登録したときは `client` を書かず、登録した client を使う。
- トークンは寿命(Entra は 1 時間前後)まで Worker のメモリに覚えて使い回し、切れたら取り直す。リフレッシュトークンはない。トークンは保管しない。
- この接続先は、画面にも `list_credentials` にも出さない。ユーザーが使うものではない。
- 上流で絞る: テナントの管理者が、Murmur 専用のアプリを Entra に登録する。**Entra では API のアクセス許可を何も付けない**(`Mail.Read` のアプリの権限に同意すると、テナントの全員の箱に届き、Exchange のスコープより優先される)。権限は Exchange の RBAC for Applications で、役割 `Application Mail.Read` を読ませる共有の箱だけの管理スコープに付けて渡す。手順は [deploy.md](deploy.md) の「人がいないときに Worker が使う接続先」に書いた。

### 2. Service Binding だけから呼べる入口

`client_credentials` の接続先を使えるのは、同じアカウントの Worker(Murmur)だけにする。

- 名前付きのエントリポイント(`export class Background extends WorkerEntrypoint`)を足す。デフォルト以外のエントリポイントはインターネットに出ず、Service Binding からしか呼べない。その入口に届いたこと自体が、呼び出し元が同じアカウントの Worker である証明になるので、**呼び出し元との間のシークレットは要らない**。
- 呼び出し側の設定: `{ "binding": "GATEWAY", "service": "<ゲートウェイの Worker 名>", "entrypoint": "Background" }`
- 今のデフォルトの `fetch` は、インターネットからも Service Binding からも同じ入口で呼ばれ、リクエストからはどちらか区別できない(ヘッダーは偽造できる)。そのため入口を分ける。
- パスは REST のベース URL(`<ゲートウェイ>/api`)からの相対と同じ `/<service>/<上流のパス>`。`/api` は付けない。ホスト名は何でもよい(例: `env.GATEWAY.fetch("https://gateway/graph-app/v1.0/users/...")`)。中継の動き(ヘッダーの注入、ボディの素通し、リダイレクトの扱い、操作ログ)は REST と同じものを使う。
- **この入口で使えるのは `client_credentials` の接続先だけ。** ユーザーの接続には届かない。ここからユーザーの接続を使えると、本人の同意(OAuth)を飛ばせてしまう。
- 信頼の境界は Cloudflare のアカウントになる。そのアカウントに Worker をデプロイできる人は、この入口を使える。ゲートウェイと Murmur はチームの同じアカウントに置く前提(Murmur の ADR 0020)。

### 3. 許可したクライアントの一覧と取り消し(あるとよい)

本人が Murmur への同意をやめられるようにする。今の画面には、同意したクライアント(Claude、Murmur)を一覧する場所がない。

- `workers-oauth-provider` には、ユーザーごとの許可(grant)を一覧して取り消す機能がある。接続の一覧の画面に「アクセスを許可したアプリ」を足し、取り消しのボタンを付ける。
- 新しい仕組みではなく、画面を足すだけ。

## concept.md・redesign.md から変わること

- redesign.md の「認証情報の持ち主はユーザーだけ」を、「管理者が登録する `client_credentials` の接続先を除く」に改める。管理者が扱うのは接続先の定義とクライアントだけ、という線はそのまま(client credentials の client id と secret はクライアントの一種)。管理者は相変わらず、ほかのユーザーの認証情報には触れない。
- concept.md の「ゲートウェイがやらないこと」は変えない。API の仕様は知らず、メソッドやパスで認可しない。Webhook も扱わない。

## 変えないこと

- ゲートウェイから Murmur への呼び出しは増やさない(スタンドの中継の `murmur` だけ)。呼び出しはいつも Murmur からゲートウェイへの一方向。
- Murmur は上流のトークンを持たない。個人の箱についてはゲートウェイのリフレッシュトークンを持つ(Claude と同じ)。共有の箱については何も持たない。

## 割り切り

- Murmur には読み取りだけの接続を別に用意せず、本人の `graph` の接続(読み書きの権限)をそのまま使わせる。Murmur の取り込みで AI が判断するのは区切りと「返事を求めているか」だけで、書き込むかどうかを判断する箇所はない。読み取りしかしないことは、Murmur のコードで決定論的に保証できる。

- 今の OAuth の同意はゲートウェイ全体の単位で、接続ごとには絞れない。Murmur は理屈の上で、本人のほかの接続(freee など)にも届く。Claude に許可するのと同じ信頼の置き方。気になったら、同意を接続の単位に絞る(スコープを接続先ごとに分ける)のを別に考える。
- Murmur のリフレッシュトークンは 30 日使わないと失効するが、Murmur は取り込みで使い続けるので、放っておいて切れることはまずない。

## 未決

1. 上流(Entra)向けの client secret をなくすか。証明書にするか、Entra のフェデレーション資格情報(ゲートウェイが自分で署名した JWT をそのまま出す)を使う。ゲートウェイの署名は Ed25519 なので、Entra が受け付けるかを調べてから決める。
2. ~~redesign.md の作業との順番~~ 1 と 2 は管理画面の認証方式を 1 つ増やす形で入れた。3 は接続の一覧の画面に足す。
3. Murmur は CIMD のクライアントになる(client_id は Murmur が公開するメタデータの URL)。CIMD の検証で、Murmur のコールバックの URL が許されるかを確かめる。

## 実装

- 認証方式の型と検証: `src/config.ts` の `ClientCredentialsAuth`。トークンの取得は `src/upstream-oauth.ts` の `clientCredentialsToken`
- 入口: `src/background.ts` の `Background`(`src/index.ts` から export)。トークンはサービス・トークンの URL・client id・スコープごとに isolate のメモリに覚え、期限の 1 分前まで使い回す。同時に来た呼び出しは 1 回の取得を共有する
- 中継は `src/proxy.ts` の `forward` を REST と共有する。操作ログは `user` の代わりに `"caller": "background"` を書く
- `client_credentials` の接続先は、`list_credentials`・「接続を追加」・REST(`/api/`)のどれにも出ない(REST では 404)。ユーザーの保管庫にも入らない
- 許可したアプリの一覧と取り消し: `src/web/grants.ts`。トップの画面に許可(grant)ごとに出し、確認のあと `revokeGrant` で取り消す。アプリの名前は、許可したときにクライアントの名前を grant の metadata に入れておき、一覧では引き直さない(CIMD のメタデータを毎回取りに行かないため)。それ以前の許可は client_id のホスト名で出す
- テスト: `test/background.test.ts`、`test/admin.test.ts`(管理画面からの登録)、`test/oauth-flow.test.ts`(許可の一覧と取り消し)

## 確かめること

- Cloudflare の名前付きエントリポイントがインターネットに出ないこと(Service Binding からだけ呼べること)
- Entra の client credentials のトークンと、RBAC for Applications のスコープの外の箱が 403 になること
