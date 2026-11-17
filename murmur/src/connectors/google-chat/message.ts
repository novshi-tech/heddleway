import { z } from 'zod';

// Google Chat の API の部分スキーマ（0045）。取り込みに使う項目だけを読み、ほかは捨てる。
// S0: ユーザーの認証で読んでも、送り手・メンバー・メンションに displayName と email が入った（ドキュメントでは name と type だけ）。
// 名前は使わず（Contact はエージェントが作る。0035）、name と type だけに頼る

/** Chat の User。name は users/<ID>、type は HUMAN か BOT */
export const ChatUser = z.object({
  name: z.string(),
  type: z.string().optional(),
  displayName: z.string().nullable().optional(),
});
export type ChatUser = z.infer<typeof ChatUser>;

const Annotation = z.object({
  /** USER_MENTION・SLASH_COMMAND・RICH_LINK・CUSTOM_EMOJI など */
  type: z.string().optional(),
  /** type が USER_MENTION のとき。userMention.type は ADD（追加）か MENTION（メンション） */
  userMention: z.object({ user: ChatUser.optional(), type: z.string().optional() }).optional(),
});

export const ChatMessage = z.object({
  /** spaces/<space>/messages/<message> */
  name: z.string(),
  sender: ChatUser.optional(),
  createTime: z.string(),
  /** メンションは「@名前」のまま入る素の文 */
  text: z.string().optional(),
  /** スレッド。返信なら threadReply が true（スレッドの最初のメッセージには付かない。S0） */
  thread: z.object({ name: z.string() }).optional(),
  threadReply: z.boolean().optional(),
  annotations: z.array(Annotation).optional(),
  /** 引用（引用元のメッセージの name） */
  quotedMessageMetadata: z.object({ name: z.string() }).optional(),
  /** 削除されたメッセージ */
  deletionMetadata: z.unknown().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatMessagesPage = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).optional(),
  nextPageToken: z.string().optional(),
});

export const ChatSpace = z.object({
  /** spaces/<ID> */
  name: z.string(),
  displayName: z.string().nullable().optional(),
  /** SPACE・GROUP_CHAT・DIRECT_MESSAGE */
  spaceType: z.string().optional(),
  /** THREADED_MESSAGES・UNTHREADED_MESSAGES（など） */
  spaceThreadingState: z.string().optional(),
  lastActiveTime: z.string().optional(),
  /** アプリと本人だけの DM */
  singleUserBotDm: z.boolean().optional(),
});
export type ChatSpace = z.infer<typeof ChatSpace>;

export const ChatSpacesPage = z.object({
  spaces: z.array(z.record(z.string(), z.unknown())).optional(),
  nextPageToken: z.string().optional(),
});

export const ChatMembership = z.object({
  member: ChatUser.optional(),
  /** JOINED・INVITED・NOT_A_MEMBER */
  state: z.string().optional(),
});
export type ChatMembership = z.infer<typeof ChatMembership>;

export const ChatMembersPage = z.object({
  memberships: z.array(z.record(z.string(), z.unknown())).optional(),
  nextPageToken: z.string().optional(),
});

/** スペースの名前（spaces/<ID>）の形。口の照合と同じ（ID は英数字・_・-） */
export const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]+$/;
