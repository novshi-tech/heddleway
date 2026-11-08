import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import { DeltaPage, GRAPH_PREFER, MESSAGE_SELECT } from './message';

// Graph の呼び出し（ゲートウェイの REST 経由）。本体が Graph に対してするのは、読み取りと購読の管理だけ（0024 の決定 1）。
// 書き込みの経路（sendMail・下書き・移動など）はここに足さない。

export interface GraphMe {
  id: string;
  displayName: string;
  addresses: string[];
}

export interface CreatedSubscription {
  id: string;
  expiresAt: string;
}

export interface GraphApi {
  me(): Promise<GraphMe>;
  /** 最初の delta。since 以降に受信したものだけ */
  deltaStart(folder: string, since: string): Promise<DeltaPage>;
  /** nextLink か deltaLink の続き */
  deltaNext(link: string): Promise<DeltaPage>;
  createSubscription(input: { folder: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription>;
  /** 延長と再認可（reauthorizationRequired）を兼ねる。なければ null */
  renewSubscription(id: string, expiresAt: string): Promise<string | null>;
  deleteSubscription(id: string): Promise<void>;
}

/** Graph のエラー。410 は delta の位置が無効（最初から取り直す） */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`graph ${status} ${code}`);
    this.name = 'GraphError';
  }
}

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';

/** ゲートウェイの口（本人の接続）で Graph を呼ぶ。呼べる口は GRAPH_SCOPE（scope.ts）で、口の実装が強制する */
export class GatewayGraphApi implements GraphApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async me(): Promise<GraphMe> {
    const r = (await this.call('GET', '/v1.0/me?$select=id,displayName,mail,userPrincipalName,proxyAddresses')) as {
      id: string;
      displayName?: string;
      mail?: string | null;
      userPrincipalName?: string;
      proxyAddresses?: string[];
    };
    const aliases = (r.proxyAddresses ?? []).filter((a) => /^smtp:/i.test(a)).map((a) => a.slice(5));
    // 主のアドレス（SMTP: が大文字）を先頭に
    const primary = (r.proxyAddresses ?? []).find((a) => a.startsWith('SMTP:'))?.slice(5) ?? r.mail ?? r.userPrincipalName ?? '';
    return { id: r.id, displayName: r.displayName ?? '', addresses: [primary, r.mail ?? '', ...aliases, r.userPrincipalName ?? ''].filter(Boolean) };
  }

  async deltaStart(folder: string, since: string): Promise<DeltaPage> {
    const q = `$select=${MESSAGE_SELECT}&$filter=receivedDateTime ge ${since}`;
    return DeltaPage.parse(await this.call('GET', `/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?${q}`));
  }

  async deltaNext(link: string): Promise<DeltaPage> {
    if (!link.startsWith(`${GRAPH_ORIGIN}/`)) throw new GraphError(400, 'unexpected delta link');
    return DeltaPage.parse(await this.call('GET', link.slice(GRAPH_ORIGIN.length)));
  }

  async createSubscription(input: { folder: string; notificationUrl: string; clientState: string; expiresAt: string }) {
    const r = (await this.call('POST', '/v1.0/subscriptions', {
      changeType: 'created',
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: `me/mailFolders('${input.folder}')/messages`,
      expirationDateTime: input.expiresAt,
      clientState: input.clientState,
    })) as { id: string; expirationDateTime: string };
    return { id: r.id, expiresAt: new Date(r.expirationDateTime).toISOString() };
  }

  async renewSubscription(id: string, expiresAt: string) {
    try {
      const r = (await this.call('PATCH', `/v1.0/subscriptions/${encodeURIComponent(id)}`, { expirationDateTime: expiresAt })) as { expirationDateTime: string };
      return new Date(r.expirationDateTime).toISOString();
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null;
      throw err;
    }
  }

  async deleteSubscription(id: string) {
    try {
      await this.call('DELETE', `/v1.0/subscriptions/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 404)) throw err;
    }
  }

  private call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    return graphRequest(this.upstream, method, path, body);
  }
}

/**
 * ゲートウェイの口で Graph を 1 回呼ぶ。ゲートウェイ・同意の問題は GatewayAuthError / GatewayError、Graph のエラーは GraphError（To Do も使う）。
 * prefer を渡せば Prefer ヘッダーに足す（To Do の期限を本人のタイムゾーンで受け取る outlook.timezone など）
 */
export async function graphRequest(upstream: UpstreamCall, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, prefer?: string): Promise<unknown> {
  const res = await upstream(method, path, { body, headers: { prefer: prefer ? `${GRAPH_PREFER}, ${prefer}` : GRAPH_PREFER } });
  if (res.status === 204) return {};
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (res.ok) return json;
  // ゲートウェイ自身のエラーは { error: "..." }、Graph のエラーは { error: { code } }
  if (typeof json.error === 'string') {
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(json.error);
    throw new GatewayError(json.error, res.status);
  }
  const code = (json.error as { code?: string } | undefined)?.code ?? String(res.status);
  if (res.status === 401 || res.status === 403) throw new GatewayAuthError(`graph ${res.status} ${code}`);
  throw new GraphError(res.status, code);
}
