import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// D1（SQLite）のスキーマ（0021）。1 デプロイ = 1 チームなので、テナントの列は持たない。
// JSON は TEXT に入れ（drizzle が読み書きで変換する）、時刻は ISO 8601 の文字列で持つ。

// ---- イベントストア（正） ----

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    at: text('at').notNull(),
  },
  (t) => [index('events_type_idx').on(t.type)],
);

// ---- 投影（いつでも消してイベントから作り直せる） ----

/** 1 行だけ（id = 1） */
export const projectionMeta = sqliteTable('projection_meta', {
  id: integer('id').primaryKey(),
  lastSeq: integer('last_seq').notNull(),
  /**
   * 使っていない（0046 の決定 2。索引は signal_keys の行にし、読み込みではシグナルから作り直す）。
   * 0046 より前のコードが読むので、列は残し、新しく作る行には空の索引を書く。消すときはマイグレーションを作る
   */
  idx: text('idx', { mode: 'json' }).notNull(),
});

/** スレッド（エンティティはスレッドの 1 種類、0014） */
export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    dataSourceId: text('data_source_id').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    /** 写しのソースの区切り（`Thread.sourceKey`）。写しの置き先を課題キーで引く（0046 の決定 1 の段 2） */
    sourceKey: text('source_key'),
    /** 最後のシグナルの時刻（向きは問わない）。AI に渡す候補を窓で絞る（0046 の決定 4） */
    lastSignalAt: text('last_signal_at'),
    /** 外していない名指しが残っている（`attention.named` が空でない）。返事待ちの上位集合（0046 の決定 3） */
    namedPending: integer('named_pending', { mode: 'boolean' }).notNull().default(false),
    /**
     * 期限の見回りの候補（0046 の未決 3）。返事期待の期限（片付け・ソースで完了・期限超過済み・返事期待なしなら null）。
     * 返事期待が続いているか（名指しが外れていないか）はクエリ層が決めるので、これは候補の上位集合
     */
    replyDue: text('reply_due'),
  },
  (t) => [
    index('threads_data_source_idx').on(t.dataSourceId),
    index('threads_source_key_idx').on(t.dataSourceId, t.sourceKey),
    index('threads_last_signal_idx').on(t.dataSourceId, t.lastSignalAt),
    index('threads_named_pending_idx').on(t.dataSourceId, t.namedPending),
    index('threads_reply_due_idx').on(t.replyDue),
  ],
);

export const signals = sqliteTable(
  'signals',
  {
    id: text('id').primaryKey(),
    dataSourceId: text('data_source_id').notNull(),
    threadId: text('thread_id'),
    data: text('data', { mode: 'json' }).notNull(),
  },
  (t) => [index('signals_thread_idx').on(t.threadId)],
);

/**
 * 外していない名指しの索引（0046 の決定 3）。スレッドの名指しのうち、外していないもの（`hasPendingNaming` と同じ規則）のアドレス。
 * 返事待ちの候補を、受信の送り主のアドレスで引く。スレッドを保存するたびに、そのスレッドの行を入れ替える
 */
export const threadNamed = sqliteTable(
  'thread_named',
  {
    threadId: text('thread_id').notNull(),
    /** `addressKey`（チャネルと、小文字にした値） */
    addressKey: text('address_key').notNull(),
    dataSourceId: text('data_source_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.addressKey] }), index('thread_named_address_idx').on(t.dataSourceId, t.addressKey)],
);

/**
 * シグナルの索引（0046 の決定 2）。データソースの中の値 → その値を持つ最新のシグナル（seq の大きいもの）。
 * kind: sourceRef（重複排除）・messageId（記録との統合・In-Reply-To・引用）・threadKey（ソースの区切り）・threadTs（同じスレッド）。
 * シグナルの記録から決まる投影なので、いつでも作り直せる。行は消えない（シグナルが消えないので）
 */
export const signalKeys = sqliteTable(
  'signal_keys',
  {
    dataSourceId: text('data_source_id').notNull(),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    signalId: text('signal_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [primaryKey({ columns: [t.dataSourceId, t.kind, t.value] })],
);

// ---- マスタ ----

/**
 * マスタは seed.json の形をそのまま 1 行ずつ置く（kind = users / contacts ...）。
 * key は kind の中で一意（rowKey）。ord は並び順で、足した行は末尾（0030 の 5。その場で書き換える）
 */
export const master = sqliteTable(
  'master',
  {
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    ord: integer('ord').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

/** マスタの変更の記録（0030 の 5）。誰がいつ何を変えたか。before が null なら足した、after が null なら消した */
export const masterChanges = sqliteTable('master_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(),
  actorUserId: text('actor_user_id'),
  reason: text('reason'),
  kind: text('kind').notNull(),
  key: text('key').notNull(),
  before: text('before', { mode: 'json' }),
  after: text('after', { mode: 'json' }),
});

// ---- ダミー上流 ----

/** ダミーコネクタの受信キュー（データソースごとに pull で返す） */
export const dummyQueue = sqliteTable('dummy_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dataSourceId: text('data_source_id').notNull(),
  message: text('message', { mode: 'json' }).notNull(),
  consumed: integer('consumed', { mode: 'boolean' }).notNull().default(false),
});

// ---- 取り込みの運用の状態（0024）。台帳ではないのでイベントにしない。リプレイの対象外 ----

/**
 * 使っていない（0023 の段取り 4 で、別の Worker の Murmur が持っていたゲートウェイの OAuth のトークンをやめた。
 * 同意はゲートウェイの保管庫が持つ）。消すときはマイグレーションを作る
 */
export const gatewayGrants = sqliteTable('gateway_grants', {
  userId: text('user_id').primaryKey(),
  version: integer('version').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
});

/** 同意の途中（state → 本人と、つなぐ途中の頼み）。コールバックで取り出して消す */
export const oauthPending = sqliteTable('oauth_pending', {
  state: text('state').primaryKey(),
  createdAt: text('created_at').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
});

/** 実行時に作ったデータソースの取り込みの状態（delta の cursor・健康状態） */
export const connectorSources = sqliteTable('connector_sources', {
  dataSourceId: text('data_source_id').primaryKey(),
  userId: text('user_id').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
});

/** Graph のサブスクリプションの台帳（通知の照合に使う） */
export const graphSubscriptions = sqliteTable(
  'graph_subscriptions',
  {
    id: text('id').primaryKey(),
    dataSourceId: text('data_source_id').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
  },
  (t) => [index('graph_subscriptions_data_source_idx').on(t.dataSourceId)],
);
