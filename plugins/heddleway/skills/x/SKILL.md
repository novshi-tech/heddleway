---
name: x
description: X(旧 Twitter)の API v2 を API ゲートウェイ経由で、接続したユーザー本人として呼び出す。ポストの検索(直近 7 日)・取得、ユーザーの検索とプロフィール・ポスト一覧・メンション、ホームタイムライン、ポストの投稿・返信・引用・削除、画像の添付、いいね・リポスト・ブックマーク、フォロー・フォロワーとリストの確認を扱う。「X で○○についてのポストを検索して」「このアカウントの最近のポストを見せて」「自分へのメンションを確認して」「X に投稿して」「このポストに返信して」「いいねして」「ブックマークを一覧して」などの依頼で使う。
---

# X API v2

X の API v2 を、API ゲートウェイ経由で呼び出す。トークンの発行とスクリプトの基本的な使い方は、`heddleway` スキルに従う。API はつないだユーザー本人として動く(投稿・いいねなどは、その人のアカウントで行われる)。

## 手順

1. `heddleway` スキルの手順で、サービス `x` の認証情報を選んでトークンを発行し、`GW_TOKEN` と `GW_BASE_URL` を設定する。
   - 認証は OAuth 2.0。ユーザーがゲートウェイの Web 画面で X をつなぐ。出てこないときは、管理者がまだ X のアプリのクライアントを登録していない(README の「X」)。
2. このスキルの `scripts/gw_request.py`(共通の `heddleway` スキルと同じもの) で呼び出す。パスは `/2/...` で始まる。
3. 自分のユーザー ID が要るエンドポイント(いいね・ブックマーク・タイムラインなど)は、先に `/2/users/me` で `data.id` を調べる。

```sh
GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"
python3 $GW GET x /2/users/me -q user.fields=username,name,public_metrics
python3 $GW GET x /2/tweets/search/recent -q "query=heddleway lang:ja -is:retweet" -q max_results=20 \
  -q tweet.fields=created_at,public_metrics,author_id -q expansions=author_id -q user.fields=username,name
python3 $GW POST x /2/tweets --json '{"text": "こんにちは"}'
```

## 書き込みの前に

投稿・返信・削除・いいね・リポスト・ブックマークは、つないだ人のアカウントで公開される(削除以外は取り消しても通知が残ることがある)。**送る前に、本文と宛先(返信先のポスト)をユーザーに見せて確認を取る。** 会話の流れで頼まれていても、文面を Claude が書いたなら必ず見せる。

## 返ってくる項目を指定する

v2 は、指定しないと最小限の項目(ポストなら `id`・`text`・`edit_history_tweet_ids`)しか返さない。必要なものをクエリで頼む。

- `tweet.fields`: `created_at`、`author_id`、`public_metrics`(いいね・リポスト・返信・表示の数)、`conversation_id`、`in_reply_to_user_id`、`referenced_tweets`、`entities`、`lang`、`note_tweet`(長文ポストの全文)
- `user.fields`: `username`、`name`、`description`、`created_at`、`public_metrics`(フォロワー数など)、`verified`
- `expansions`: 関連するオブジェクトを `includes` に入れる。`author_id`(投稿者のユーザー)、`referenced_tweets.id`(引用元・返信先)、`attachments.media_keys`(画像)。`includes.users` を `author_id` で引き当てて、`@username` を表示する。
- `media.fields`: `url`、`preview_image_url`、`type`、`alt_text`(`expansions=attachments.media_keys` と一緒に)

## 主なエンドポイント

| 目的 | メソッドとパス | 要点 |
|---|---|---|
| 自分 | `GET /2/users/me` | |
| ユーザーを名前で | `GET /2/users/by/username/{username}` | `@` は付けない。複数は `GET /2/users/by?usernames=a,b` |
| ユーザーのポスト | `GET /2/users/{id}/tweets` | `max_results` 5〜100。`exclude=retweets,replies`。`start_time`・`end_time`(ISO 8601) |
| メンション | `GET /2/users/{id}/mentions` | 自分の ID で、自分宛てのポスト |
| ホームタイムライン | `GET /2/users/{id}/timelines/reverse_chronological` | 自分の ID のみ |
| 検索(直近 7 日) | `GET /2/tweets/search/recent` | `query` は必須。`max_results` 10〜100。`sort_order=recency` か `relevancy` |
| ポストの取得 | `GET /2/tweets/{id}`、`GET /2/tweets?ids=1,2` | ids は 100 件まで |
| 投稿 | `POST /2/tweets` | 下の「投稿」 |
| 削除 | `DELETE /2/tweets/{id}` | 自分のポストのみ |
| いいね / 取り消し | `POST /2/users/{自分の id}/likes`(`{"tweet_id": "..."}`) / `DELETE /2/users/{自分の id}/likes/{tweet_id}` | |
| いいねしたポスト | `GET /2/users/{id}/liked_tweets` | |
| リポスト / 取り消し | `POST /2/users/{自分の id}/retweets`(`{"tweet_id": "..."}`) / `DELETE /2/users/{自分の id}/retweets/{tweet_id}` | |
| ブックマーク | `GET`・`POST /2/users/{自分の id}/bookmarks`(`{"tweet_id": "..."}`)、`DELETE /2/users/{自分の id}/bookmarks/{tweet_id}` | 自分の ID のみ |
| フォロー中・フォロワー | `GET /2/users/{id}/following`、`GET /2/users/{id}/followers` | 読み取りのみ(フォローする権限は付けていない) |
| リスト | `GET /2/users/{id}/owned_lists`、`GET /2/lists/{id}/tweets` | 読み取りのみ |
| 画像のアップロード | `POST /2/media/upload` | 下の「画像を添付する」 |

