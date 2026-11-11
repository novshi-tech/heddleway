---
name: gmail
description: Gmail のメール検索・取得・送信・返信・下書き・ラベル操作と添付ファイルの保存を Heddleway 経由で行う。ゲートウェイに登録された Google アカウントの Gmail を操作する依頼で使う。
---

# Gmail API

`heddleway` スキルでサービス `gmail` の認証情報を選び、`issue_token` の `token` と `base_url` を `GW_TOKEN` / `GW_BASE_URL` に設定する。上流の Google トークンはゲートウェイが管理する。

接続はサービスごとに 1 つ。複数の組織のゲートウェイがつながっていれば、`heddleway` スキルの「コネクタの選び方」で組織のコネクタを選ぶ。必要なら `GET /gmail/v1/users/me/profile` の `emailAddress` で対象アカウントを確かめる。Drive と合わせて使う場合は `drive` の認証情報も別に選ぶ。共通の OAuth クライアント ID は、同じ接続アカウントを意味しない。

## 呼び出す

単発の取得・更新・送信は共通の `gw_request.py`、一覧のページングは `scripts/gmail_all.py` を使う。スクリプトは Python 標準ライブラリだけで動き、プラグイン付きのスキルディレクトリ名にも対応する。

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 "$GW" GET gmail /gmail/v1/users/me/profile
python3 "$GW" GET gmail /gmail/v1/users/me/messages -q 'q=has:attachment filename:pdf' -q maxResults=10
python3 "$GW" GET gmail /gmail/v1/users/me/messages/{message-id} -q format=full -o message.json
python3 "${CLAUDE_SKILL_DIR}/scripts/gmail_all.py" /gmail/v1/users/me/messages -q 'q=is:unread' --csv id,threadId -o unread.csv
```

- パスは `/gmail/v1/...`。`me` は選んだ認証情報の Google アカウント。
- 一覧の `messages` は ID と `threadId` のみ。本文・件名・差出人が必要なら各 ID を `messages.get` で取得する。`resultSizeEstimate` は概数。
- `nextPageToken` を `pageToken` として同じ検索条件で渡す。`gmail_all.py` は JSON 配列 / CSV を保存する。`--max-pages` 到達の警告があれば全件取得とは報告しない。
- 本文や添付の `data`、送信の `raw` は base64url。バイナリや長い encoded data は会話に出さずファイルに保存する。

## 詳細

- 検索、本文、ラベル、添付: [references/mail.md](references/mail.md)
- 送信、返信、下書き、MIME の生成: [references/send.md](references/send.md)

## 実行範囲とエラー

送信・返信・削除・ラベル変更はユーザーの依頼の範囲で実行する。組織がトピック索引を使っているなら、送ったあと `topic-index` スキルで記録する(Message-ID の取り方は [references/send.md](references/send.md))。宛先や対象が未指定なら確認する。明示的な実行指示がある操作に、重ねて承認を求めない。送信のタイムアウト後は成功した可能性があるため、送信済みメールを確認してから判断し、無条件に再送しない。

現在の `gmail.modify` で通常の読み書き・送信はできるが、完全削除や一部設定は別のスコープが必要。依頼のない権限拡張をしない。403 は Google のエラー本文を確認する。ゲートウェイの再接続エラーなら `register_url` またはエラー内の URL を案内する。429 / 503 の GET は付属の一覧スクリプトが上限付きで再試行する。
