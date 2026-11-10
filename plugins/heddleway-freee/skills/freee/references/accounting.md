# 会計 API(`/api/1`)

例の `$GW` は このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの)、`$ALL` はこのスキルの `scripts/freee_all.py`。GET と DELETE は `company_id` をクエリに、POST と PUT は JSON ボディに入れる。書き込みのボディの細かい項目は公式リファレンス(https://developer.freee.co.jp/reference/accounting/reference)で確かめる。

## 事業所・ユーザー

```
GET /api/1/companies          # 使える事業所の一覧(company_id は不要)。companies[].id が company_id
GET /api/1/companies/{id}     # 事業所の詳細
GET /api/1/users/me           # 自分。-q companies=true で所属事業所と権限も
GET /api/1/users              # 事業所のユーザー一覧(company_id)
```

## 取引(deals)

収入・支出の記帳の基本単位。

```
GET    /api/1/deals           # 一覧
GET    /api/1/deals/{id}      # 1 件
POST   /api/1/deals           # 作成
PUT    /api/1/deals/{id}      # 更新
DELETE /api/1/deals/{id}      # 削除(-q company_id=...)
```

一覧の主な絞り込み: `type`(`income` / `expense`)、`partner_id`、`start_issue_date` / `end_issue_date`、`start_due_date` / `end_due_date`、`status`(`settled` 決済済み / `unsettled` 未決済)、`offset` / `limit`(最大 100)。総件数は `meta.total_count`。

```sh
python3 $ALL /api/1/deals -q company_id=123 -q type=expense -q start_issue_date=2026-09-01 -q end_issue_date=2026-09-30 -o deals.json
```

作成の最小形。`details[]` の各行に勘定科目・税区分・金額を入れる。

```sh
python3 $GW POST freee /api/1/deals --json '{
  "company_id": 123,
  "issue_date": "2026-09-26",
  "type": "expense",
  "partner_id": 456,
  "details": [{"account_item_id": 789, "tax_code": 136, "amount": 11000, "description": "9月分"}],
  "receipt_ids": [1001]
}'
```

- `account_item_id` は `/api/1/account_items`、`tax_code` は `/api/1/taxes/companies/{company_id}` で調べる。値を推測しない。
- `receipt_ids` は紐付ける証憑の ID(任意)。
- 支払済みにするときは `payments[]` を付ける(口座と日付と金額)。項目は公式リファレンスで確かめる。

## 口座と口座明細(walletables / wallet_txns)

```
GET  /api/1/walletables                   # 口座の一覧(銀行口座・クレジットカード・現金など)。-q with_balance=true で残高も
GET  /api/1/walletables/{type}/{id}       # type は bank_account / credit_card / wallet
GET  /api/1/wallet_txns                   # 明細の一覧(walletable_type と walletable_id は 2 つ揃えて指定、start_date、end_date、entry_side、sort_type=created_at_desc、offset、limit 最大 100)
GET  /api/1/wallet_txns/{id}
POST /api/1/wallet_txns                   # 明細の手入力
DELETE /api/1/wallet_txns/{id}
```

明細の主な項目: `amount`(正の金額。入出金は `entry_side` の `income` / `expense`)、`due_amount`(まだ取引が登録されていない金額)、`description`(銀行・カードの摘要)、`status`、`rule_matched`(自動登録ルールで登録されたか)。

`status` の値: `1` 消込待ち(未消込)、`2` 消込済み、`3` 無視、`4` 消込中(一部の金額だけ取引登録済み)、`6` 対象外。一覧に `status` の絞り込みはないので、期間と口座で取ってから手元で絞る。

## 口座明細の消込(wallet_txns の reconcile ほか)

「自動で経理」の画面でしていた、明細の消込・取引登録・口座振替登録・プライベート取引・無視と、自動登録ルールの一括適用を API でできる(2026-10-26 追加)。すべて POST で、ボディに `company_id` を入れる。

```
POST /api/1/wallet_txns/{id}/reconcile            # 既存の未決済取引で消込(差額は adjustment_deal で新規取引に)
POST /api/1/wallet_txns/{id}/create_deal          # 明細から取引を作って消込
POST /api/1/wallet_txns/{id}/create_transfer      # 明細を口座振替として登録(手数料等も同時に)
POST /api/1/wallet_txns/{id}/create_private_deal  # プライベート取引として登録して消込
POST /api/1/wallet_txns/{id}/ignore               # 「無視」にする
POST /api/1/wallet_txns/{id}/reset                # 「無視」「消込済み」を「未消込」に戻す
POST /api/1/user_matchers/apply                   # 未消込の明細に、未適用の自動登録ルールを一括適用(非同期)
```

- 提供は段階的で、まず freee 認定アドバイザー向け(2026 年 10 月以降、順次)。使えない事業所・アカウントでは 403 や 404 になることがある。そのときは freee の画面で消込してもらう。
- どれも会計データを作る・変える操作。明細ごとに、どの明細を(日付・金額・摘要)、何で(取引 ID、勘定科目、税区分、金額)消込するかをユーザーに見せて確認してから実行する。まとめて処理するときは、計画を表にして確認を取り、結果(明細 ID と作られた取引 ID)を記録しておく。
- 対象は未消込(`status` が `1`、一部なら `4`)の明細。消込済みの明細をやり直すときは、先に `reset` で戻す。

### 既存の取引で消込する(reconcile)

請求書を先に取引として登録してあり、入金・出金の明細と突き合わせるとき。`deals[].amount` の合計(と `adjustment_deal` の金額)を明細の金額に合わせる。

```sh
python3 $GW POST freee /api/1/wallet_txns/5001/reconcile --json '{
  "company_id": 123,
  "deals": [{"deal_id": 9001, "amount": 109780}]
}'
```

振込手数料が引かれて入金が少ないときは、差額を `adjustment_deal` で新規取引にする。`deal_lines` の `amount` は符号付きで、明細の `entry_side` と符号で借方・貸方が決まる(公式の説明はここまで)。下の例は入金明細から手数料を差し引く想定で負にしている。符号の向きは、最初は 1 件で試して freee の画面で仕訳を確かめてから使う。

```sh
python3 $GW POST freee /api/1/wallet_txns/5001/reconcile --json '{
  "company_id": 123,
  "deals": [{"deal_id": 9001, "amount": 110000}],
  "adjustment_deal": {"deal_lines": [{"account_item_id": 701, "amount": -220, "description": "振込手数料"}]}
}'
```

- 未決済の取引は `GET /api/1/deals -q status=unsettled`(取引先や期日で絞る)で探す。取引の未決済の金額と明細の金額を突き合わせ、候補が 1 つに決まらなければユーザーに聞く。
- レスポンスは `{"wallet_txn_id", "deal_ids", "new_deal_id"}`。`new_deal_id` は `adjustment_deal` で作った取引(指定しなければ null)。
- 同じパラメータで送り直しても冪等に同じ結果が返る。明細が別の取引で消込済み、または取引が別の明細で決済済みなら 409。
- `adjustment_deal` の項目は `create_deal` のボディと同じ(`issue_date`、`ref`、`partner_id`、`deal_lines[]`)。

### 明細から取引を作る(create_deal)

```sh
python3 $GW POST freee /api/1/wallet_txns/5002/create_deal --json '{
  "company_id": 123,
  "partner_id": 456,
  "deal_lines": [{"account_item_id": 789, "tax_code": 136, "amount": 3300, "description": "10月分 サーバー代"}]
}'
```

- `deal_lines[].amount` は税込の符号付き整数(0 は不可)で、合計を明細の金額に合わせる。借方・貸方は明細の `entry_side` と符号で決まる。明細と同じ向きの通常の取引(出金明細の費用、入金明細の売上など)は正で書き、符号に迷う行は 1 件で試して画面で仕訳を確かめる。
- 行の任意項目: `tax_code`(省略時は勘定科目の既定の税区分)、`vat`(省略時は自動計算)、`tax_entry_method`(`in` 内税 / `out` 外税。どちらでも `amount` は税込)、`description`、`item_id`、`section_id`、`tag_ids`、`segment_1_tag_id`〜`segment_3_tag_id`、`partner_id`(内訳行ごとの取引先の設定が有効な事業所だけ)。
- 取引全体の任意項目: `issue_date`(明細の取引日以前。省略時は明細の取引日)、`ref`(管理番号、20 文字まで)、`partner_id`。
- レスポンスは `{"deal_ids": [...]}`。

### 口座振替にする(create_transfer)

口座間の資金移動(普通預金から定期預金、カードの引き落としなど)の明細。

```sh
python3 $GW POST freee /api/1/wallet_txns/5003/create_transfer --json '{
  "company_id": 123,
  "transfer_from_line": {"walletable_type": "bank_account", "walletable_id": 11},
  "transfer_to_lines": [{"walletable_type": "credit_card", "walletable_id": 22, "amount": 50000}],
  "charge_lines": [{"account_item_id": 701, "amount": 110, "line_type": "paid", "description": "振込手数料"}]
}'
```

- 振替元(`transfer_from_line`)は 1 口座、振替先(`transfer_to_lines`)は複数口座(同じ口座の重複は不可)。出金明細なら振替元に、入金明細なら振替先に、明細の口座を必ず入れる。
- 振替元から出る金額 = 振替先の `amount` の合計 + `charge_lines` の合計(`paid` は加算、`received` は減算)。明細の口座の金額は明細の金額と一致させる。
- `charge_lines[]` は手数料等: `account_item_id`、`amount`(正)、`line_type`(`paid` 支払手数料等 / `received` 受取利息等)が必須。`tax_code`、`vat`(税込経理の事業所では指定不可)、`description`、タグ類は任意。
- 振替元・振替先には `walletable_tags`(`item_id`、`section_id`、`partner_id`、`tag_ids`、セグメント)、振替先には `description` も付けられる。
- レスポンスは `{"wallet_txn_id", "transfer_ids": [...]}`。409 は明細が消込済みのときなど。

### プライベート取引・無視・未消込に戻す

```sh
python3 $GW POST freee /api/1/wallet_txns/5004/create_private_deal --json '{"company_id": 123}'   # → {"deal_id": ...}
python3 $GW POST freee /api/1/wallet_txns/5005/ignore --json '{"company_id": 123}'
python3 $GW POST freee /api/1/wallet_txns/5005/reset --json '{"company_id": 123}'
```

- `create_private_deal`: 勘定科目や金額の指定は要らない。個人事業主は事業主貸・事業主借、法人は役員貸付金・役員借入金で登録される。法人で使うときは、役員との貸し借りとして記帳してよいか必ずユーザーに確認する。
- `ignore`: 既に無視の明細でも 200(冪等)。消込済みの明細は無視できないので、先に `reset`。
- `reset`: 無視は解除、消込済みは消込を解除して未消込に戻す。既に未消込なら 200(冪等)。明細に紐づく仕訳が承認済み、または非同期処理中なら 400。消込で作られた取引が解除後にどうなるかは公式の説明にないので、解除したら取引の状態を `GET /api/1/deals/{id}` で確かめ、扱い(削除するか、別の明細で消込し直すか)をユーザーに確認する。

### 自動登録ルールを一括適用する(user_matchers/apply)

```sh
python3 $GW POST freee /api/1/user_matchers/apply --json '{"company_id": 123, "wallet_txn_ids": [5001, 5002, 5003]}'
```

- `wallet_txn_ids` は 1〜1000 件。事業所にない明細 ID が入っていると 400。未消込でない明細はスキップされる。
- 非同期で、レスポンスの時点では適用は終わっていない。しばらくしてから `GET /api/1/wallet_txns` で `status` と `rule_matched` を見て結果を確かめる。
- ルール自体は `GET /api/1/user_matchers`(`active`、`description`、`walletable` などで絞り込み)で確認できる。作成・更新・削除(`POST` / `PUT` / `DELETE /api/1/user_matchers/{id}`)もあるが、項目は公式リファレンスで確かめる。

## 振替(transfers)と振替伝票(manual_journals)

```
GET/POST        /api/1/transfers          # 口座間の資金移動(start_date、end_date)
GET/PUT/DELETE  /api/1/transfers/{id}
GET/POST        /api/1/manual_journals    # 仕訳を直接入力する振替伝票(start_issue_date、end_issue_date)
GET/PUT/DELETE  /api/1/manual_journals/{id}
```

## マスタ

```
GET /api/1/partners              # 取引先(keyword で名前などを検索)。POST / PUT / DELETE もある
GET /api/1/account_items         # 勘定科目(base_date でその日時点の一覧)
GET /api/1/sections              # 部門
GET /api/1/tags                  # メモタグ
GET /api/1/items                 # 品目
GET /api/1/segments/{segment_id}/tags   # セグメントタグ(segment_id は 1〜3)
GET /api/1/taxes/companies/{company_id} # 事業所で使う税区分(company_id はパスに入る)
GET /api/1/taxes/codes           # 税区分コードの一覧(company_id は不要)
GET /api/1/banks                 # 金融機関(company_id は不要)
```

各マスタには、ほぼ `/{id}` の取得と POST / PUT / DELETE がある。取引先の一覧は件数が多いことがあるので `freee_all.py` で取る。

## 証憑(receipts、ファイルボックス)

```
POST   /api/1/receipts        # アップロード(multipart)
GET    /api/1/receipts        # 一覧。start_date と end_date が必須
GET    /api/1/receipts/{id}   # 1 件
PUT    /api/1/receipts/{id}   # メモなどの更新
DELETE /api/1/receipts/{id}
```

アップロードは multipart で、`company_id` と `receipt`(ファイル)が必須。`description`(メモ)は任意。

```sh
python3 $GW POST freee /api/1/receipts -f company_id=123 --file receipt=invoice.pdf -f description='株式会社サンプル 9月分'
python3 $GW GET freee /api/1/receipts -q company_id=123 -q start_date=2026-09-01 -q end_date=2026-09-30
```

アップロードしても取引は自動で作られない。取引の登録はユーザーが freee の画面で行うのが基本(SKILL.md の「請求書 PDF をファイルボックスに上げる」を参照)。

## 経費申請・支払依頼・各種申請

申請は「一覧・取得・作成・更新・削除」に加えて、承認や却下を `POST .../{id}/actions` で行う。

```
/api/1/expense_applications       # 経費申請(status で絞り込み)
/api/1/payment_requests           # 支払依頼
/api/1/approval_requests          # 各種申請。フォームは /api/1/approval_requests/forms
/api/1/approval_flow_routes       # 申請経路(読み取りのみ)
```

`actions` のボディ(承認・却下・差し戻しの指定、対象の承認ステップなど)は公式リファレンスで確かめる。承認・却下は必ずユーザーに確認してから行う。

## レポート(試算表・総勘定元帳)

```
GET /api/1/reports/trial_bs                  # 貸借対照表
GET /api/1/reports/trial_pl                  # 損益計算書
GET /api/1/reports/trial_pl_sections         # 損益計算書(部門別)
GET /api/1/reports/trial_bs_two_years        # 前年比較(three_years もある。trial_pl も同様)
GET /api/1/reports/trial_cr                  # 製造原価報告書
GET /api/1/reports/general_ledgers           # 総勘定元帳(account_item_id など)
```

主なパラメータ: `company_id`、`fiscal_year`(会計年度)、`start_month` / `end_month`(会計年度の中の月)、`breakdown_display_type`(内訳の表示。`partner`、`item`、`section`、`account_item` など)。

```sh
python3 $GW GET freee /api/1/reports/trial_pl -q company_id=123 -q fiscal_year=2026 -q start_month=4 -q end_month=9 -o pl.json
```

## 仕訳帳のダウンロード(非同期)

```
GET /api/1/journals                                # 出力を依頼する(download_type、start_date、end_date)。レポートの ID が返る
GET /api/1/journals/reports/{id}/status            # 生成の状態
GET /api/1/journals/reports/{id}/download          # ファイル本体
```

`download_type` は `csv`、`pdf`、`generic_v2` など。状態を何秒か空けて確かめ、完了してから `-o journals.csv` で保存する。

## その他

```
GET /api/1/fixed_assets     # 固定資産(読み取り)
GET /api/1/quotations       # 旧来の見積書(読み取り)。新しい見積書・請求書は /iv を使う
GET /api/1/invoices         # 旧来の請求書(読み取り)
```
