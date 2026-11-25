import { GatewayAuthError } from '../../src/ports/gateway';
import type { TeamRef, TeamsApi } from '../../src/connectors/teams/api';
import { ChannelMessage, type ChannelMember } from '../../src/connectors/teams/message';

/** Teams の偽物（つないだ人の委任）。投稿は最後に動いた順に返し、pageSize ごとにページを切る */
export class FakeTeams implements TeamsApi {
  readonly posts: ChannelMessage[] = [];
  memberList: ChannelMember[] = [];
  readonly subscriptions = new Map<string, { resource: string; notificationUrl: string; expiresAt: string }>();
  readonly calls: string[] = [];
  teamList: TeamRef[] = [{ id: 'team-1', name: '全社' }];
  channelList: TeamRef[] = [{ id: '19:ch@thread.skype', name: '電話対応' }];
  pageSize = 2;
  authBroken = false;
  private seq = 0;

  constructor(readonly now: () => string) {}

  post(raw: unknown) {
    this.posts.push(ChannelMessage.parse(raw));
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async joinedTeams() {
    this.check('joinedTeams');
    return this.teamList;
  }

  async channels(teamId: string) {
    this.check(`channels ${teamId}`);
    return this.channelList;
  }

  async messages(teamId: string, channelId: string, next?: string) {
    this.check(`messages ${next ?? 'first'}`);
    const last = (m: ChannelMessage) => [m.lastModifiedDateTime ?? m.createdDateTime, ...(m.replies ?? []).map((r) => r.createdDateTime)].sort().at(-1)!;
    const sorted = [...this.posts].sort((a, b) => last(b).localeCompare(last(a)));
    const start = next ? Number(new URL(next).searchParams.get('skip')) : 0;
    const page = sorted.slice(start, start + this.pageSize);
    const more = start + this.pageSize < sorted.length;
    return { messages: page, next: more ? `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/x/messages?skip=${start + this.pageSize}` : null };
  }

  async members() {
    this.check('members');
    return this.memberList;
  }

  async createSubscription(input: { teamId: string; channelId: string; notificationUrl: string; expiresAt: string }) {
    this.check('createSubscription');
    const id = `sub-${++this.seq}`;
    this.subscriptions.set(id, { resource: `/teams/${input.teamId}/channels/${input.channelId}/messages`, notificationUrl: input.notificationUrl, expiresAt: input.expiresAt });
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
