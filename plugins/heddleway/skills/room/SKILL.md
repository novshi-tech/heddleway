---
name: room
description: Heddleway Room(軽い会議室。アジェンダの画面同期、音声だけの通話、話している人ごとのサーバー録音)を API ゲートウェイ経由で使う。会議室の一覧・作成、アジェンダ(項目ごとの HTML)の組み立てと配置、写真・動画・PDF の添付のアップロード、会議の結果(項目をいつ映したか、メモ、参加者と通話の出入り)の取得、録音(1 人 1 ファイルの WAV)のダウンロードと、結果の時刻との突き合わせを扱う。「会議室にアジェンダを置いて」「定例のアジェンダを作って」「この写真もアジェンダに出して」「さっきの会議の結果を見せて」「録音を取ってきて」「会議の議事録を作って」などの依頼で使う。
---

# Heddleway Room

Heddleway Room は、組織の Heddleway に依存する別のアプリ。司会が選んだ項目が全員の画面に出て、音声だけで話せて、話している人の声をサーバーが 1 人 1 ファイルで録る。会議室がやるのは「アジェンダを受け取る」から「会議の結果を渡す」まで。アジェンダを作る材料集め、文字起こし、要約、ほかのサービスの更新は Claude がやる。

トークンの発行とスクリプトの基本は `heddleway` スキルに従う。サービス名は `room`、認証情報は `identity:room`(サインイン中の人として呼ぶ。登録は要らない)。`list_credentials` に `room` がなければ、その組織には Room がデプロイされていない。

## 手順

1. `issue_token` に `identity:room`(と、材料を集めるサービスの認証情報)を渡し、`GW_TOKEN` と `GW_BASE_URL` を設定する。
2. 会議室を決める。`room.py rooms` で一覧し、なければ `room.py create "<名前>"`。会議室の ID(10 文字)と画面の URL(`GET /rooms/{id}` の `url`)は、毎回聞かずに済むよう、ユーザーのメモリやプロジェクトの記録に残す。
3. 添付があれば先に上げる(下の「添付」)。
4. アジェンダの JSON を作る(下の「アジェンダ」)。
5. `room.py put-agenda <room> agenda.json` で置く。新しい会議が始まり、前の会議は終わる。会議中の画面にもすぐ出る。
6. 画面の URL をユーザーに伝える。
7. 会議のあとは「会議の結果」と「録音」で受け取る。

```sh
export GW_TOKEN='<token>' GW_BASE_URL='<base_url>'
S=${CLAUDE_SKILL_DIR}/scripts
python3 $S/room.py rooms
python3 $S/room.py upload <room> photos/*.jpg --prefix ABC-12-      # 名前の衝突を避ける接頭辞
python3 $S/room.py put-agenda <room> agenda.json
python3 $S/room.py result <room> latest -o result.json
python3 $S/room.py recordings <room> latest -d recordings/
```

小さい呼び出し(一覧、結果を 1 回見る)は `api_get` でもよい。アジェンダの PUT とファイルのアップロードはスクリプトで。

## API

ベースは `<base_url>/room`。

| メソッド | パス | 中身 |
| --- | --- | --- |
| GET | `/rooms` | 会議室の一覧 |
| POST | `/rooms` | 会議室を作る。`{"name": "日次定例"}` |
| GET | `/rooms/{id}` | 会議室、画面の URL、いまの会議(司会・表示中の項目・終わったか) |
| PUT | `/rooms/{id}/agenda` | アジェンダを置く(新しい会議が始まる) |
| GET | `/rooms/{id}/meetings` | 会議の一覧(新しい順、60 件まで)。`startedAt`・`endedAt` |
| GET | `/rooms/{id}/meetings/{meetingId}/result` | 会議の結果。`latest` で最新 |
| GET | `/rooms/{id}/meetings/{meetingId}/recordings/{recId}` | 録音(WAV) |
| PUT | `/rooms/{id}/files/{name}` | ファイルを置く(本文が中身。`Content-Type` を付ける。95 MB まで) |
| GET / DELETE | `/rooms/{id}/files`、`/rooms/{id}/files/{name}` | ファイルの一覧・削除 |

## アジェンダ

