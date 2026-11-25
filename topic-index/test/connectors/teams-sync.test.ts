import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { lastActivity, planPage } from '../../src/connectors/teams/plan';
import { ChannelMessage } from '../../src/connectors/teams/message';
import { TeamsSync } from '../../src/connectors/teams/sync';
import { connectTeamsChannel, Directory, planMasterEdit, type SharedSpacePlan } from '../../src/domain';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeTeams } from '../helpers/fake-teams';
import { answer, seed } from '../helpers/world';

// Teams のチャネルの同期（0036 の決定 6・0037）

const T0 = '2026-11-05T03:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const TENANT = 'tenant-1';
const CH = '19:ch@thread.skype';
const URL_ = 'https://gw.test/topic-index/webhooks/graph';

const user = (oid: string) => ({ user: { id: oid, displayName: oid, tenantId: TENANT } });
const post = (id: string, createdMin: number, replies: Array<[string, number, string]> = [], over: Record<string, unknown> = {}) => ({
  id,
  replyToId: null,
  messageType: 'message',
  createdDateTime: at(createdMin),
  lastModifiedDateTime: at(createdMin),
  subject: `件 ${id}`,
  body: { contentType: 'html', content: `<p>投稿 ${id}</p>` },
  from: user('oid-alice'),
  mentions: [],
  replies: replies.map(([rid, min, oid]) => ({ id: rid, replyToId: id, messageType: 'message', createdDateTime: at(min), body: { contentType: 'html', content: `<p>返信 ${rid}</p>` }, from: user(oid), mentions: [] })),
  ...over,
});

describe('Teams の走査の計画（0036 の決定 6）', () => {
  it('最後に動いた時刻は返信を含む。重なり（1 日）より前に動いたきりのページで止まる。つなぐ前のメッセージは取らない', () => {
    const p = ChannelMessage.parse(post('1', -60, [['1r', 30, 'oid-bob']]));
    expect(lastActivity(p)).toBe(at(30));
    const old = ChannelMessage.parse(post('0', -3 * 24 * 60));
    const r = planPage([p, old], at(0), at(0));
    expect(r.items.map((i) => i.msg.id)).toEqual(['1r']);
    expect(r.done).toBe(false);
    expect(planPage([old], at(0), at(0)).done).toBe(true);
  });
});

