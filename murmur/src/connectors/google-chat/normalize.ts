import { googleChatAccount, type AddressRef, type InboundSignal } from '../../domain';
import type { GoogleChatDmRecord } from '../graph/state';
import type { ChatMessage } from './message';

// Google Chat のメッセージ → InboundSignal（純関数。0045）。
// - スペース（決定 1）: スレッドを使うスペースでは thread.name をアンカー threadTs にし、返信は構造でスレッドに入る
//   （スレッドの最初のメッセージは新しいアンカーなので AI の区切りに回る。0036 と同じ）。スレッドを使わないスペースでは
//   thread がメッセージごとに 1 つ付くだけなので、threadTs にしない（メッセージごとに AI の区切り。S0）
// - 名指し: 個人へのメンション（USER_MENTION の MENTION、相手が人）を宛先にする。DM は相手のメッセージ全部（決定 2）
// - 引用は quotedMessageId に。編集・削除・リアクション・アプリ（BOT）の投稿は取り込まない（シグナルは追記だけ）

export type Normalized = { kind: 'signal'; signal: InboundSignal } | { kind: 'skip'; reason: string };

export interface ChatContext {
  dataSourceId: string;
  /** スペースの名前（spaces/<ID>） */
  space: string;
  /** スレッドを使うスペースか */
  threaded: boolean;
  /**
   * DM・グループの個人リスト（決定 2）のときだけ。会話（スペース）をアンカーに入れ、区切りの候補を同じ会話に限る。
   * self は本人のアカウントの ID
   */
  conversation?: { record: GoogleChatDmRecord; self: string };
}

export function normalizeChatMessage(ctx: ChatContext, msg: ChatMessage): Normalized {
  if (msg.deletionMetadata) return { kind: 'skip', reason: 'deleted' };
  const sender = msg.sender;
  if (sender?.type !== 'HUMAN') return { kind: 'skip', reason: 'not from a person' };
  const from = googleChatAccount(sender.name);
  if (!from) return { kind: 'skip', reason: 'unknown sender' };

  const conv = ctx.conversation;
  if (conv?.record.kind === 'skip') return { kind: 'skip', reason: 'conversation not ingested' };
  let to: AddressRef[];
  if (conv?.record.kind === 'direct') {
    to = from === conv.self ? conv.record.members.filter((m) => m !== conv.self).map(address) : [address(conv.self)];
  } else {
    to = mentionedAddresses(msg);
  }

  const thread = ctx.threaded ? msg.thread?.name : undefined;
  const quoted = msg.quotedMessageMetadata?.name;
  return {
    kind: 'signal',
    signal: {
      dataSourceId: ctx.dataSourceId,
      channel: 'google-chat',
      from: address(from),
      to,
      body: (msg.text ?? '').trim(),
      anchors: {
        messageId: msg.name,
        ...(thread ? { threadTs: thread } : {}),
        ...(quoted ? { quotedMessageId: quoted } : {}),
        ...(conv ? { conversationId: ctx.space, conversationGroup: conv.record.kind === 'group' } : {}),
      },
      sourceRef: `google-chat:${msg.name}`,
      occurredAt: msg.createTime,
    },
  };
}

/** 個人へのメンションの宛先（重ねない）。@all・アプリへのメンション・追加（ADD）は個人に落とさない */
export function mentionedAddresses(msg: ChatMessage): AddressRef[] {
  const to: AddressRef[] = [];
  for (const a of msg.annotations ?? []) {
    if (a.type !== 'USER_MENTION' || a.userMention?.type !== 'MENTION') continue;
    const u = a.userMention.user;
    if (u?.type !== 'HUMAN') continue;
    const account = googleChatAccount(u.name);
    if (account && !to.some((x) => x.value === account)) to.push(address(account));
  }
  return to;
}

function address(account: string): AddressRef {
  return { channel: 'google-chat', value: account };
}
