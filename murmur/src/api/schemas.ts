import { z } from 'zod';
import { AddressRef, Anchors, Author, Channel, FileRef, MirrorFields } from '../domain';

// HTTP API の入力スキーマ。キーはツール定義に合わせて snake_case。
// ツールの一覧は計画 v2 の「スタンド接続」の表（ステップ 5）。スキルの API の表と合わせる

/** オフセット付きの時刻を受け、UTC の ISO 8601 にそろえる（文字列で比べるため。v1 の H7 のバグ） */
export const Instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());

export const ListThreadsQuery = z.object({
  filter: z.enum(['my_turn', 'mine', 'open', 'awaiting', 'overdue', 'triage', 'all']).default('open'),
  data_source: z.string().optional(),
  /** 前回見た時刻。それより後に動いたスレッドだけ */
  since: Instant.optional(),
});

export const GetThreadQuery = z.object({ since: Instant.optional() });

export const AddNoteBody = z.object({
  /** メモを書くスレッド。個人リスト（読者が本人 1 人）のスレッドだけ（0039 の決定 2）。新しく追うものは、タスクのサービスにタスクを作る */
  thread_id: z.string().min(1),
  body: z.string().min(1),
  /** 書き手。省略すれば本人（user）。エージェント自身が書いたものは {kind:'agent', name}（0031 の 3） */
  author: Author.optional(),
});

export const ClaimBody = z
  .object({
    /** 担当させる User。省略すれば自分、null なら手放す（状態を持つソースと個人リストでは断る。0038 の決定 1） */
    user_id: z.string().nullable().optional(),
    reason: z.string().optional(),
  })
  .default({});

export const LinkBody = z.object({ thread_id: z.string(), reason: z.string().optional() });

/**
 * 名指しを外す（0038 の決定 3・4）。until_signal_id までの名指しを外す（省けばスレッドの最新のシグナルまで）。
 * addresses を省けば自分への名指し（自分のアドレスとリスト宛て）。渡せば、自分のアドレスか、このリストの読者でないアドレス
 */
export const AcknowledgeBody = z
  .object({
    until_signal_id: z.string().min(1).optional(),
    addresses: z.array(AddressRef).optional(),
    reason: z.string().optional(),
  })
  .default({});

/** 複数のスレッドの自分への名指しをまとめて外す（参加したときなど。スレッドごとのイベントになる） */
export const AcknowledgeManyBody = z.object({ thread_ids: z.array(z.string().min(1)).min(1).max(500), reason: z.string().optional() });

export const RecordSentBody = z
  .object({
    data_source: z.string(),
    /** 宛先のアドレス（チャネルはデータソースのもの）。to か to_contact_ids のどちらかが要る（タスクのサービスでタスクを作った記録だけ要らない。0039） */
    to: z.array(z.string()).default([]),
    to_contact_ids: z.array(z.string()).default([]),
    /** 送ったアドレス（Jira・Slack の自分のアカウントなど）。省けばデータソースの窓口、窓口がなければ自分の Contact のアドレス */
    from: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().min(1),
    sent_ref: z.string().min(1),
    anchors: z
      .object({
        in_reply_to: z.string().optional(),
        thread_ts: z.string().optional(),
        quoted_message_id: z.string().optional(),
        thread_key: z.string().optional(),
        jira_keys: z.array(z.string()).optional(),
        pr_refs: z.array(z.string()).optional(),
      })
      .default({}),
    reply_to_thread_id: z.string().optional(),
    source_thread_id: z.string().optional(),
    reply_expected_by: Instant.optional(),
    /** 送ったスレッドの、送る前までの自分への名指しを一緒に外す（0038） */
    acknowledge: z.boolean().optional(),
  });

// ---- User と Contact（0030 の 6〜9） ----

export const RenameBody = z.object({ name: z.string().min(1) });

/** 個人のリスト。スタンドはゲートウェイで目的のサービスがつながっているかを確かめてから作る */
export const CreateDataSourceBody = z.object({
  channel: Channel,
  name: z.string().min(1),
  description: z.string().optional(),
  /** そのリストでの自分のアイデンティティ（つないだアカウントのアドレス） */
  identity: z.string().min(1),
  /** ゲートウェイの自分の接続の識別子 */
  gateway_credential_id: z.string().min(1),
  group: z.boolean().optional(),
});

export const IdentityBody = z.object({ identity: z.string().min(1) });

export const ContactsQuery = z.object({ q: z.string().optional() });

export const CreateContactBody = z.object({ name: z.string().min(1), address: AddressRef.optional() });

export const AddAddressBody = z.object({
  channel: Channel,
  value: z.string().min(1),
  valid_from: Instant.optional(),
  reason: z.string().optional(),
});

export const EndAddressBody = z.object({ valid_to: Instant.optional(), reason: z.string().optional() }).default({});

export const MergeContactBody = z.object({ from: z.string().min(1), reason: z.string().optional() });

export const DismissBody = z.object({ reason: z.string().min(1) });
export const ReopenBody = z.object({ reason: z.string().optional() }).default({});

export const MoveSignalBody = z
  .object({
    /** 移し先の既存のスレッド。省略して new_thread_title を渡せば新しいスレッド */
    thread_id: z.string().optional(),
    new_thread_title: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .refine((b) => (b.thread_id === undefined) !== (b.new_thread_title === undefined), {
    message: 'thread_id か new_thread_title のどちらか一方',
  });

export const InboundSignalBody = z.object({
  dataSourceId: z.string(),
  channel: Channel,
  from: AddressRef,
  to: z.array(AddressRef).default([]),
  subject: z.string().optional(),
  body: z.string(),
  anchors: Anchors.default({}),
  attachments: z.array(FileRef).default([]),
  sourceRef: z.string(),
});

/** 状態の写し（ダミーの Jira など）。holders はそのチャネルのアカウント（0031 の 6） */
export const InboundMirrorBody = z.object({
  kind: z.literal('mirror'),
  dataSourceId: z.string(),
  channel: Channel,
  threadKey: z.string(),
  fields: MirrorFields,
  sourceRef: z.string(),
});

/** Webhook・ダミー上流に積む 1 件（シグナルか状態の写し） */
export const InboundItemBody = z.union([InboundMirrorBody, InboundSignalBody]);

/** POST /api/connections/outlook。credential_id はゲートウェイの Graph の接続（複数あるときに選ぶ） */
export const ConnectOutlookBody = z.object({ credential_id: z.string().min(1).optional() });

/** Jira をつなぐ（0034）。site はサイトの cloudId（choose_site で返したもの）、jql は範囲（省けば担当・起票・ウォッチ） */
/** Teams のチャネルを共有リストとしてつなぐ（0036・0037）。team・channel を省くと一覧（choose_team・choose_channel）を返す */
export const ConnectTeamsBody = z.object({
  credential_id: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
});

/** To Do のタスクのリストを個人リストとしてつなぐ（0039）。list を省くと一覧（choose_list）を返す */
export const ConnectTodoBody = z.object({
  credential_id: z.string().min(1).optional(),
  list: z.string().min(1).optional(),
});

/** Jira のプロジェクトを共有リストとしてつなぐ（0037）。project を省くと一覧（choose_project）を返す */
export const ConnectJiraBody = z.object({
  credential_id: z.string().min(1).optional(),
  site: z.string().min(1).optional(),
  project: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
});
