---
name: freee
description: freee(会計・人事労務・請求書・販売)の API を API ゲートウェイ経由で操作する。取引・取引先・勘定科目・口座明細(入出金明細の消込を含む)・振替伝票・証憑(ファイルボックス)・経費申請・試算表などの会計データ、従業員・勤怠・給与明細、請求書・見積書・納品書、販売の案件・受注・売上の検索、一覧の取得・集計、登録・更新を扱う。「freee の取引を一覧して」「今月の経費を集計して」「試算表を出して」「口座明細を消込して」「入金を請求の取引と突き合わせて」「請求書 PDF を freee のファイルボックスに上げて」「SharePoint の請求書を freee に登録して」「従業員の勤怠を見て」などの依頼で使う。
---

# freee API

freee の API を、API ゲートウェイ経由で呼び出す。トークンの発行とスクリプトの基本的な使い方は、`heddleway` スキルに従う。

## 手順

1. `heddleway` スキルの手順で、作業する組織のコネクタ(「コネクタの選び方」)の、サービス `freee` の認証情報でトークンを発行し、`GW_TOKEN` と `GW_BASE_URL` を設定する。
   - `freee` は OAuth のサービスで、ユーザーがゲートウェイの画面で freee アカウントを接続する。上流のトークンはゲートウェイが注入・更新するので、Claude は扱わない。
   - 接続は 1 つのゲートウェイに 1 つ。別の組織の freee は、その組織のゲートウェイのコネクタで使う。
2. `company_id` を決める。`GET /api/1/companies` で、その認証情報から使える事業所の一覧が取れる。1 つの freee アカウントが別の組織の事業所にも入っていることがあるので、作業する組織(コネクタの `gateway.organization`)の事業所を選ぶ。どれか分からなければユーザーに確認する。取り違えてもエラーにならない。
3. 使うエンドポイントを、下の表のリファレンスで探す。`grep -n "^## " references/accounting.md` で見出しを一覧してから、必要な節だけ読む。
4. スクリプトで呼び出す。
   - 1 件の取得や、登録・更新、ファイルのアップロード: このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)
   - 一覧の全件取得: `scripts/freee_all.py`(offset / limit のページングと 429 の再試行を処理する)

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 $GW GET freee /api/1/companies
python3 $GW GET freee /api/1/deals -q company_id=123 -q start_issue_date=2026-09-01 -q limit=20
python3 ${CLAUDE_SKILL_DIR}/scripts/freee_all.py /api/1/deals -q company_id=123 -q type=expense -o deals.json
python3 ${CLAUDE_SKILL_DIR}/scripts/freee_all.py /api/1/partners -q company_id=123 --csv id,name,code -o partners.csv
```

## API の要点

- 4 つの製品が同じホストで、パスの先頭だけが違う: 会計 `/api/1/...`、人事労務 `/hr/api/v1/...`、請求書 `/iv/...`、販売 `/sm/...`。
- ほとんどのエンドポイントで `company_id` が要る。GET と DELETE はクエリ(`-q company_id=...`)、POST / PUT / PATCH は JSON ボディに入れる。事業所に関係しないマスタ(`/api/1/companies`、`/api/1/banks`、`/api/1/taxes/codes` など)には要らない。
- 一覧は `offset` と `limit` でページングする。`limit` の上限はエンドポイントで違う(取引は 100)。レスポンスはリソース名の配列(`{"deals": [...]}` など)で、取引などは `meta.total_count` に総件数が入る。
- 更新は会計・人事労務・請求書が `PUT`、販売の受注・納品・売上は `PATCH`。
- ID は他のリソースから引く。取引先は `/api/1/partners`、勘定科目は `/api/1/account_items`、税区分は `/api/1/taxes/companies/{company_id}`、口座は `/api/1/walletables`。
- 書き込みのボディの項目は、ここに書いたもの以外は freee の公式リファレンス(https://developer.freee.co.jp/reference)で確かめる。推測で項目を作らない。

## リファレンス

| やりたいこと | ファイル |
|---|---|
| 会計: 取引、口座明細と消込(既存取引での消込・明細からの取引登録・口座振替・無視・自動登録ルールの適用)、振替、振替伝票、マスタ、証憑、経費・支払依頼・各種申請、レポート、仕訳帳 | [references/accounting.md](references/accounting.md) |
| 人事労務: 従業員、勤怠、打刻、給与・賞与明細、グループ・役職、勤怠系の申請 | [references/hr.md](references/hr.md) |
| 請求書(`/iv`)と販売(`/sm`) | [references/invoice-sales.md](references/invoice-sales.md) |

## 請求書 PDF をファイルボックスに上げる

SharePoint / OneDrive のファイルや、メールに添付された請求書 PDF を、freee のファイルボックス(証憑)に登録する流れ。ファイルの中身はスクリプトとゲートウェイの間だけでやり取りし、会話には出さない。

1. `issue_token` で `graph` と `freee` の両方の認証情報を含むトークンを 1 つ発行する。
2. `microsoft-graph` スキルで PDF を探して保存する。
   - SharePoint / OneDrive: 検索して drive ID と item ID を得て、`gw_request.py GET graph /v1.0/drives/{drive-id}/items/{item-id}/content -o invoice.pdf`
   - メールの添付: メールを検索し、添付の一覧から ID を得て、`gw_request.py GET graph '/v1.0/me/messages/{id}/attachments/{attachment-id}/$value' -o invoice.pdf`
3. 保存したファイルが PDF か(`file invoice.pdf` など)とサイズを確かめる。
4. ファイルボックスに上げる。どのファイルをどの事業所に上げるか、先にユーザーに確認する。

```sh
python3 $GW POST freee /api/1/receipts -f company_id=123 --file receipt=invoice.pdf -f description='株式会社サンプル 2026年9月分'
```

- 必須は `company_id` と `receipt`(ファイル)。`description`(メモ)は任意。
- 成功すると 201 で、作られた証憑(`receipt.id` など)が返る。ファイルボックスには並ぶが、取引は自動では作られない。取引の登録や証憑との紐付けは、ユーザーが freee の画面で確認して行う。ユーザーに明示的に頼まれたときだけ、API で取引を作る(取引の `receipt_ids` に証憑 ID を入れると紐付く)。
- 同じファイルを二重に上げないよう、複数件を上げるときは、上げたものの一覧(ファイル名と証憑 ID)を残す。

## 制限と注意

- レート制限を超えると 429 が返る。`Retry-After` があれば従う。大量に取得するときは `freee_all.py`(1 秒に 1 回)を使い、同じデータを何度も取らずにファイルに保存して使い回す。
- ゲートウェイ自身のエラーは `{"error": "..."}`。`credential must be reconnected by the user at ...` の 403 は、その URL でユーザーに freee を接続し直してもらう。`token does not cover service: freee` はトークンを発行し直す。
- freee のエラーは `status_code` と `errors[].messages` を含む JSON で返ることが多い。400 はまず `messages` を読む(`company_id` の付け忘れ、日付の形式 `YYYY-MM-DD`、必須項目の不足が多い)。403 は、そのユーザーの freee 上の権限や、プランで使えない機能のことがある。
- 登録・更新・削除・申請の承認や却下は、実行前に対象と内容をユーザーに確認する。会計データの削除は取り消せない。
- 金額や件数を報告するときは、取得した件数と `meta.total_count` が一致しているか確かめる。
