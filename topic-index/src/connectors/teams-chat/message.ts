import { z } from 'zod';

// Teams のチャット（chat）とメンバーの部分スキーマ（0044）。メッセージの形はチャネルと同じ chatMessage（../teams/message.ts）。

/** チャット。chatType は oneOnOne・group・meeting のほか、委任では読めない unknownFutureValue がある（S0） */
export const Chat = z.object({
  id: z.string(),
  chatType: z.string().nullable().optional(),
  tenantId: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  lastMessagePreview: z.object({ createdDateTime: z.string().nullable().optional() }).nullable().optional(),
});
export type Chat = z.infer<typeof Chat>;

/** チャットのメンバー。人（aadUserConversationMember）は userId を持つ。1 対 1 の相手がアプリなら、人は本人だけ（S0） */
export const ChatMember = z.object({
  userId: z.string().nullable().optional(),
  tenantId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
});
export type ChatMember = z.infer<typeof ChatMember>;
