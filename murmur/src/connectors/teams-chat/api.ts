import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import type { CreatedSubscription } from '../graph/api';
import { GRAPH_ORIGIN, GraphError } from '../graph/api';
import { MessageBase, MessagesPage, type TeamsMessage } from '../teams/message';
import { Chat, ChatMember } from './message';

// Teams のチャットの呼び出し（ゲートウェイの口で Graph を呼ぶ。0044）。読み取りとサブスクリプションの管理だけ（TEAMS_CHAT_SCOPE）。

export interface TeamsChatApi {
  /** 本人の表示名 */
  me(): Promise<{ displayName: string }>;
  /** 参加しているチャットの一覧（最後のメッセージの新しい順）。next は前のページの nextLink */
  chats(next?: string): Promise<{ chats: Chat[]; next: string | null }>;
  /** チャット 1 つ。委任で読めない種類（S0 の unknownFutureValue）は null */
  chat(chatId: string): Promise<Chat | null>;
  /** チャットのメンバー。読めなければ null */
  members(chatId: string): Promise<ChatMember[] | null>;
  /** チャットのメッセージ（lastModifiedDateTime の新しい順、since より後に動いたもの）。読めなければ null */
  messages(chatId: string, since: string, next?: string): Promise<{ messages: TeamsMessage[]; next: string | null } | null>;
  createSubscription(input: { objectId: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription>;
  renewSubscription(id: string, expiresAt: string): Promise<string | null>;
  deleteSubscription(id: string): Promise<void>;
}

/** Graph が 403・404 を返した（チャットごとの権限。接続の問題ではない）。ゲートウェイの 403 は GatewayAuthError のまま */
class ChatNotReadable extends Error {}

const enc = encodeURIComponent;

export class GatewayTeamsChatApi implements TeamsChatApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async me() {
    const r = (await this.call('GET', '/v1.0/me?$select=displayName')) as { displayName?: string };
    return { displayName: r.displayName ?? '' };
  }

  async chats(next?: string) {
    const path = next ? this.nextPath(next) : '/v1.0/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime%20desc&$top=50';
    const page = MessagesPage.parse(await this.call('GET', path));
    const chats = page.value.map((raw) => Chat.safeParse(raw)).flatMap((r) => (r.success ? [r.data] : []));
    return { chats, next: page['@odata.nextLink'] ?? null };
  }

  async chat(chatId: string) {
    return this.readable(async () => Chat.parse(await this.call('GET', `/v1.0/chats/${enc(chatId)}`, undefined, true)));
  }

  async members(chatId: string) {
    return this.readable(async () => {
      const out: ChatMember[] = [];
      let path: string | null = `/v1.0/chats/${enc(chatId)}/members`;
      while (path) {
        const r = (await this.call('GET', path, undefined, true)) as { value?: unknown[]; '@odata.nextLink'?: string };
        for (const raw of r.value ?? []) {
          const m = ChatMember.safeParse(raw);
          if (m.success) out.push(m.data);
        }
        path = r['@odata.nextLink'] ? this.nextPath(r['@odata.nextLink']) : null;
      }
      return out;
    });
  }

  async messages(chatId: string, since: string, next?: string) {
    return this.readable(async () => {
      const path = next
        ? this.nextPath(next)
        : `/v1.0/chats/${enc(chatId)}/messages?$top=50&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20${enc(since)}`;
      const page = MessagesPage.parse(await this.call('GET', path, undefined, true));
      const messages = page.value.map((raw) => MessageBase.safeParse(raw)).flatMap((r) => (r.success ? [r.data] : []));
      return { messages, next: page['@odata.nextLink'] ?? null };
    });
  }

  async createSubscription(input: { objectId: string; notificationUrl: string; clientState: string; expiresAt: string }) {
    const r = (await this.call('POST', '/v1.0/subscriptions', {
      changeType: 'created,updated',
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: `/users/${input.objectId}/chats/getAllMessages`,
      expirationDateTime: input.expiresAt,
      clientState: input.clientState,
    })) as { id: string; expirationDateTime: string };
    return { id: r.id, expiresAt: new Date(r.expirationDateTime).toISOString() };
  }

  async renewSubscription(id: string, expiresAt: string) {
    try {
      const r = (await this.call('PATCH', `/v1.0/subscriptions/${enc(id)}`, { expirationDateTime: expiresAt })) as { expirationDateTime: string };
      return new Date(r.expirationDateTime).toISOString();
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null;
      throw err;
    }
  }

  async deleteSubscription(id: string) {
    try {
      await this.call('DELETE', `/v1.0/subscriptions/${enc(id)}`);
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 404)) throw err;
    }
  }

  private nextPath(next: string): string {
    if (!next.startsWith(`${GRAPH_ORIGIN}/`)) throw new GraphError(400, 'unexpected next link');
    return next.slice(GRAPH_ORIGIN.length);
  }

  private async readable<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ChatNotReadable) return null;
      throw err;
    }
  }

  /** perChat: チャットごとの読み取り。Graph の 403・404 はそのチャットが読めないだけ（ChatNotReadable） */
  private async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, perChat = false): Promise<unknown> {
    const res = await this.upstream(method, path, { body });
    if (res.status === 204) return {};
    const json = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (res.ok) return json;
    // ゲートウェイ自身のエラーは { error: "..." }、Graph のエラーは { error: { code } }
    if (typeof json.error === 'string') {
      if (res.status === 401 || res.status === 403) throw new GatewayAuthError(json.error);
      throw new GatewayError(json.error, res.status);
    }
    const code = (json.error as { code?: string } | undefined)?.code ?? String(res.status);
    if (perChat && (res.status === 403 || res.status === 404)) throw new ChatNotReadable(code);
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(`graph ${res.status} ${code}`);
    throw new GraphError(res.status, code);
  }
}
