import { z } from 'zod';

// Graph の message の部分スキーマ。取り込みに使う項目だけを読み、ほかは捨てる。

const EmailAddress = z.object({
  emailAddress: z.object({ address: z.string().optional(), name: z.string().optional() }).optional(),
});

const ItemBody = z.object({ contentType: z.string().optional(), content: z.string().nullable().optional() });

export const GraphMessage = z.object({
  id: z.string(),
  /** delta で消えたもの */
  '@removed': z.unknown().optional(),
  internetMessageId: z.string().optional(),
  /** Outlook の会話。AI を使わない区切りのソースのスレッド（0050） */
  conversationId: z.string().optional(),
  subject: z.string().nullable().optional(),
  from: EmailAddress.nullable().optional(),
  sender: EmailAddress.nullable().optional(),
  toRecipients: z.array(EmailAddress).optional(),
  ccRecipients: z.array(EmailAddress).optional(),
  receivedDateTime: z.string().optional(),
  sentDateTime: z.string().optional(),
  isDraft: z.boolean().optional(),
  /** 引用の履歴を除いた本文。delta で取れなければない */
  uniqueBody: ItemBody.nullable().optional(),
  body: ItemBody.nullable().optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })).nullable().optional(),
});
export type GraphMessage = z.infer<typeof GraphMessage>;

export const DeltaPage = z.object({
  value: z.array(z.record(z.string(), z.unknown())),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});
export type DeltaPage = z.infer<typeof DeltaPage>;

/** delta で取る項目（$select）。受信トレイは delta でヘッダー（In-Reply-To）まで取れる。送信済みにはヘッダーがない（2026-10-30 に実物で確認） */
export const MESSAGE_SELECT = [
  'internetMessageId',
  'conversationId',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  'uniqueBody',
  'body',
  'internetMessageHeaders',
].join(',');

/** ID は移動しても変わらないもの、本文はテキストで取る */
export const GRAPH_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=50';
