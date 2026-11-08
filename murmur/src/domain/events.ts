import { z } from 'zod';
import { AddressRef, Channel } from './entities';

// 正は append-only のイベント列。payload は zod で定義し、DB では JSONB に入る。

export { AddressRef } from './entities';

/** 構造アンカー。区切り（同じデータソースの中）と、結び候補に使う */
export const Anchors = z.object({
  /** このメッセージ自身の ID（Message-ID、Slack の ts、LINE の message id など） */
  messageId: z.string().optional(),
  /** In-Reply-To */
  inReplyTo: z.string().optional(),
  /** Slack のスレッド親 ts */
  threadTs: z.string().optional(),
  /** LINE の引用返信の元 */
  quotedMessageId: z.string().optional(),
  /**
   * ソースが元から持つ区切りの識別子（Jira の課題キー、PR）。
   * 同じデータソースで一致すればそのスレッド、一致しなければ新しいスレッドに決まる
   */
  threadKey: z.string().optional(),
  /** 本文などで触れている Jira キー（結び候補用。区切りには使わない） */
  jiraKeys: z.array(z.string()).optional(),
  /** "<repo>#<number>"（結び候補用。区切りには使わない） */
  prRefs: z.array(z.string()).optional(),
});
export type Anchors = z.infer<typeof Anchors>;

/** 添付はバイナリを持たず、ファイル参照（パスとハッシュ）だけ */
export const FileRef = z.object({ path: z.string(), sha256: z.string(), name: z.string().optional() });
export type FileRef = z.infer<typeof FileRef>;

export const Direction = z.enum(['inbound', 'outbound']);
export type Direction = z.infer<typeof Direction>;

/**
 * メモの書き手（0031 の 3・0032）。user は人の言葉（スタンドが中継したものを含む）、agent はエージェント自身が書いたもの。
 * スタンドの自己申告で、誰の番・名指し・担当・可視性には使わない
 */
export const Author = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('agent'), name: z.string().trim().min(1).max(64) }),
]);
export type Author = z.infer<typeof Author>;

/**
 * データソースで観測されたシグナル（0014 の 5）。受信も、ツール外で行われた送信も同じ種別。
 * イベントはアドレスだけを持ち、向き（こちらからか）と Contact はクエリ層がそのときのマスタで決める（0030）。
 * 古いイベントに残る direction・fromPartyId・toPartyIds は読まない
 */
export const SignalObserved = z.object({
  signalId: z.string(),
  dataSourceId: z.string(),
  channel: Channel,
  from: AddressRef,
  to: z.array(AddressRef),
  subject: z.string().optional(),
  body: z.string(),
  anchors: Anchors.default({}),
  attachments: z.array(FileRef).default([]),
  /** データソースごとの重複排除キー */
  sourceRef: z.string(),
});

export const ThreadChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), threadId: z.string() }),
  z.object({ kind: z.literal('new'), threadId: z.string(), title: z.string() }),
]);
export type ThreadChoice = z.infer<typeof ThreadChoice>;

/**
 * 区切りの根拠
 * - anchor: 構造アンカー（In-Reply-To・thread_ts・引用・ソースの区切り）
 * - awaiting: 同じ相手で、こちらが返事を待っているスレッドが 1 本だけ
 * - no_match: どの規則にも当たらず、候補もない → 新しいスレッド
 * - ai: 直近のスレッドから AI が話題の続きかを判断した
 * - human: 人の訂正（シグナルの移し替え）
 * - self: 本人が置き先を指定した（送信の記録）
 */
export const ThreadedBy = z.enum(['anchor', 'awaiting', 'no_match', 'ai', 'human', 'self']);
export type ThreadedBy = z.infer<typeof ThreadedBy>;

/** シグナルをスレッドに入れる。人の訂正（移し替え）も同じイベントで追記する */
export const SignalThreaded = z.object({
  signalId: z.string(),
  thread: ThreadChoice,
  by: ThreadedBy,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  /**
   * 返事や対応を求めているか。0038 でやめた（誰の番は宛先と明示的な操作で決まる）。新しいイベントは null を書き、fold は読まない。
   * 古いイベントに残る値も読まない
   */
  needsResponse: z.boolean().nullable().default(null),
  /** 人の訂正のとき、訂正した User */
  actorUserId: z.string().optional(),
});

/** 片付け（v1 の ignore の後継）。「このスレッドにこれ以上ボールは動かない」の宣言 */
export const ThreadDismissed = z.object({ threadId: z.string(), actorUserId: z.string(), reason: z.string().min(1) });
export const ThreadReopened = z.object({ threadId: z.string(), actorUserId: z.string(), reason: z.string().optional() });

/**
 * 担当する（0013 の 3・0038 の決定 1）。状態を持たない共有リストで、担当を明示の操作で決める。
 * userId が null なら手放す（仕分け待ちに戻る）、別の人なら引き継ぐ
 */
export const ThreadClaimed = z.object({
  threadId: z.string(),
  userId: z.string().nullable(),
  actorUserId: z.string(),
  reason: z.string().optional(),
});

/**
 * 結ばれ方（0014 の 3）
 * - sent: 送信・起票の副作用（record_sent。ステップ 4）
 * - anchor: アンカーの一致（結び候補）から人・スタンドが張った
 * - manual: 候補にないものを人・スタンドが張った
 */
export const LinkRoute = z.enum(['sent', 'anchor', 'manual']);
export type LinkRoute = z.infer<typeof LinkRoute>;

