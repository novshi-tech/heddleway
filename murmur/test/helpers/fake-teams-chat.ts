import { GatewayAuthError } from '../../src/ports/gateway';
import type { TeamsChatApi } from '../../src/connectors/teams-chat/api';
import { Chat, type ChatMember } from '../../src/connectors/teams-chat/message';
import { MessageBase, type TeamsMessage } from '../../src/connectors/teams/message';

/** Teams のチャットの偽物（本人の委任）。一覧は最後のメッセージの新しい順、メッセージは lastModifiedDateTime の新しい順 */
export class FakeTeamsChat implements TeamsChatApi {
  readonly chatList = new Map<string, { chat: Chat; members: ChatMember[]; messages: TeamsMessage[]; forbidden?: boolean }>();
  readonly subscriptions = new Map<string, { resource: string; notificationUrl: string; expiresAt: string }>();
  readonly calls: string[] = [];
  pageSize = 50;
  authBroken = false;
  displayName = 'Alice';
  private seq = 0;

  addChat(chat: { id: string; chatType: string; tenantId?: string }, members: ChatMember[], opts: { forbidden?: boolean } = {}) {
    this.chatList.set(chat.id, { chat: Chat.parse(chat), members, messages: [], ...opts });
  }

  post(chatId: string, raw: unknown) {
    const c = this.chatList.get(chatId)!;
    const m = MessageBase.parse(raw);
    c.messages.push(m);
    const last = c.chat.lastMessagePreview?.createdDateTime;
    if (!last || m.createdDateTime > last) c.chat = { ...c.chat, lastMessagePreview: { createdDateTime: m.createdDateTime } };
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async me() {
    this.check('me');
    return { displayName: this.displayName };
  }

  async chats(next?: string) {
    this.check(`chats ${next ?? 'first'}`);
    const sorted = [...this.chatList.values()].map((c) => c.chat).sort((a, b) => (b.lastMessagePreview?.createdDateTime ?? '').localeCompare(a.lastMessagePreview?.createdDateTime ?? ''));
    const start = next ? Number(new URL(next).searchParams.get('skip')) : 0;
    const page = sorted.slice(start, start + this.pageSize);
    const more = start + this.pageSize < sorted.length;
    return { chats: page, next: more ? `https://graph.microsoft.com/v1.0/me/chats?skip=${start + this.pageSize}` : null };
  }

  async chat(chatId: string) {
    this.check(`chat ${chatId}`);
    const c = this.chatList.get(chatId);
    if (!c || c.forbidden) return null;
    return c.chat;
  }

  async members(chatId: string) {
    this.check(`members ${chatId}`);
    const c = this.chatList.get(chatId);
    return c && !c.forbidden ? c.members : null;
  }

  async messages(chatId: string, since: string, next?: string) {
    this.check(`messages ${chatId} ${next ? 'next' : 'first'}`);
    const c = this.chatList.get(chatId);
    if (!c || c.forbidden) return null;
    const mod = (m: TeamsMessage) => m.lastModifiedDateTime ?? m.createdDateTime;
    const sorted = c.messages.filter((m) => mod(m) > since).sort((a, b) => mod(b).localeCompare(mod(a)));
    const start = next ? Number(new URL(next).searchParams.get('skip')) : 0;
    const page = sorted.slice(start, start + this.pageSize);
    const more = start + this.pageSize < sorted.length;
    return { messages: page, next: more ? `https://graph.microsoft.com/v1.0/chats/x/messages?skip=${start + this.pageSize}` : null };
  }

  async createSubscription(input: { objectId: string; notificationUrl: string; expiresAt: string }) {
    this.check('createSubscription');
    const id = `sub-${++this.seq}`;
    this.subscriptions.set(id, { resource: `/users/${input.objectId}/chats/getAllMessages`, notificationUrl: input.notificationUrl, expiresAt: input.expiresAt });
    return { id, expiresAt: input.expiresAt };
  }

  async renewSubscription(id: string, expiresAt: string) {
    this.check('renewSubscription');
    const s = this.subscriptions.get(id);
    if (!s) return null;
    s.expiresAt = expiresAt;
    return expiresAt;
  }

  async deleteSubscription(id: string) {
    this.check('deleteSubscription');
    this.subscriptions.delete(id);
  }
}
