# 送信・返信・下書き

Google の [送信仕様](https://developers.google.com/workspace/gmail/api/guides/sending)では、MIME メールを base64url にして JSON の `raw` に入れる。ローカルの `scripts/gmail_mime.py build` を使うと、日本語のヘッダー・本文や添付を扱える。スクリプト自体は API を呼ばない。

## 新規送信

送信元は `profile.emailAddress` または利用可能と確認した送信エイリアスを使う。本文を UTF-8 の `body.txt` に用意する。

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/gmail_mime.py" build --from sender@example.com --to recipient@example.com --subject '請求書の送付' --body @body.txt --attach invoice.pdf -o send.json
python3 "$GW" POST gmail /gmail/v1/users/me/messages/send --json @send.json
```

複数宛先は `--to` / `--cc` / `--bcc` を繰り返す。HTML は `--html @body.html`、複数添付は `--attach` を繰り返す。送信後は戻り値の `id` / `threadId` を記録する。トピック索引を使う組織では、送ったら Message-ID を取って記録する(下の「送ったメールの Message-ID」)。

## 送ったメールの Message-ID(トピック索引への記録)

トピック索引(`topic-index` スキル)を使う組織では、送った(返信した)あと、すぐ `record_sent` で記録する。`sent_ref` には RFC の Message-ID を山かっこつきで入れる。送信 API が返すのは Gmail のメッセージ `id` だけなので、送ったメッセージのヘッダーから取る。

```sh
python3 "$GW" GET gmail "/gmail/v1/users/me/messages/{送信の戻り値の id}" -q format=metadata -q metadataHeaders=Message-ID
```

- `payload.headers` の `name` が `Message-ID` の `value`(`<...@mail.gmail.com>` の形)を、そのまま `sent_ref` にする。山かっこを外さない。
- 返信なら、元のメールの Message-ID を `anchors.in_reply_to` に、元のトピックを `reply_to_thread_id` に入れる。
- 下書きを送ったときは、`drafts/send` の戻り値の `id`(メッセージの ID。下書きの ID ではない)で同じように取る。
- 送れたと確かめたあとに呼ぶ。送れなかった・確かめられないものは記録しない。

## 下書き

`build` に `--draft` を付けると `{"message":{"raw":"..."}}` を作る。POST `/gmail/v1/users/me/drafts` で保存。GET `/gmail/v1/users/me/drafts/{draft-id}` で確認。保存済み下書きの送信は POST `/gmail/v1/users/me/drafts/send` に `{"id":"<draft-id>"}`。下書き ID と message ID を取り違えない。

## 返信

元メールを取得し、Gmail の `threadId`、RFC の Message-ID、References、Subject、Reply-To / From を確認する。返信先は Reply-To があればそれを優先し、全員に返信する依頼なら To / Cc から自分を除いて宛先を決める。

`build` に `--thread-id <threadId> --in-reply-to '<RFC-Message-ID>' --references '<既存 References と元 Message-ID>'` を付け、件名は元の件名と対応させる。References がなければ元 Message-ID のみでよい。`--thread-id` と `--in-reply-to` は両方必要。返信は新規送信と同じ `/messages/send`、下書きなら `--draft` と `/drafts` を使う。[スレッドへの追加条件](https://developers.google.com/workspace/gmail/api/guides/threads)。

送信リクエストのエラー後に自動で再送しない。元 MIME の Message-ID を取り出し、`in:sent rfc822msgid:...` の検索などで送信済みか確認する。
