import { classifyGoogleError, GoogleApiNotEnabled, type GoogleErrorBody } from '../google-error';
import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import { ChatMembership, ChatMembersPage, ChatMessage, ChatMessagesPage, ChatSpace, ChatSpacesPage, SPACE_NAME } from './message';

// Google Chat の読み取り（ゲートウェイの REST 経由。0045）。本体が Chat に対してするのは読み取りだけ（購読もない。見回りで差分を取る）。
// 呼べる口は GOOGLE_CHAT_SCOPE・GOOGLE_CHAT_DM_SCOPE（scope.ts。GET だけ）。投稿の口はここに足さない

/** メッセージの一覧の 1 ページの件数 */
export const CHAT_PAGE_SIZE = 200;
/** スペース・メンバーの一覧で読むページの上限 */
const MAX_LIST_PAGES = 10;

export interface GoogleChatApi {
  /** 本人がメンバーのスペース。filter は spaceType の絞り込み（例 spaceType = "SPACE"） */
  spaces(filter: string): Promise<ChatSpace[]>;
  /** スペース 1 つ。なければ（消えた・メンバーでない）null */
  space(name: string): Promise<ChatSpace | null>;
  /** スペースのメンバー */
  members(space: string): Promise<ChatMembership[]>;
  /**
   * スペースのメッセージの 1 ページ（createTime の古い順）。after より後に作られたものだけ。
   * スペースがない・読めないとき（メンバーでなくなった）は GoogleChatError（404・403）。members も同じ
   */
  messages(space: string, opts: { after: string; pageToken?: string | null }): Promise<{ messages: ChatMessage[]; next: string | null }>;
}

/** Google のエラー（{ error: { code, message, status } }）。404 はスペースがない */
export class GoogleChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`google chat ${status} ${code}`);
    this.name = 'GoogleChatError';
  }
}

export class GatewayGoogleChatApi implements GoogleChatApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async spaces(filter: string): Promise<ChatSpace[]> {
    const out: ChatSpace[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: '1000', filter });
      if (pageToken) q.set('pageToken', pageToken);
      const r = ChatSpacesPage.parse(await this.get(`/v1/spaces?${q}`));
      for (const raw of r.spaces ?? []) {
        const s = ChatSpace.safeParse(raw);
        if (s.success && SPACE_NAME.test(s.data.name)) out.push(s.data);
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async space(name: string): Promise<ChatSpace | null> {
    try {
      return ChatSpace.parse(await this.get(`/v1/${spacePath(name)}`, true));
    } catch (err) {
      if (err instanceof GoogleChatError && err.status === 404) return null;
      throw err;
    }
  }

  async members(space: string): Promise<ChatMembership[]> {
    const out: ChatMembership[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = ChatMembersPage.parse(await this.get(`/v1/${spacePath(space)}/members?${q}`, true));
      for (const raw of r.memberships ?? []) {
        const m = ChatMembership.safeParse(raw);
        if (m.success) out.push(m.data);
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async messages(space: string, opts: { after: string; pageToken?: string | null }) {
    const q = new URLSearchParams({ pageSize: String(CHAT_PAGE_SIZE), filter: `createTime > "${new Date(opts.after).toISOString()}"` });
    if (opts.pageToken) q.set('pageToken', opts.pageToken);
    const r = ChatMessagesPage.parse(await this.get(`/v1/${spacePath(space)}/messages?${q}`, true));
    const messages = (r.messages ?? []).map((raw) => ChatMessage.safeParse(raw)).flatMap((m) => (m.success ? [m.data] : []));
    return { messages, next: r.nextPageToken ?? null };
  }

  /** perSpace: スペース 1 つへの呼び出し。Google の 403 を同意の問題にせず、GoogleChatError で返す（どうするかは呼び出し側が決める） */
  private get(path: string, perSpace = false): Promise<unknown> {
    return chatRequest(this.upstream, path, perSpace);
  }
}

/** スペースの名前をパスにする。spaces/<ID> の形でなければ断る（ID に / や . を入れて口の外へ出させない） */
function spacePath(name: string): string {
  if (!SPACE_NAME.test(name)) throw new GoogleChatError(400, 'invalid space name');
  return name;
}

/**
 * ゲートウェイの口で Google Chat を 1 回読む。ゲートウェイ・同意の問題は GatewayAuthError / GatewayError、
 * Google のエラーは GoogleChatError（上限は 429 などで、試し直す側）。perSpace なら、Google の 403 も GoogleChatError にする
 * （スペース 1 つが読めないのは、そのスペースから抜けた・外されたことが多く、接続全体の問題ではない）
 */
export async function chatRequest(upstream: UpstreamCall, path: string, perSpace = false): Promise<unknown> {
  const res = await upstream('GET', path);
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (res.ok) return json;
  if (typeof json.error === 'string') {
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(json.error);
    throw new GatewayError(json.error, res.status);
  }
  const e = json.error as GoogleErrorBody | undefined;
  const code = e?.status ?? String(res.status);
  const kind = classifyGoogleError(res.status, e);
  if (kind === 'api_disabled') throw new GoogleApiNotEnabled('Google Chat API');
  if (res.status === 401 || (res.status === 403 && kind !== 'quota' && !perSpace)) throw new GatewayAuthError(`google chat ${res.status} ${code}`);
  throw new GoogleChatError(res.status, code);
}
