# 0006 ゲートウェイ側の拡張（設計のみ）

- 状態: 設計（プロトタイプでは実装しない。ユーザー識別の伝搬だけは 0003）

## 1. アカウントリンク

Entra ID（UBS）と Google（ノブシテック）の subject を同一 User に束ねる。本体に伝搬する sub は束ねた User の ID。
プロトタイプは seed で User を作るので不要。一人が両テナントを跨ぐ本番で必要（本体は User → 各テナントの Party で Viewer を作る）。

## 2. ServiceClient principal

テナント別 Ingest のために、資格情報の principal に ServiceClient を足し、client_credentials と静的トークンの grant を足す。
本体の `CredentialRef.principal`（user / organization）の organization がこれに対応する。

## 3. act-as 経路

ユーザー不在時（Cron の取り込みなど）に本体がそのユーザーとして上流を呼ぶ経路。ユーザーの同意を記録する。
User 主体の資格情報での pull（`Connector.pull(principal)`）が本番でこれを使う。
(A) に移るなら、本体向けのトークン検証手段（JWKS か introspection）も要る。
