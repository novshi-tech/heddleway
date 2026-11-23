# 0001 boid の API ゲートウェイを引き取り、認証情報の置き場を一本にする

- 状態: 案(2026-10-29、直樹とのディスカッション)
- 関連: [0002](0002-git-over-gateway.md)(git の接続先)、[0003](0003-reverse-connection.md)(手元や顧客の環境のサービスへの逆向きの接続)、[concept.md](../concept.md)、[background-access.md](../background-access.md)
- 発端: novshi-tech/boid の `docs/plans/split-and-shrink.md`(boid の分割と縮退)

## 背景

boid(パーソナル AI オーケストレータ)は、daemon の中に認証注入のプロキシ(API gateway と git gateway)を持っている。このゲートウェイは、その API gateway をチャットと Cowork から使えるように作り直したもの。

boid は縮退させる方針になった。Claude Code のクラウドセッションでもともと boid のサンドボックスでやりたかったことの多くができるようになり、boid には workspace・sandbox・job だけを残す。boid の API gateway をそのまま残すと、次のものが二重になる。

- 認証情報の置き場(boid の secret と `UserVault`)
- 接続先の定義(boid の `services.<name>` と、カタログ・`SERVICES`・管理画面)
- OAuth のクライアントの登録
- API の使い方のスキル

workspace の中に閉じる(秘密情報が手元から出ない)メリットはあるが、このゲートウェイもセルフホストで、預け先が自分であることは変わらない。手元(LAN・localhost)からしか届かない API も、今のところない。

## 決定(案)

### 1. boid の API gateway を退役させ、このゲートウェイに一本化する

- boid の job(コーディングエージェント)は、このゲートウェイを MCP のコネクタとしてつなぐ。サンドボックスのスクリプトはこれまでどおり `issue_token` の短命トークンで REST を呼ぶ
- [concept.md](../concept.md) の「Claude Code のような開発者向けの環境では、boid と同じように API を直接叩かせればよいので、このゲートウェイは必要ない」を改める。開発者向けの環境(Claude Code のクラウドセッションと boid)も、このゲートウェイの利用者になる

### 2. 隔離はゲートウェイのインスタンスで分ける

1 つのデプロイが信頼の単位。隔離したい単位ごとにデプロイを並べ、利用者の側でつなぐインスタンスを切り替える。ゲートウェイの中にテナントや切り替えは足さない。

| 段 | 単位 | 切り替え方 |
|---|---|---|
| Claude のアカウント | つなぎ先がまったく違う事業 | アカウントごとに、メインのゲートウェイを claude.ai のコネクタとしてつなぐ |
| boid の workspace | 同じ事業の中の、顧客ごとの環境 | boid の workspace では claude.ai のコネクタを切り、その顧客向けのゲートウェイにつなぎ直す |

- 顧客向けのゲートウェイは、運営者の Cloudflare アカウントに顧客ごとのデプロイとして並べてよい(`deployments/<名前>.jsonc`)。1 つの clone から複数のデプロイを管理する今の形にそのまま乗る
- スキルはツールを短い名前(`issue_token`)で呼び、向き先は `issue_token` が返す `GW_BASE_URL` から取る。MCP サーバーの登録名はインスタンスごとに違ってよい
- 2 つのゲートウェイを同時につなぐと、Claude がどちらの `issue_token` を使うかを取り違えうる。トークンは発行したゲートウェイでしか使えないので認証情報は漏れないが、別の事業のアカウントに書いてしまう。boid の workspace では claude.ai のコネクタを切っておく、を運用の約束にする

### 3. Claude のセッションの外の利用者は、OAuth のクライアントになってトークンをもらう

boid の中には、Claude のセッションの外で動いてトークンが要るものがある(git の credential helper、MCP を話さないハーネスの job)。

- boid の daemon は、Murmur と同じくこのゲートウェイの OAuth のクライアントになる(CIMD)。本人が同意し、boid はリフレッシュトークンを持ち、`issue_token` で短命トークンをもらう。**ゲートウェイのコードの変更は要らない**([background-access.md](../background-access.md) の個人の箱と同じ形)
- サンドボックスの中には、リフレッシュトークンを入れない。サンドボックスの中の credential helper は boid の daemon に短命トークンを頼む
- MCP の JSON-RPC を話さずに済む、`issue_token` と同じことをする薄い HTTP の口を足すかは未決(下)

## 代案

- **boid の API gateway を残し、こちらと並べる**: 上の二重管理がそのまま残る。採らない
- **ゲートウェイの中で workspace ごとに認証情報を分ける(アカウント修飾やテナント)**: boid の `--account` のような分け方はあるが、顧客の環境は事業のメインと信頼の単位が違うので、デプロイを分ける方が境界がはっきりする。1 つのデプロイの中の複数の認証情報(1 サービスに複数のアカウント)は今のまま使う

## 帰結

- 採用したら、concept.md の上の一文を直す
- boid の側の退役の手順は、boid のリポジトリで扱う

## 未決

1. MCP を話さない薄い HTTP のトークンの口を足すか。足すなら、MCP の `issue_token` と同じ検証(OAuth のアクセストークン、認証情報の ID)を通す
2. boid の daemon の OAuth のコールバック。boid は手元で動くので、CIMD のメタデータとコールバックの URL をどこに置くか(loopback のリダイレクトか、0003 の接続を通すか)
