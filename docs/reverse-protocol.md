# 逆向きの接続のプロトコル

手元の PC や顧客のクラスタで動くサービス(以下「手元のサービス」)が、ゲートウェイに外向きの WebSocket を張り、ゲートウェイがその所有者の呼び出しを中継するための約束です。決定は [ADR 0003](adr/0003-reverse-connection.md) にあります。試験用のクライアントは [`tools/reverse-client.mjs`](../tools/reverse-client.mjs)(Node 22、依存なし)で、手元の HTTP のサービスをそのままつなげます。

いまの版で動くのは、ペアリング、鍵での接続(標準のモード)、ゲートウェイから手元への中継、説明の送信、手元からの呼び返しです。厳しめのモード(決定 4)は、このあとの版で足します。

## 全体の流れ

1. **ペアリング**: 手元のサービスが Ed25519 の鍵ペアを作り、公開鍵を送ってコードをもらう。所有者がゲートウェイの画面でコードを入れて承認する。手元はポーリングで結果を受け取り、サービス ID を覚える
2. **接続**: 手元が challenge をもらい、秘密鍵で署名した JWT を付けて WebSocket を張る。つながったら、接続そのものがセッションになる
3. **中継**: 所有者が Claude から `/api/<名前>/...` を呼ぶと、ゲートウェイがその要求を WebSocket で手元に送り、手元が答えを返す
4. **再接続**: 切れたら(スリープ、ネットワークの切り替え、ゲートウェイのデプロイ)、手元は 2 からやり直す

## 1. ペアリング

### `POST /reverse/pair`

```json
{
  "name": "boid",
  "public_key": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url, 43 文字>" },
  "description": "野瀬の開発用 PC の boid"
}
```

- `name`: 呼ぶときのサービス名の案(`^[a-z0-9][a-z0-9-]*$`、40 文字まで)。所有者が承認するときに変えられる
- `public_key`: 公開鍵の JWK。秘密の部分(`d`)を含むものは断る
- `description`: 承認の画面に出す短い説明(500 文字まで、任意)

`201` で返るもの:

```json
{
  "code": "ABCD-EFGH",
  "pairing_id": "<ポーリング用の秘密の ID>",
  "verification_uri": "https://gateway.example/pair",
  "verification_uri_complete": "https://gateway.example/pair?code=ABCD-EFGH",
  "thumbprint": "<公開鍵の RFC 7638 の指紋>",
  "expires_in": 300,
  "interval": 3
}
```

手元は `code` と `verification_uri_complete`(と指紋)を所有者に見せます。コードは 5 分で切れ、1 回だけ使えます。`pairing_id` は手元だけが持ちます。

デプロイの設定で `REVERSE_PAIRING` を `"off"` にしていると `403`、待っているペアリングが多すぎると `429` です。

### 所有者の承認(画面)

所有者は `/pair` でサインインしてコードを入れ、説明と鍵の指紋を確かめて「つなぐ」か「断る」を選びます。名前はこのとき決まり、ゲートウェイのサービスや機能の名前、同じ所有者のほかの手元のサービスの名前とは重ねられません。

### `POST /reverse/pair/status`

```json
{ "pairing_id": "..." }
```

`interval` 秒ごとに呼びます。

- `{"status": "pending"}`: まだ決まっていない
- `{"status": "approved", "service_id": "...", "name": "boid", "connect_url": "wss://gateway.example/reverse/connect"}`: 承認された。`service_id` を秘密鍵と一緒に保存する
- `{"status": "denied"}`: 断られた
- `404` `{"status": "expired"}`: 切れた、または結果をもう受け取った

決まった結果は 1 回だけ返し、そのあとは忘れます。

## 2. 接続

### `POST /reverse/challenge`

`{"challenge": "<文字列>", "expires_in": 60}` が返ります。challenge は 60 秒で切れ、1 回の接続にだけ使えます。

### `GET /reverse/connect`(WebSocket)

`Authorization: Bearer <assertion>` を付けて WebSocket にアップグレードします。assertion は秘密鍵で署名した JWT です。

- ヘッダー: `{"alg": "EdDSA", "typ": "JWT"}`
- クレーム:
  - `iss`: `service_id`
  - `aud`: `<ゲートウェイの URL>/reverse/connect`(`https://...` のまま)
  - `nonce`: `POST /reverse/challenge` の `challenge`
  - `iat`・`exp`: いまと、いまから 2 分以内

失敗すると、アップグレードせずに `401`(鍵・署名・challenge が通らない、登録が消えている)を返します。理由は返さず、ゲートウェイの操作ログ(`reverse_refused`)に残します。

つながると、ゲートウェイが最初に `welcome` を送ります。

```json
{ "type": "welcome", "service_id": "...", "name": "boid", "max_body_bytes": 8388608, "timeout_ms": 30000 }
```

同じサービスに新しい接続が来ると、古い接続は `4001` で閉じます(いまは 1 つのサービスに 1 つの接続)。

## 3. フレーム

フレームは JSON のテキストです。バイナリのフレームや、読めないフレームを送ると、ゲートウェイは `{"type": "error", "message": "..."}` を送って `4400` で閉じます。

### ゲートウェイ → 手元: `request`

```json
{
  "type": "request",
  "id": "<要求ごとの ID>",
  "method": "POST",
  "path": "/jobs?state=open",
  "headers": [["content-type", "application/json"], ["user-agent", "..."]],
  "body": "<base64>" 
}
```