describe('H3 H8 Teams の同期（偽の Teams）', () => {
  let now: string;
  let teams: FakeTeams;
  let state: MemoryConnectorState;
  let queued: SyncJob[];
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    let plan!: SharedSpacePlan;
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectTeamsChannel(d, { dir: new Directory(d), now: T0, newId: counterIds() }, {
        userId: 'u_alice',
        gatewayCredentialId: 'gw_graph',
        teamId: 'team-1',
        teamName: '全社',
        channelId: CH,
        channelName: '電話対応',
        tenantId: TENANT,
        objectId: 'oid-alice',
      });
    });
    const made = await makeService(after, { decide: () => answer({ needs_response: true }) });
    made.clock.set(T0);
    const ds = plan.dataSource;
    await state.putSource({ kind: 'teams', dataSourceId: ds.id, userId: 'u_alice', gatewayCredentialId: 'gw_graph', status: 'setup', reason: null, folders: {}, teams: { syncedUntil: T0 }, connectedAt: T0, lastSyncAt: null, lastRetryAt: null });
    const sync = new TeamsSync({
      service: made.service,
      state,
      queue: { send: async (j) => void queued.push(j) },
      teamsFor: async () => teams,
      now: () => now,
      notificationUrl: URL_,
      newClientState: () => 'cs',
      hash: async (t) => `h(${t})`,
    });
    return { ...made, sync, ds };
  }

  const readers = async () => {
    const dir = await ctx.service.directory();
    return dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id)!.id).sort();
  };
  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);

  beforeEach(async () => {
    now = T0;
    teams = new FakeTeams(() => now);
    // Alice と Bob はチャネルのメンバー（Entra の ID でゲートウェイの User に対応が付く）。Eve は User でない
    teams.memberList = [
      { userId: 'oid-alice', tenantId: TENANT, roles: ['owner'] },
      { userId: 'oid-bob', tenantId: TENANT, roles: [] },
      { userId: 'oid-nobody', tenantId: TENANT, roles: [] },
    ];
    state = new MemoryConnectorState();
    queued = [];
    ctx = await setup();
  });

  it('setup: 読者をメンバーから写す（User のある人だけ）。つないだ人がメンバーと対応しなければ、サブスクリプションを作る前に broken', async () => {
    // テストの seed の User ID を、Entra の形のゲートウェイの User ID に見立てる
    await ctx.service.changeMaster(null, 'User', (d) => {
      d.users.push({ id: `entra_${TENANT}_oid-bob`, name: 'Bob (Entra)' });
    });
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await readers()).toEqual([`entra_${TENANT}_oid-bob`]);
    expect(teams.subscriptions.size).toBe(0);
    // つないだ人（seed の u_alice）は Entra の形の User ではないので、メンバーと対応が付かず broken になる
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/メンバーでなくなった/) });
  });

  describe('つないだ人がメンバーとして対応が付く', () => {
    beforeEach(async () => {
      // つないだ人を Entra の形の User にする（実物と同じ）
      await ctx.service.changeMaster(null, 'User', (d) => {
        d.users.push({ id: `entra_${TENANT}_oid-alice`, name: 'Alice' }, { id: `entra_${TENANT}_oid-bob`, name: 'Bob' });
        const cred = d.credentialRefs.find((c) => c.principal.kind === 'user' && c.principal.userId === 'u_alice' && c.gatewayCredentialId === 'gw_graph')!;
        cred.principal = { kind: 'user', userId: `entra_${TENANT}_oid-alice` };
        const p = d.contacts.find((c) => c.id === 'p_alice')!;
        p.userId = `entra_${TENANT}_oid-alice`;
      });
    });

    it('setup → 走査: つないだあとの投稿と返信を取り込み、返信は投稿のスレッドに入る。メンションで名指しが付く', async () => {
      teams.post(post('1', -120, [['1r', 5, 'oid-bob']]));
      teams.post(post('2', 3, [], { mentions: [{ id: 0, mentioned: user('oid-bob') }], body: { contentType: 'html', content: '<p><at id="0">Bob</at> 折り返しお願いします</p>' } }));
      now = at(10);
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      expect(await readers()).toEqual([`entra_${TENANT}_oid-alice`, `entra_${TENANT}_oid-bob`]);
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: at(10), teams: { syncedUntil: at(10), readersSyncedAt: at(10) } });
      expect([...teams.subscriptions.values()]).toEqual([{ resource: `/teams/team-1/channels/${CH}/messages`, notificationUrl: URL_, expiresAt: expect.any(String) }]);
      const ts = await threads();
      // 投稿 1 はつなぐ前なので取らない（返信 1r はつないだあと: 投稿のスレッドがないので新しいスレッドになる）。投稿 2 は取る
      const bodies = Object.values((await ctx.service.state()).signals).filter((s) => s.dataSourceId === ctx.ds.id).map((s) => s.body).sort();
      expect(bodies).toEqual(['@Bob 折り返しお願いします', '返信 1r']);
      expect(ts.length).toBe(2);
    });

    it('通知の走査は重なりで同じものを読んでも二重にならない。新しい返信は投稿のスレッドに入る', async () => {
      teams.post(post('2', 3));
      now = at(10);
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      teams.posts[0]!.replies = [ChannelMessage.parse(post('2r', 20, [], { replyToId: '2', from: user('oid-bob') })) as never];
      now = at(25);
      await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'messages' });
      const ts = await threads();
      expect(ts).toHaveLength(1);
      expect(ts[0]!.signalIds).toHaveLength(2);
    });

    it('見回り: 10 分おきに走査、60 分ごとに読者を写し直す。外れた人は読者から外れる', async () => {
      now = at(1);
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      teams.memberList = teams.memberList.filter((m) => m.userId !== 'oid-bob');
      const calls = () => teams.calls.filter((c) => c.startsWith('messages')).length;
      const before = calls();
      now = at(5);
      await ctx.sync.handle({ kind: 'maintain' });
      expect(calls()).toBe(before);
      now = at(12);
      await ctx.sync.handle({ kind: 'maintain' });
      expect(calls()).toBe(before + 1);
      expect(await readers()).toEqual([`entra_${TENANT}_oid-alice`, `entra_${TENANT}_oid-bob`]);
      now = at(62);
      await ctx.sync.handle({ kind: 'maintain' });
      expect(await readers()).toEqual([`entra_${TENANT}_oid-alice`]);
    });

    it('外したらサブスクリプションを消す', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      expect(teams.subscriptions.size).toBe(1);
      await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected' });
      await ctx.sync.handle({ kind: 'disconnect', dataSourceId: ctx.ds.id });
      expect(teams.subscriptions.size).toBe(0);
    });
  });
});
