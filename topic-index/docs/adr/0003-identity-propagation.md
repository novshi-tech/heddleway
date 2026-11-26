# 0003 ゲートウェイから伝搬されるユーザー識別の形式

- 状態: 採用（2026-10-16。api-gateway-mcp の f6fa0ed で実装）。**Murmur への identityは 0023（採用、2026-11-04）で改めた**（Murmur をゲートウェイの機能にして 1 つの Worker にした。2026-11-05 に実装）
- 関連: 計画「認可の接続の形 (B)」「ステップ 1 のトークン検証: 本体は署名付きで伝搬された sub を検証する」

## 背景

(B) では本体はゲートウェイの上流サービスとして登録され、署名付きで伝搬されたユーザー識別（sub）を受け取る。
最初は形式を仮に決めて本体だけで実装したが（ヘッダ `x-murmur-identity`）、ゲートウェイ側を実装するときに
ゲートウェイの汎用の仕組みとして入れ、本体をそれに合わせた。

## 決定

ゲートウェイ（api-gateway-mcp）に、上流の認証方式 `identity` と、Service Binding での中継を足した。

- サービスの定義（ゲートウェイの `wrangler.jsonc` の `SERVICES`）

  ```jsonc
  "murmur": {
    "display_name": "Murmur",
    "base_url": "https://murmur.internal/api",
    "binding": "MURMUR",
    "auth": { "type": "identity", "audience": "murmur" }
  }
  ```

- ゲートウェイは、サインイン中のユーザーの ID を Ed25519 で署名した JWT を `Authorization: Bearer` で送る
  - ヘッダ: `alg: EdDSA`、`typ: JWT`、`kid`（公開鍵の JWK thumbprint）
  - クレーム: `sub`（ゲートウェイの User ID）、`iss`（ゲートウェイの PUBLIC_URL）、`aud`（`murmur`）、`iat`、`exp`（寿命 5 分）
  - 署名鍵は ゲートウェイの secret `IDENTITY_SIGNING_KEY`（Ed25519 の秘密鍵の JWK）。公開鍵は `<gateway>/.well-known/jwks.json`
- 呼び出し元が送ってきた `Authorization` は、ゲートウェイが捨てて差し替える。スタンドが本体を直接名乗ることはできない
- スタンドから見ると、`list_credentials` に `identity:murmur` という認証情報が出る。ユーザーが何かを登録する必要はない
- 本体は `GATEWAY_JWKS`（jwks.json の中身）で署名を、`IDENTITY_AUDIENCE` で aud を、`IDENTITY_ISSUER`（設定すれば）で iss を確かめる。
  kid で鍵を選ぶので、鍵の入れ替えは JWKS に新旧を並べればよい。検証は `src/auth/identity.ts`、クレームと鍵の選択は `src/auth/claims.ts`（純関数）
- 本体は公開鍵しか持たない。共有秘密・API キーは持たない

## User ID

`sub` はゲートウェイの User ID で、IdP ごとに `entra_<tenant-id>_<object-id>` / `google_<sub>` の形。
本体のマスタの `User.id` はこの値にする（プロトタイプの seed も、実環境で回すときは置き換える）。
Entra ID と Google を同じ User に束ねるアカウントリンクは未実装（0006）。今は IdP ごとに別の User になる。

## 未決

- 本体が JWKS を設定値で持つか、起動時にゲートウェイから取るか。プロトタイプは設定値（取りに行くと Service Binding の向きが逆になる）
