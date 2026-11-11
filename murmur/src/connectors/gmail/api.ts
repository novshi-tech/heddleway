import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import { isQuota, type GoogleErrorBody } from '../google-error';
import { GmailProfile, GmailSendAsList, HistoryPage, MessageListPage, type GmailSendAs } from './message';

// Gmail の読み取り（ゲートウェイの REST 経由。0041）。本体が Gmail に対してするのは読み取りだけ
// （購読の管理もない。Pub/Sub は使わず、見回りで履歴を読む）。送信・下書き・ラベルの変更はスタンドが行う。
// 呼べる口は GMAIL_SCOPE（scope.ts。GET だけ）。書き込みの口はここに足さない

/** 履歴の 1 ページのレコード数の上限（API の上限） */
export const HISTORY_PAGE_SIZE = 500;
/** 拾い直しの検索の 1 ページの件数 */
export const LIST_PAGE_SIZE = 100;

export interface GmailApi {
  /** メールボックスのアドレスと、いまの historyId */
  profile(): Promise<GmailProfile>;
  /** 送信元として使えるアドレス（別名）の設定 */
  sendAs(): Promise<GmailSendAs[]>;
  /** startHistoryId より後に増えたメッセージの履歴 1 ページ。startHistoryId が古すぎれば GmailError（404） */
  history(startHistoryId: string, pageToken?: string | null): Promise<HistoryPage>;
  /** メッセージ 1 通（format=full の生の応答）。消えていれば null */
  message(id: string): Promise<Record<string, unknown> | null>;
  /** after（エポック秒）以後のメッセージの ID の一覧 1 ページ（拾い直し用） */
  list(after: number, pageToken?: string | null): Promise<{ ids: string[]; nextPageToken?: string }>;
}

/** Gmail のエラー。404 は history では startHistoryId が切れている、messages では消えている。429 は上限（試し直す側） */
export class GmailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`gmail ${status} ${code}`);
    this.name = 'GmailError';
  }
}

export class GatewayGmailApi implements GmailApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async profile(): Promise<GmailProfile> {
    return GmailProfile.parse(await this.get('/gmail/v1/users/me/profile'));
  }

  async sendAs(): Promise<GmailSendAs[]> {
    return GmailSendAsList.parse(await this.get('/gmail/v1/users/me/settings/sendAs')).sendAs ?? [];
  }

  async history(startHistoryId: string, pageToken?: string | null): Promise<HistoryPage> {
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: String(HISTORY_PAGE_SIZE) });
    if (pageToken) q.set('pageToken', pageToken);
    return HistoryPage.parse(await this.get(`/gmail/v1/users/me/history?${q}`));
  }

  async message(id: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof GmailError && err.status === 404) return null;
      throw err;
    }
  }

  async list(after: number, pageToken?: string | null): Promise<{ ids: string[]; nextPageToken?: string }> {
    const q = new URLSearchParams({ q: `after:${after}`, maxResults: String(LIST_PAGE_SIZE) });
    if (pageToken) q.set('pageToken', pageToken);
    const r = MessageListPage.parse(await this.get(`/gmail/v1/users/me/messages?${q}`));
    return { ids: (r.messages ?? []).map((m) => m.id), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
  }

  private get(path: string): Promise<unknown> {
    return gmailRequest(this.upstream, path);
  }
}

/**
 * ゲートウェイの口で Gmail の API を 1 回読む。ゲートウェイ・同意の問題は GatewayAuthError / GatewayError、
 * Google のエラーは GmailError（上限は 429 などで、試し直す側。403 でも上限（クォータ・レート）なら同意の問題にしない）
 */
export async function gmailRequest(upstream: UpstreamCall, path: string): Promise<unknown> {
  const res = await upstream('GET', path);
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (res.ok) return json;
  // ゲートウェイ自身のエラーは { error: "..." }、Google のエラーは { error: { code, message, status } }
  if (typeof json.error === 'string') {
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(json.error);
    throw new GatewayError(json.error, res.status);
  }
  const e = json.error as GoogleErrorBody | undefined;
  const code = e?.status ?? String(res.status);
  if (res.status === 401 || (res.status === 403 && !isQuota(e))) throw new GatewayAuthError(`gmail ${res.status} ${code}`);
  throw new GmailError(res.status, code);
}
