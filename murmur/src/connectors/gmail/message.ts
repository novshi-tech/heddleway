import { z } from 'zod';

// Gmail の API の部分スキーマ。取り込みに使う項目だけを読み、ほかは捨てる（0041）。

const Header = z.object({ name: z.string(), value: z.string() });
export type GmailHeader = z.infer<typeof Header>;

/** MIME の部分（再帰）。body.data は base64url（パディングは保証されない） */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

const Part: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(Header).optional(),
    body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(Part).optional(),
  }),
);

/** messages.get（format=full）の 1 通 */
export const GmailMessage = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  /** エポックからのミリ秒（文字列） */
  internalDate: z.string().optional(),
  payload: Part.optional(),
});
export type GmailMessage = z.infer<typeof GmailMessage>;

/** users.getProfile */
export const GmailProfile = z.object({
  emailAddress: z.string(),
  historyId: z.string(),
});
export type GmailProfile = z.infer<typeof GmailProfile>;

export const GmailSendAs = z.object({
  sendAsEmail: z.string(),
  displayName: z.string().optional(),
  isPrimary: z.boolean().optional(),
  treatAsAlias: z.boolean().optional(),
  verificationStatus: z.string().optional(),
});
export type GmailSendAs = z.infer<typeof GmailSendAs>;

export const GmailSendAsList = z.object({ sendAs: z.array(GmailSendAs).optional() });

/** history の 1 レコード。messagesAdded の message は ID とラベルだけ（本文は messages.get で取る） */
export const HistoryRecord = z.object({
  id: z.string(),
  messagesAdded: z
    .array(z.object({ message: z.object({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional() }) }))
    .optional(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

/** history.list の 1 ページ。history は変化がなければない。historyId は読んだ時点の箱の最新（どのページでも同じ） */
export const HistoryPage = z.object({
  history: z.array(HistoryRecord).optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

/** messages.list の 1 ページ。messages は ID だけ */
export const MessageListPage = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});
export type MessageListPage = z.infer<typeof MessageListPage>;
