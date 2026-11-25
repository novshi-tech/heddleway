import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';
import type { CreatedSubscription } from '../graph/api';
import { GRAPH_ORIGIN, GraphError } from '../graph/api';
import { ChannelMember, ChannelMessage, MessagesPage } from './message';

// Teams の呼び出し（ゲートウェイの口で Graph を呼ぶ。0036）。読み取りとサブスクリプションの管理だけ（TEAMS_SCOPE）。

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamsApi {
  joinedTeams(): Promise<TeamRef[]>;
  channels(teamId: string): Promise<TeamRef[]>;
  /** 投稿の一覧（返信つき、新しく動いた順に近い）。next は前のページの nextLink */
  messages(teamId: string, channelId: string, next?: string): Promise<{ messages: ChannelMessage[]; next: string | null }>;
  members(teamId: string, channelId: string): Promise<ChannelMember[]>;
  createSubscription(input: { teamId: string; channelId: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription>;
  renewSubscription(id: string, expiresAt: string): Promise<string | null>;
  deleteSubscription(id: string): Promise<void>;
}

const enc = encodeURIComponent;

export class GatewayTeamsApi implements TeamsApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async joinedTeams() {
    const r = (await this.call('GET', '/v1.0/me/joinedTeams?$select=id,displayName')) as { value?: { id: string; displayName?: string }[] };
    return (r.value ?? []).map((t) => ({ id: t.id, name: t.displayName ?? t.id }));
  }

  async channels(teamId: string) {
    const r = (await this.call('GET', `/v1.0/teams/${enc(teamId)}/channels?$select=id,displayName`)) as { value?: { id: string; displayName?: string }[] };
    return (r.value ?? []).map((c) => ({ id: c.id, name: c.displayName ?? c.id }));
  }

  async messages(teamId: string, channelId: string, next?: string) {
    if (next && !next.startsWith(`${GRAPH_ORIGIN}/`)) throw new GraphError(400, 'unexpected next link');
    const path = next ? next.slice(GRAPH_ORIGIN.length) : `/v1.0/teams/${enc(teamId)}/channels/${enc(channelId)}/messages?$top=50&$expand=replies`;
    const page = MessagesPage.parse(await this.call('GET', path));
    const messages = page.value.map((raw) => ChannelMessage.safeParse(raw)).flatMap((r) => (r.success ? [r.data] : []));
    return { messages, next: page['@odata.nextLink'] ?? null };
  }

  async members(teamId: string, channelId: string) {
    const out: ChannelMember[] = [];
    let path: string | null = `/v1.0/teams/${enc(teamId)}/channels/${enc(channelId)}/members`;
    while (path) {
      const r = (await this.call('GET', path)) as { value?: unknown[]; '@odata.nextLink'?: string };
      for (const raw of r.value ?? []) {
        const m = ChannelMember.safeParse(raw);
        if (m.success) out.push(m.data);
      }
      const next: string | undefined = r['@odata.nextLink'];
      path = next && next.startsWith(`${GRAPH_ORIGIN}/`) ? next.slice(GRAPH_ORIGIN.length) : null;
    }
    return out;
  }

  async createSubscription(input: { teamId: string; channelId: string; notificationUrl: string; clientState: string; expiresAt: string }) {
    const r = (await this.call('POST', '/v1.0/subscriptions', {
      changeType: 'created,updated',
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: `/teams/${input.teamId}/channels/${input.channelId}/messages`,
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

  private async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
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
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(`graph ${res.status} ${code}`);
    throw new GraphError(res.status, code);
  }
}