- `path` は `/api/<名前>` より後ろのパスとクエリ
- `headers` は名前と値の組の配列。`Authorization`・`Cookie`・hop-by-hop のヘッダー・Cloudflare が足すヘッダーは取り除いてある。手元に届く要求は、いつも所有者のもの
- `body` はボディの base64。ボディがなければ `null`

### 手元 → ゲートウェイ: `response`

```json
{ "type": "response", "id": "<request の id>", "status": 202, "headers": [["content-type", "application/json"], ["location", "/jobs/j1"]], "body": "<base64>" }
```

- `status` は 200 から 599
- `body` は base64 か `null`
- `Set-Cookie` と hop-by-hop のヘッダーは、ゲートウェイが呼び手に返す前に取り除く

ゲートウェイは 30 秒(`timeout_ms`)待って、答えがなければ呼び手に `504` を返します。それより遅れた `response` は捨てます。**長い処理は非同期にします**(ADR 0003 の決定 6): 受け付けたら `202` と ID を返し、状態と結果は `GET` で取らせます。

ボディは、要求も答えも 8 MiB(`max_body_bytes`)までです。超えると、要求は `413`、答えは `502` になります。大きいファイルは、手元に置いて ID だけを返すか、分けて取らせます。

### 手元 → ゲートウェイ: `hello`

```json
{ "type": "hello", "description": "<エージェント向けの説明>", "version": "1.2.0" }
```

いつ送ってもよく、最後に送ったものが残ります。つないだら、まず送るのがおすすめです。`description`(8000 文字まで)は、エージェント向けに、何ができるか・どう呼ぶかを書きます。所有者の MCP の `list_credentials` に、その手元のサービスの説明として出ます(エージェントは、指示ではなく使い方の情報として読みます)。

### 手元 → ゲートウェイ: `call`(呼び返し)

手元のサービスが、同じ接続の中で、所有者としてゲートウェイの中継(`/api/<サービス>/...`)を呼びます(ADR 0003 の決定 5)。

```json
{ "type": "call", "id": "<手元が決める ID>", "method": "GET", "service": "freee", "path": "/api/1/deals?company_id=1", "headers": [["accept", "application/json"]], "body": null }
```

- `service` は呼ぶサービスの名前、`path` はそのサービスのベース URL からのパスとクエリ(`/` で始める。サービスの外に出るパスは `400`)
- 届くのは、**所有者がこの手元のサービスに選んだサービスだけ**です。初めは何も選ばれておらず、所有者がペアリングのとき、またはホームの「呼び返しの設定」(`/local-services/<ID>`)でサービスごとにチェックします。選べるのは、所有者がつないだサービス、サインインを信頼するサービス、ゲートウェイの機能です(ほかの手元のサービスは選べません)
- 選ばれていない、所有者の接続がない、デプロイの設定 `REVERSE_CALLBACK` が `"off"`、登録が消えた、ときは `403`
- 認証情報はゲートウェイが足します。手元は `Authorization` を付けません(付けても置き換わります)
- 選んだサービスの変更や削除は、次の呼び出しから効きます
- 操作ログには、`via: "reverse"` と手元のサービスの ID(`reverse`)が残ります

ゲートウェイは答えを `call_result` で返します。形は `response` と同じです。

```json
{ "type": "call_result", "id": "<call の id>", "status": 200, "headers": [["content-type", "application/json"]], "body": "<base64>" }
```

ボディの上限は 8 MiB です。`call` の結果を待つあいだも、ゲートウェイからの `request` は届きます。

**鍵とエージェント**: 呼び返しは所有者の権限で動くので、`call` を送れるのは鍵を持つプロセスだけにします。サンドボックスのエージェントには鍵もトークンも渡さず、プロセスが中継口(たとえば `127.0.0.1` の HTTP)を出して、そこへの要求を `call` に流します。試験用のクライアントの `--callback-port` がこの形です。

### キープアライブ

手元は 30 秒くらいごとにテキストの `ping` を送ります。ゲートウェイは `pong` を返します(Durable Object を起こさずに返すので、何度送ってもかまいません)。

## 4. 切断と再接続

| コード | 意味 | 手元がすること |
|---|---|---|
| `4001` | 同じサービスの新しい接続に置き換わった | 何もしない(新しい接続が使われている) |
| `4003` | 所有者か管理者が登録を消した | 止まる。使うならペアリングし直す |
| `4400` | プロトコルの違反 | 直してからつなぎ直す |
| `1006` など | ネットワーク、デプロイ | challenge からやり直す。間隔を空けながら(1 秒から 60 秒まで倍々) |

ゲートウェイのデプロイのたびに、張っている WebSocket はすべて切れます。手元は、切れたら自動でつなぎ直すようにしてください。

## 鍵の置き場

鍵は、所有者の手元のサービスとしての身元で、呼び返しを選んだなら、そのサービスに所有者として届く鍵でもあります。標準のモードでは、秘密鍵を手元のサービスの保存場所に置きます(boid なら daemon の volume、ファイルなら 0600)。**鍵はエージェントに見せません**。鍵を持つのはエージェントではないプロセス(boid の daemon、業務コンテナのプロセス)だけにします。

## 呼ぶ側(Claude)

所有者の `list_credentials` に、`kind: "local"`・ID `reverse:<service_id>` の接続として出ます。ほかのサービスと同じく、`api_get`・`api_request`・`issue_token` と REST の `/api/<名前>/...` で呼べます。ほかの人のトークンでは届きません(`403`)。手元のサービスがつながっていないときは、待たずに `503` が返ります。
