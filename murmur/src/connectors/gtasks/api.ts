import { classifyGoogleError, GoogleApiNotEnabled, type GoogleErrorBody } from '../google-error';
import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import { GoogleUserinfo, GtasksListsPage, GtasksTaskList, GtasksTasksPage, verifiedEmail } from './task';

// Google Tasks の読み取り（ゲートウェイの REST 経由。0041）。本体が Google Tasks に対してするのは読み取りだけ
// （購読の管理もない。変更の通知がなく、見回りで差分を取る）。タスクを作る・変える・完了にするのはスタンド。
// 呼べる口は GTASKS_SCOPE（scope.ts。GET だけ）。書き込みの口はここに足さない

/** タスクの一覧の 1 ページの件数（API の上限） */
export const GTASKS_PAGE_SIZE = 100;

export interface GtasksApi {
  /** つないだアカウントのメールアドレス（userinfo）。確認済みでなければ空 */
  account(): Promise<string>;
  /** 本人のタスクのリスト */
  lists(): Promise<GtasksTaskList[]>;
  /** リスト 1 つ。なければ（消した・見えない）null */
  list(listId: string): Promise<GtasksTaskList | null>;
  /**
   * リストのタスクの 1 ページ。完了・非表示・削除も読む。updatedMin があればそれ以後に変わったものだけ。
   * リストがなければ GtasksError（404）
   */
  tasks(listId: string, opts?: { updatedMin?: string | null; pageToken?: string | null }): Promise<GtasksTasksPage>;
}

/** Google のエラー（{ error: { code, message, status } }）。404 はリストがない、400 は pageToken が無効 */
export class GtasksError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`google tasks ${status} ${code}`);
    this.name = 'GtasksError';
  }
}

export class GatewayGtasksApi implements GtasksApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async account(): Promise<string> {
    return verifiedEmail(GoogleUserinfo.parse(await this.get('/oauth2/v3/userinfo')));
  }

  async lists(): Promise<GtasksTaskList[]> {
    const out: GtasksTaskList[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ maxResults: String(GTASKS_PAGE_SIZE) });
      if (pageToken) q.set('pageToken', pageToken);
      const r = GtasksListsPage.parse(await this.get(`/tasks/v1/users/@me/lists?${q}`));
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async list(listId: string): Promise<GtasksTaskList | null> {
    try {
      return GtasksTaskList.parse(await this.get(`/tasks/v1/users/@me/lists/${encodeURIComponent(listId)}`));
    } catch (err) {
      if (err instanceof GtasksError && err.status === 404) return null;
      throw err;
    }
  }

  async tasks(listId: string, opts: { updatedMin?: string | null; pageToken?: string | null } = {}): Promise<GtasksTasksPage> {
    const q = new URLSearchParams({ maxResults: String(GTASKS_PAGE_SIZE), showCompleted: 'true', showHidden: 'true', showDeleted: 'true' });
    if (opts.updatedMin) q.set('updatedMin', opts.updatedMin);
    if (opts.pageToken) q.set('pageToken', opts.pageToken);
    return GtasksTasksPage.parse(await this.get(`/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?${q}`));
  }

  private get(path: string): Promise<unknown> {
    return gtasksRequest(this.upstream, path);
  }
}

/**
 * ゲートウェイの口で Google の API を 1 回読む。ゲートウェイ・同意の問題は GatewayAuthError / GatewayError、
 * Google のエラーは GtasksError（上限は 429 などで、試し直す側）
 */
export async function gtasksRequest(upstream: UpstreamCall, path: string): Promise<unknown> {
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
  const kind = classifyGoogleError(res.status, e);
  // 上限は試し直す側。API が有効でないのはデプロイの問題で、同意の問題にしない
  if (kind === 'api_disabled') throw new GoogleApiNotEnabled('Google Tasks API');
  if (res.status === 401 || (res.status === 403 && kind !== 'quota')) throw new GatewayAuthError(`google tasks ${res.status} ${code}`);
  throw new GtasksError(res.status, code);
}