ID はすべて文字列で扱う(64 ビットの整数なので、数値にすると丸まる)。ポストの URL `https://x.com/<username>/status/<id>` の末尾が ID。

## 検索の query

- キーワードは空白区切りで AND、`OR` で OR、`-` で除外、`"..."` で完全一致、`( )` でまとめる。
- 演算子: `from:username`、`to:username`、`@username`、`#hashtag`、`lang:ja`、`is:retweet`、`is:reply`、`is:quote`、`has:media`、`has:links`、`url:example.com`、`conversation_id:<id>`(スレッドの返信を集める)。
- 元のポストだけを見たいときは `-is:retweet` を付ける。query は 512 文字まで(プランで異なる)。
- 直近 7 日より前は `search/recent` では取れない(全期間の検索 `search/all` は上位のプランのみ)。

## ページング

レスポンスの `meta.next_token` が次のページの合図。

- 検索(`/2/tweets/search/recent`)は、次の呼び出しで `next_token=<値>` を付ける。
- ユーザーのポスト・メンション・タイムライン・いいね・フォロワーなどは、`pagination_token=<値>` を付ける。
- `meta.next_token` がなければ最後。件数の多い取得は、ユーザーに必要な件数を確かめて、その分だけ取る(下の「料金と制限」)。

## 投稿

```sh
# 返信
python3 $GW POST x /2/tweets --json '{"text": "ありがとうございます!", "reply": {"in_reply_to_tweet_id": "1234567890"}}'
# 引用
python3 $GW POST x /2/tweets --json '{"text": "これは便利", "quote_tweet_id": "1234567890"}'
# 本文はファイルからも渡せる(改行や引用符が多いとき)
python3 $GW POST x /2/tweets --json @post.json
```

- 成功すると 201 で `data.id` と `data.text` が返る。ユーザーに `https://x.com/<自分の username>/status/<id>` を伝える。
- 本文は 280 文字まで(日本語などの全角文字は 1 文字を 2 と数えるので、およそ 140 文字)。URL は長さに関係なく 23 文字分。長い文はスレッドに分け、2 つ目以降を直前のポストへの返信として投稿する。
- 同じ本文を続けて投稿すると、重複として 403 で断られる。

## 画像を添付する

1. 画像をアップロードして、メディア ID を得る。

   ```sh
   python3 $GW POST x /2/media/upload -f media_category=tweet_image --file media=photo.png
   ```

   レスポンスの `data.id` がメディア ID。画像は 5 MB まで(PNG・JPEG・WEBP。GIF は 15 MB)。代替テキストは `POST /2/media/metadata` に `{"id": "<メディア ID>", "metadata": {"alt_text": {"text": "..."}}}`。

2. ポストの `media.media_ids` に入れて投稿する(4 枚まで)。

   ```sh
   python3 $GW POST x /2/tweets --json '{"text": "今日の写真", "media": {"media_ids": ["1880000000000000000"]}}'
   ```

動画や大きなファイルは、分割アップロード(`/2/media/upload/initialize` → `/2/media/upload/{id}/append` → `/2/media/upload/{id}/finalize`)が要る。必要になったら、X の公式ドキュメント(docs.x.com)で最新の手順を確かめてから行う。

## 料金と制限

- X の API は従量課金(または契約のプランの上限つき)。読み取りも書き込みも、呼び出しや取得したポストの件数に応じて費用やクォータを消費する。同じ取得を繰り返さず、結果はファイルや会話に残して使い回す。`max_results` は必要な分だけにする。
- レート制限はエンドポイントごとに 15 分あたりの回数で決まる。レスポンスヘッダーの `x-rate-limit-remaining` と `x-rate-limit-reset`(UNIX 時刻)で残りを確かめる。429 が返ったら、`x-rate-limit-reset` まで待つ。
- アクセストークンは 2 時間で切れるが、ゲートウェイが自動で更新する。

## よくあるエラー

- 401: 接続が切れている。ユーザーに Web 画面で X をつなぎ直してもらう。
- 403 で `client-forbidden` や `client-not-enrolled`: X の開発者ポータルで、アプリがプロジェクトに入っていないか、プランでそのエンドポイントが使えない。管理者に確かめてもらう。
- 403 で権限(scope)の不足: ゲートウェイが頼んでいない権限(DM・フォローする操作など)。README の「X」のとおり、デプロイの設定で `x` を上書きしてスコープを足し、つなぎ直す。
- 429: レート制限か、月間のクォータの使い切り。`x-rate-limit-reset` を見て待つか、ユーザーに伝える。
- 200 でも `errors` が入っていることがある(一部のポストが削除済み・非公開など)。`data` と合わせて確かめる。
