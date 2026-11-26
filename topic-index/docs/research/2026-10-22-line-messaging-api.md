# LINE 公式アカウントを Messaging API でつなぐときの調べ（2026-10-22）

- 目的: 0016 の最初のデータソースを UBS 側に決めたあと、UBS の LINE 公式アカウントをつなぐのにどれだけ要るかを見積もる。0012 の未決 2（自分の送信が webhook で返るか）にも答える
- 調べ方: WebSearch（LINE Developers の公式ドキュメント・ニュースと、外部連携ツールの解説）。**実物ではまだ確かめていない**
- 関連: 0012（外に書かない。未決 2）、0016（段取り 6「LINE が自分の push を webhook で返すか」、段階 5 の最初のデータソース）、0013（LINE 公式アカウントは共有のデータソース）

## 分かったこと

1. **管理画面のチャットと Webhook は併用できる（公式）。** 2022-11-30 から、LINE Official Account Manager の応答設定で「チャット」と「Webhook」を両方オンにできる。
   それより前は「応答モード」で Bot かチャットのどちらか一方だった。Messaging API をつないでも、木村さんの管理画面でのチャットは今のまま使える。
   直樹は「Messaging API をつなぐとチャットが無効になる」と覚えていた（旧仕様）。併用できるので、チャット機能を作り直す必要はない
2. **過去の会話を取る API はない。** webhook が有効になってから届いたイベントしか受け取れない。後から取り直せないので、受け口は届いたイベントを全部その場で貯める必要がある。
   画像などの中身は、webhook で受けたメッセージ ID で取得できる（公式のリファレンス）。根拠のうち「過去を取れない」は外部連携ツールのドキュメントで、公式の明記は見つけていない
3. **管理画面から送ったメッセージは webhook に来ない。** webhook はユーザー側の操作（友だち追加・メッセージなど）が起点。外部連携ツールのドキュメントも、管理画面から直接送った分は連携先に届かないと書いている。
   自分で push したメッセージも返らない見込み（0012 の未決 2 の答え。ただし公式の明記は見つけていない）
4. **Webhook URL は 1 アカウントに 1 つだけ。** UBS のアカウントで拡張ツールが既に webhook を使っていたら、受け口からそちらへも転送する必要がある

## Murmur への帰結（案）

- **受け口は受信だけでよい**: ゲートウェイの上流サービスとして、webhook を受けて署名を確かめ、イベントを貯めて Murmur に流す。チャネルのシークレットとアクセストークンは受け口だけが持ち、Murmur 本体には入れない（0012）。
  読み取り専用で始められる（0007）。push の送信（スタンドが送って `record_sent` する経路）は、スタンドから LINE で送りたくなってから足す
- **木村さんの返事は Murmur から見えない**: 管理画面で返した分は観測されないので、LINE の観測された送信はない。LINE では H5 の「観測と記録の統合」は効かず、ボールは記録か手の操作（片付け）でしか動かない。
  返事を見えるようにするには、スタンド経由で push して `record_sent` するしかない（push は月の無料メッセージ数を消費する）。どちらにするかは段階 5 の前に決める
- **シナリオとのずれ**: `fixtures/absence` の o02（「LINE の管理画面から山本さんへ直接返した」）は観測された送信として届く前提になっているが、実物では届かない。シナリオは今は直さない（実データで決めたあとで）

## 実物で確かめること

- UBS のアカウントの応答設定に「チャット」と「Webhook」の両方が出て、両方オンにできるか（古い設定のままだと変わりうる）
- UBS のアカウントで、拡張ツールなどが既に Webhook URL を使っていないか
- 管理画面から返したメッセージと、push したメッセージが webhook に来ないこと

## 出典

- LINE Developers「LINE公式アカウントでWebhookとチャットが併用できるようになりました」 https://developers.line.biz/ja/news/2022/12/01/use-both-chats-and-webhooks/
- LINE Developers「メッセージを受信する」 https://developers.line.biz/ja/docs/messaging-api/receiving-messages/
- LINE Developers「Messaging API リファレンス」 https://developers.line.biz/en/reference/messaging-api/
- Qiita「LINE公式アカウントの応答設定についてのよくある質問と回答」 https://qiita.com/stachibana/items/3e1a9ef6089367272d0e
- L Message「LINE公式アカウントのWebhookとは？」 https://lme.jp/media/line/webhook/
- Kylon「LINE Official Account」 https://docs.kylon.io/connections/line-official-account
- Zaapi「LINE limitations」 https://help.zaapi.com/integrations/line/limitations
