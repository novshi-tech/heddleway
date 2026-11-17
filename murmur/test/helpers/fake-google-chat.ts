import { GoogleChatError, type GoogleChatApi } from '../../src/connectors/google-chat/api';
import { ChatMessage, type ChatMembership, type ChatSpace } from '../../src/connectors/google-chat/message';
import { GatewayAuthError } from '../../src/ports/gateway';

/**
 * Google Chat の偽物（本人がメンバーのスペース）。本物と同じく、メッセージの一覧は createTime の古い順で、
 * after より後に作られたものだけを返す（境界を含まない）。pageToken は「何件目まで渡したか」。calls に呼んだものを残す
 */
export class FakeGoogleChat implements GoogleChatApi {
  readonly spaceList: ChatSpace[] = [];
  readonly membersOf = new Map<string, ChatMembership[]>();
  readonly messagesOf = new Map<string, Record<string, unknown>[]>();
  /** 読めない（メンバーでない・消えた）スペースと、返すエラーの状態 */
  readonly unreadable = new Map<string, number>();
  readonly calls: string[] = [];
  pageSize = 50;
  authBroken = false;

  addSpace(space: ChatSpace, members: ChatMembership[] = []) {
    this.spaceList.push(space);
    this.membersOf.set(space.name, members);
  }

  post(space: string, msg: Record<string, unknown>) {
    const list = this.messagesOf.get(space) ?? [];
    list.push(msg);
    list.sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));
    this.messagesOf.set(space, list);
    // スペースの最後に動いた時刻（S0: 最後のメッセージの createTime と同じ）
    const s = this.spaceList.find((x) => x.name === space);
    if (s && (!s.lastActiveTime || String(msg.createTime) > s.lastActiveTime)) s.lastActiveTime = String(msg.createTime);
  }

  private check(call: string, space?: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
    const status = space ? this.unreadable.get(space) : undefined;
    if (status) throw new GoogleChatError(status, status === 404 ? 'NOT_FOUND' : 'PERMISSION_DENIED');
  }

  async spaces(filter: string) {
    this.check(`spaces ${filter}`);
    const types = [...filter.matchAll(/spaceType = "([A-Z_]+)"/g)].map((m) => m[1]);
    return this.spaceList.filter((s) => types.includes(s.spaceType ?? '')).map((s) => ({ ...s }));
  }

  async space(name: string) {
    this.check(`space ${name}`, name);
    return this.spaceList.find((s) => s.name === name) ?? null;
  }

  async members(space: string) {
    this.check(`members ${space}`, space);
    return this.membersOf.get(space) ?? [];
  }

  async messages(space: string, opts: { after: string; pageToken?: string | null }) {
    this.check(`messages ${space} ${opts.after}`, space);
    const all = (this.messagesOf.get(space) ?? []).filter((m) => String(m.createTime) > opts.after);
    const from = opts.pageToken ? Number(opts.pageToken) : 0;
    const page = all.slice(from, from + this.pageSize);
    const next = from + this.pageSize < all.length ? String(from + this.pageSize) : null;
    return { messages: page.map((m) => ChatMessage.parse(m)), next };
  }
}

/** 人のメンバー */
export const human = (id: string) => ({ member: { name: `users/${id}`, type: 'HUMAN' }, state: 'JOINED' });
export const bot = (id: string) => ({ member: { name: `users/${id}`, type: 'BOT' }, state: 'JOINED' });

/** メッセージ。mentions はメンションする人のアカウントの ID */
export function chatMessage(space: string, id: string, createTime: string, from: string, opts: { text?: string; thread?: string; reply?: boolean; mentions?: string[]; bot?: boolean; quoted?: string; deleted?: boolean } = {}) {
  return {
    name: `${space}/messages/${id}`,
    sender: { name: `users/${from}`, type: opts.bot ? 'BOT' : 'HUMAN', displayName: from },
    createTime,
    text: opts.text ?? `本文 ${id}`,
    thread: { name: `${space}/threads/${opts.thread ?? `t-${id}`}` },
    ...(opts.reply ? { threadReply: true } : {}),
    ...(opts.mentions?.length
      ? { annotations: opts.mentions.map((m) => ({ type: 'USER_MENTION', userMention: { type: 'MENTION', user: { name: `users/${m}`, type: 'HUMAN' } } })) }
      : {}),
    ...(opts.quoted ? { quotedMessageMetadata: { name: opts.quoted } } : {}),
    ...(opts.deleted ? { deletionMetadata: { deletionType: 'CREATOR' } } : {}),
  };
}