/**
 * スレッド a と b を結ぶ（op: unlink で外す）。無向で、1 つのイベントが両方のスレッドの投影に載る。
 * 追記で、元の判断は消さない
 */
export const ThreadLinked = z.object({
  a: z.string(),
  b: z.string(),
  op: z.enum(['link', 'unlink']).default('link'),
  route: LinkRoute,
  actorUserId: z.string(),
  reason: z.string().optional(),
});

/**
 * メモ（経過の記録。0039 の決定 2）。人とスタンドがスレッドにする操作の 1 つで、正は Murmur にある。データソースのシグナルではない。
 * 書けるのは個人リスト（読者が本人 1 人）のスレッドだけ（コマンドが確かめる）。名指しも担当も動かさない
 */
export const ThreadNoted = z.object({
  noteId: z.string(),
  threadId: z.string(),
  body: z.string().min(1),
  author: Author.default({ kind: 'user' }),
  actorUserId: z.string(),
});

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/, 'not a date (YYYY-MM-DD)');

/**
 * 写しの項目（0031 の 6）。Murmur が決めた形で、コネクタはサービスの標準の意味で写す。省略は「変わっていない」
 * - closed: ソースで完了しているか（ボールは「なし」）
 * - holders: ソースの上でボールを持っているアカウント（アドレスの値。Contact への解決はクエリ層）。空はだれも持っていない
 * - title: 件名（スレッドの件名になる）
 * - statusLabel / due: 見せるだけ（null は空）
 */
export const MirrorFields = z
  .object({
    closed: z.boolean(),
    holders: z.array(z.string().min(1)),
    title: z.string().min(1),
    statusLabel: z.string().min(1).nullable(),
    due: IsoDate.nullable(),
  })
  .partial()
  .strict();
export type MirrorFields = z.infer<typeof MirrorFields>;

/**
 * 状態の写し（0010・0031）。状態を持つデータソース（Jira の課題・PR）の状態を、スレッドに片方向で写す。
 * fields は変わった項目だけ。created なら、このイベントでスレッドを作る（課題の作成の通知より先に写しが届いたとき。fields.title が要る）
 */
export const ThreadMirrored = z.object({
  threadId: z.string(),
  created: z.boolean().default(false),
  dataSourceId: z.string(),
  /** ソースの区切り（課題キー） */
  threadKey: z.string(),
  fields: MirrorFields,
  /** ソースの更新の識別子（監査用） */
  sourceRef: z.string(),
});

export const OutboundRecorded = z.object({
  signalId: z.string(),
  merged: z.boolean(),
  dataSourceId: z.string(),
  channel: Channel,
  from: AddressRef,
  to: z.array(AddressRef),
  subject: z.string().optional(),
  body: z.string(),
  anchors: Anchors.default({}),
  sentRef: z.string(),
  /** 送る元になったスレッド（どのデータソースでもよい）。あれば経路 sent で結ぶ */
  sourceThreadId: z.string().nullable().default(null),
  /** 返事期待の期限（UTC の ISO 8601）。なければ期限超過は出ない */
  replyExpectedBy: z.string().nullable().default(null),
  actorUserId: z.string(),
});

/**
 * 名指しを外す（0038 の決定 3・4）。untilSignalId までの名指しを外す。それより後に名指しされれば、また残る。
 * - addresses: 外すアドレス（自分のアドレスか、このリストの読者でないアドレス。権利はコマンドが確かめる）
 * - list: リスト宛て（窓口のアドレス・グループのチャネルの宛先のない投稿）の名指しを、actorUserId について外す
 */
export const AttentionAcknowledged = z.object({
  threadId: z.string(),
  untilSignalId: z.string(),
  addresses: z.array(AddressRef).default([]),
  list: z.boolean().default(false),
  actorUserId: z.string(),
  reason: z.string().optional(),
});

/** 返事期待の期限超過（Cron の見回り）。冪等: 同じ送信に 1 回だけ */
export const ReplyOverdue = z.object({ threadId: z.string(), signalId: z.string(), replyExpectedBy: z.string() });

export const EventPayloads = {
  SignalObserved,
  SignalThreaded,
  ThreadDismissed,
  ThreadReopened,
  ThreadClaimed,
  ThreadLinked,
  ThreadNoted,
  ThreadMirrored,
  OutboundRecorded,
  ReplyOverdue,
  AttentionAcknowledged,
} as const;

export type EventType = keyof typeof EventPayloads;
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

/** append 前のイベント（seq と at はストアが付ける） */
export type DraftEvent = { [T in EventType]: { type: T; payload: PayloadOf<T> } }[EventType];

/** 保存済みイベント */
export type DomainEvent = DraftEvent & { seq: number; at: string };

export const EventTypeSchema = z.enum(Object.keys(EventPayloads) as [EventType, ...EventType[]]);

/** DB などから読んだ生の行をイベントとして検証する */
export function parseEvent(raw: { seq: number; at: string; type: string; payload: unknown }): DomainEvent {
  const type = EventTypeSchema.parse(raw.type);
  const payload = EventPayloads[type].parse(raw.payload);
  return { seq: raw.seq, at: raw.at, type, payload } as DomainEvent;
}

export function draft<T extends EventType>(type: T, payload: z.input<(typeof EventPayloads)[T]>): DraftEvent {
  return { type, payload: EventPayloads[type].parse(payload) } as DraftEvent;
}
