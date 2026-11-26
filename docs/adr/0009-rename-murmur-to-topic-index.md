# 0009 内部の名前 Murmur をトピック索引(topic-index)にそろえる

- 状態: 採用(2026-11-25、直樹)
- 関連: [0005](0005-murmur-as-a-feature.md)(機能として持つ)、[0008](0008-narrow-grants-for-apps.md)(アプリの使える口)、トピック索引の [`0040`](../../topic-index/docs/adr/0040-surface-vocabulary.md)(表の言葉)

## 背景

表の名前は「トピック索引」だが、モジュール(`murmur/`)、機能の名前(`murmur`)、URL(`/features/murmur`・`/api/murmur/...`・`/murmur/webhooks/...`)、`identity:murmur` に内部の名前 Murmur が残っていた。利用者に案内した画面の URL にも出ていて、名前が 2 つあるように見える。

## 決定

1. 機能の名前を `topic-index` にする。画面は `/features/topic-index`、API は `/api/topic-index/...`、公開の経路(Webhook・同意の戻り先・管理画面)は `/topic-index/...`、認証情報は `identity:topic-index`。モジュールは `topic-index/`(パッケージ名も)、ゲートウェイの入口は `src/topic-index-feature.ts`、コードの識別子は `TopicIndex…`
2. 古い名前は互換のために受け続ける。`Feature.formerNames` に `murmur` を持たせ、ゲートウェイの中核が次のように扱う
   - `/features/murmur/...` は `/features/topic-index/...` に 301 で移す(経路とクエリはそのまま)
   - `/api/murmur/...` と `/murmur/...` はそのまま機能に届く。Graph のサブスクリプションと Jira の Webhook は登録した通知先の URL を持ち続けるため。通知先が変わると見回りが作り直す作りなので(Graph は `planMaintenance` の `notificationUrl`、Jira は URL のハッシュ)、次の見回りで新しい URL に移る
   - `issue_token` に `identity:murmur` を渡すと、`identity:topic-index` として発行する。`list_credentials` には新しい名前だけを出す。古い名前で発行済みのトークンも通す
   - 本人の同意(UserVault の `consent:murmur`)は有効として数える。有効・無効にし直すと新しい名前だけに記録する
   - アプリの使える口(Registry に保存した定義)に `murmur` があれば、トピック索引の口として扱う
   - ローカルサービスは古い名前でも登録できない
3. デプロイの設定の名前(`MURMUR_DB`・`MURMUR_QUEUE`・`MURMUR_*` の vars とシークレット、D1 とキューの実体の名前)は今回は変えない。利用者には見えず、シークレットは値を読み戻せないので入れ直しが要り、D1 の実体の名前を変えるにはデータの移し替えが要る。新しく作るデプロイの D1 とキューの名前の例だけ `<名前>-topic-index` にした
4. 過去の ADR・調べもの・振り返りの本文は、書いた時点の記録として Murmur のまま残す(リンクの切れるパスだけ直した)。生きている文書(README、CLAUDE.md、申し送り、計画、手順、スキル)は「トピック索引」にそろえた

## 結果

- 配布済みのプラグイン(heddleway 0.33.0 まで)は `murmur` を使い続けても動く。0.34.0 のスキルは `topic-index` を使い、古いゲートウェイ(`identity:murmur` しか出さない)では `murmur` に読み替える
- 古い名前を外すのは、すべてのデプロイで Webhook が新しい URL に移り、古いプラグインが使われなくなってから。外すときは `formerNames` を消すだけ