```json
{
  "title": "日次定例 11/27(金)",
  "items": [
    {"id": "ABC-12", "label": "佐藤 ・ 更新", "title": "〇〇ビル 漏水の件", "url": "https://...", "html": "<p>...</p>"}
  ]
}
```

- `title` は会議の名前。日付を入れると、会議の一覧で見分けやすい。
- 項目は 100 個まで、全体で 1.5 MB まで。`id` は英数字と `. _ : -`、64 文字まで(省くと順番の番号)。元の課題のキーを使うと、結果と突き合わせやすい。
- `title` は必須で 200 文字まで。`label` は一覧と項目の上に出る短い札(担当者や種類)。`url` は `https://` だけで、「元を開く」のリンクになる。
- `html` は 1 項目 50,000 文字まで。スクリプトを動かさない `iframe` に出る。
  - `<style>` は使える。外部の CSS・フォント・スクリプトは読めない。
  - 画像は `https:` か、会議室のファイル(`/r/<room>/files/<name>`)。動画は会議室のファイルだけ。
  - 見る人の多くはスマホ。横に広い表を避け、`table{width:100%}` と折り返しで縦に読める形にする。文字の色は背景によらず読める中間色(`#888`)か、色を指定しない。ライト/ダークの両方で読めること。
- 項目の順番がそのまま会議の進行になる。「前へ・次へ」で 1 つずつ進み、番号で一覧から飛べる。話す単位で 1 項目にし、動きのない多数の件は 1 項目の表にまとめる。

## 添付

写真・動画が判断の材料になる件(現場の写真など)は、会議室に上げて項目の中に出す。元のサービスの URL はサインインが要って画面に出ないことが多い。

- 写真: 長辺 1600px の JPEG(品質 80 前後)に縮める。1 件 12 枚くらいまで。
- 動画: スマホで再生できる 720p の H.264(`ffmpeg -i in.mov -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart out.mp4`)。
- PDF はそのまま上げ、リンクにする。
- 名前は英数字と `. _ -`、128 文字まで。`room.py upload` は名前を整え、`--prefix` を付け、`path` の一覧を JSON で出す。HTML では `<img src="/r/<room>/files/<name>">`、`<video controls playsinline preload=metadata src="...">` と書く。
- ファイルは会議室ごとの置き場にあり、30 日で消える。

## 会議の結果

`result` が返すもの:

- `meeting`: `id`、`startedAt`、`endedAt`(司会が「会議を終える」を押すか、次のアジェンダが置かれた時刻。まだなら `null`)
- `items[]`: `id`、`title`、`shown`(画面に出ていた区間 `{from, to}` の一覧)、`notes`(画面で残したひとことメモ)
- `participants`: 画面の出入り(`join` / `leave`)
- `call`: 通話の出入り(`talk` 話す、`muted` ミュート、`listen` 聞くだけ、`out` 出た)
- `recordings[]`: `recId`、`user`、`startedAt`(録音の 0 秒目の時刻)、`endedAt`、`seconds`、`state`(`done` ならダウンロードできる。`recording`・`stopping` は書き込み中)、`path`
- `audio`: `{"format": "wav", "sampleRate": 16000, "channels": 1}`

時刻はすべて UTC の ISO 8601。ユーザーに見せるときは、ユーザーの時間帯に直す。

## 録音

- 「通話に入る」で話している人(ミュート中も含む)のマイクを、会議の間だけ 1 人 1 ファイルで録る。「聞くだけ」の人は録らない。録音中は全員の画面に「録音中」が出る。
- 通話を出て入り直すと、ファイルが分かれる。同じ人のファイルは `startedAt` の順に並べる。
- ファイルは壁時計に合っている。途中で切れた間は無音で埋まる。ファイルの t 秒目は `startedAt + t` の時刻で、`items[].shown` と突き合わせれば、どの項目の話かが分かる。
- 文字起こしは会議室ではやらない。使える手段で起こし、話者はファイルの `user` で決める。区間ごとに項目へ振り分けると、項目ごとの議事録になる。
- 終わってすぐは `state` が `stopping` のことがある。数十秒待って取り直す。

## 注意

- アジェンダの PUT は、会議中の全員の画面を切り替える。会議の最中に置き直すときは、ユーザーに確かめてから。
- 録音とファイルは 30 日で消える。残す必要があるものは、ユーザーの決めた置き場に移す。
