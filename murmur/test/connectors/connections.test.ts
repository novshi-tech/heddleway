import { beforeEach, describe, expect, it } from 'vitest';
import { Connections } from '../../src/app/connections';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { connectorOwner, connectSharedSpace, deriveViewer } from '../../src/domain';
import { ConsentRequired, GatewayAuthError, type GatewayCredential, type GatewayPort, type UpstreamKind } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeGraph } from '../helpers/fake-graph';
import { FakeJira } from '../helpers/fake-jira';
import { FakeTeams } from '../helpers/fake-teams';
import { FakeTodo } from '../helpers/fake-todo';
import { seed } from '../helpers/world';

// 個人の箱をつなぐ（0024 の決定 3）。ゲートウェイは口（ports/gateway.ts）の偽物。
// 本物はゲートウェイの中核（heddleway の src/feature-port.ts）で、そちらのテストは test/murmur-feature.test.ts。

const GATEWAY = 'https://gateway.test';

/** 種類ごとのゲートウェイの接続先（本物は組み立て時に決まる。Teams は Graph の接続で読む） */
const serviceOf = (kind: UpstreamKind) => (kind === 'teams' ? 'graph' : kind);

/** ゲートウェイの口の偽物。本人が「有効にする」を押すと同意が残り、コールバックに本人のコードで戻ってくる */
class FakeGatewayPort implements GatewayPort {
  readonly homeUrl = `${GATEWAY}/`;
  readonly consents = new Set<string>();
  readonly credentialsOf = new Map<string, GatewayCredential[]>();
  /** ゲートウェイでつなぎ直しが要る接続 */
  readonly reconnect = new Set<string>();
  private n = 0;

  readonly admins = new Set<string>();

  async authenticate() {
    return null;
  }

  async isAdmin(userId: string) {
    return this.admins.has(userId);
  }

  async credentials(userId: string, kind: UpstreamKind) {
    if (!this.consents.has(userId)) throw new ConsentRequired();
    return (this.credentialsOf.get(userId) ?? []).filter((c) => c.service === serviceOf(kind));
  }

  async upstream(userId: string, credentialId: string) {
    if (!this.consents.has(userId)) throw new ConsentRequired();
    if (this.reconnect.has(credentialId)) throw new GatewayAuthError(`credential ${credentialId} must be reconnected`);
    return async () => new Response('{}');
  }

  readonly consent: GatewayPort['consent'] = {
    begin: async () => {
      const state = `st${++this.n}`;
      return { url: `${GATEWAY}/features/murmur/consent?state=${state}`, state, secret: '' };
    },
    complete: async ({ userId, code, kind }) => {
      if (code !== `code:${userId}`) return 'wrong_user';
      return (this.credentialsOf.get(userId) ?? []).some((c) => c.service === serviceOf(kind)) ? 'ok' : 'no_credential';
    },
  };

  /** 本人（サインインしている人）が有効にする画面で「有効にする」を押した */
  approve(user: string) {
    this.consents.add(user);
    return `code:${user}`;
  }
}

describe('H3 個人の箱をつなぐ', () => {
  let gw: FakeGatewayPort;
  let state: MemoryConnectorState;
  let queued: SyncJob[];
  let now: string;
  let ctx: Awaited<ReturnType<typeof setup>>;
  let jira: FakeJira;
  let sharedServices: string[];
  let teams: FakeTeams;
  let todo: FakeTodo;

  async function setup(world = seed) {
    const made = await makeService(world);
    const connections = new Connections({
      gateway: gw,
      state,
      now: () => now,
      service: made.service,
      queue: { send: async (j) => void queued.push(j) },
      newId: counterIds(),
      graphFor: () => new FakeGraph({ id: 'oid', displayName: 'Bob', addresses: ['bob@ubs.example', 'bob.alias@ubs.example'] }),
      jiraFor: () => jira,
      teamsFor: () => teams,
      todoFor: () => todo,
      sharedServices,
    });
    return { ...made, connections };
  }

  /** つなぐを頼み、本人が許可して戻ってくる */
  async function consent(asUser: string, credentialId?: string) {
    const r = await ctx.connections.connectOutlook('u_bob', credentialId);
    if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
    const url = new URL(r.authorize_url);
    expect(url.origin + url.pathname).toBe(`${GATEWAY}/features/murmur/consent`);
    return ctx.connections.callback({ state: url.searchParams.get('state'), code: gw.approve(asUser), error: null });
  }

  beforeEach(async () => {
    gw = new FakeGatewayPort();
    gw.credentialsOf.set('u_bob', [{ id: 'gw_bob', service: 'graph', label: 'ubs' }, { id: 'gw_freee', service: 'freee', label: 'ubs' }]);
    gw.credentialsOf.set('u_alice', [{ id: 'gw_alice', service: 'graph', label: 'ubs' }]);
    state = new MemoryConnectorState();
    queued = [];
    now = '2026-10-30T00:00:00.000Z';
    jira = new FakeJira(() => now);
    teams = new FakeTeams(() => now);
    todo = new FakeTodo(undefined, { id: 'oid_bob', displayName: 'Bob', addresses: ['bob.todo@ubs.example'] });
    sharedServices = ['jira'];
    ctx = await setup();
  });

  it('同意がなければ有効にする画面の URL → 有効にする → データソースを作り（読者は本人だけ）、キューに setup を積む', async () => {
    expect(await consent('u_bob')).toMatchObject({ ok: true });
    const dir = await ctx.service.directory();
    const ds = dir.seed.dataSources.find((d) => d.kind === 'service' && d.connector)!;
    expect(ds.name).toBe('Bob の Outlook');
    expect(connectorOwner(dir.seed, ds)).toBe('u_bob');
    expect(deriveViewer(dir, 'u_alice').dataSourceIds).not.toContain(ds.id);
    expect(queued).toEqual([{ kind: 'setup', dataSourceId: ds.id }]);
    expect(await state.source(ds.id)).toMatchObject({ userId: 'u_bob', gatewayCredentialId: 'gw_bob', status: 'setup', connectedAt: now });
    expect(await ctx.connections.list('u_bob')).toEqual([expect.objectContaining({ data_source: ds.id, status: 'setup' })]);
  });

  it('同意があれば有効にする画面を飛ばし、何度呼んでも同じデータソース', async () => {
    await consent('u_bob');
    const again = await ctx.connections.connectOutlook('u_bob');
    expect(again).toMatchObject({ status: 'connected', created: false });
    expect((await ctx.service.directory()).seed.dataSources.filter((d) => d.kind === 'service' && d.connector)).toHaveLength(1);
  });

  it('有効にしたのが頼んだ本人でなければ作らない', async () => {
    expect(await consent('u_alice')).toMatchObject({ ok: false });
    expect(gw.consents.has('u_bob')).toBe(false);
    expect((await ctx.service.directory()).seed.dataSources.some((d) => d.kind === 'service' && d.connector)).toBe(false);
  });

  it('state は 1 回きりで、15 分で切れる', async () => {
    const r = await ctx.connections.connectOutlook('u_bob');
    const stateParam = new URL((r as { authorize_url: string }).authorize_url).searchParams.get('state');
    now = '2026-10-30T00:16:00.000Z';
    expect(await ctx.connections.callback({ state: stateParam, code: gw.approve('u_bob'), error: null })).toMatchObject({ ok: false });
    expect(await ctx.connections.callback({ state: stateParam, code: gw.approve('u_bob'), error: null })).toMatchObject({ ok: false });
  });

  it('Graph の接続が複数なら選んでもらう', async () => {
    gw.credentialsOf.set('u_bob', [{ id: 'gw_a', service: 'graph', label: 'a' }, { id: 'gw_b', service: 'graph', label: 'b' }]);
    await consent('u_bob');
    expect(await ctx.connections.connectOutlook('u_bob')).toMatchObject({ status: 'choose', credentials: [{ id: 'gw_a' }, { id: 'gw_b' }] });
    expect(await ctx.connections.connectOutlook('u_bob', 'gw_b')).toMatchObject({ status: 'connected', created: true });
  });

  it('サインインしていない User はつなげない（0030: Contact のない User でも個人のリストは作れる）', async () => {
    await expect(ctx.connections.connectOutlook('u_nobody')).rejects.toThrow(/サインイン/);
  });

  it('同意は有効で、選んだ接続がゲートウェイでつなぎ直しを要るときは 409（同意は捨てない。0023 の段取り 2）', async () => {
    await consent('u_bob');
    gw.reconnect.add('gw_bob');
    await expect(ctx.connections.connectOutlook('u_bob')).rejects.toMatchObject({ code: 'conflict' });
    expect(gw.consents.has('u_bob')).toBe(true);
  });

  it('本人がゲートウェイで無効にしていたら、もう一度有効にする画面の URL を返す', async () => {
    await consent('u_bob');
    gw.consents.delete('u_bob');
    now = '2026-10-30T02:00:00.000Z';
    expect((await ctx.connections.connectOutlook('u_bob')).status).toBe('authorize');
  });

  it('外す: disconnected にしてキューに積む。本人以外は外せない', async () => {
    await consent('u_bob');
    const [view] = await ctx.connections.list('u_bob');
    await expect(ctx.connections.disconnect('u_alice', view!.data_source)).rejects.toThrow(/not found/);
    expect(await ctx.connections.disconnect('u_bob', view!.data_source)).toEqual([expect.objectContaining({ status: 'disconnected' })]);
    expect(queued.at(-1)).toEqual({ kind: 'disconnect', dataSourceId: view!.data_source });
    // つなぎ直すと、その時点から取る
    now = '2026-10-31T00:00:00.000Z';
    expect(await ctx.connections.connectOutlook('u_bob')).toMatchObject({ status: 'connected', created: false });
    expect(await state.source(view!.data_source)).toMatchObject({ status: 'setup', connectedAt: now, folders: {} });
  });

  it('H3 共有リストを外せるのは作った人と管理者（0037 の決定 4）。ほかの読者には、ないのと同じ', async () => {
    const { result } = await ctx.service.changeMaster('u_alice', '共有リスト', (d, c) =>
      connectSharedSpace(d, c, { userId: 'u_alice', gatewayCredentialId: 'gw_alice', channel: 'jira', spaceKey: 'jira:cloud-1/SPW', name: 'SPW', identity: 'acct-alice' }),
    );
    const dsId = result.dataSource.id;
    await ctx.service.changeMaster('u_alice', '読者', (d) => d.listMembers.push({ listId: d.lists.find((l) => l.dataSourceId === dsId)!.id, userId: 'u_bob' }));
    await state.putSource({ kind: 'jira', dataSourceId: dsId, userId: 'u_alice', gatewayCredentialId: 'gw_alice', status: 'ok', reason: null, folders: {}, connectedAt: now, lastSyncAt: null, lastRetryAt: null });
    await expect(ctx.connections.disconnect('u_bob', dsId)).rejects.toThrow(/not found/);
    gw.admins.add('u_bob');
    await ctx.connections.disconnect('u_bob', dsId);
    expect(await state.source(dsId)).toMatchObject({ status: 'disconnected', reason: '管理者が外した' });
    expect(queued.at(-1)).toEqual({ kind: 'disconnect', dataSourceId: dsId });
  });

  describe('H3 Jira のプロジェクトの共有リスト（0037）', () => {
    async function consentJira(asUser: string, input: { projectKey?: string } = { projectKey: 'SPW' }) {
      const r = await ctx.connections.connectJira('u_bob', input);
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      const url = new URL(r.authorize_url);
      return ctx.connections.callback({ state: url.searchParams.get('state'), code: gw.approve(asUser), error: null });
    }

    beforeEach(() => {
      gw.credentialsOf.set('u_bob', [{ id: 'gw_bob', service: 'graph', label: 'ubs' }, { id: 'gw_jira', service: 'jira', label: 'Jira' }]);
      gw.credentialsOf.set('u_alice', [{ id: 'gw_alice_jira', service: 'jira', label: 'Jira' }]);
    });

    const sharedDs = async () => (await ctx.service.directory()).seed.dataSources.find((d) => d.kind === 'service' && d.shared)!;

    it('同意 → プロジェクトの共有リストを作る。範囲はプロジェクト（セキュリティレベル付きを除く）、作った人が読者、名乗りが Contact に付く', async () => {
      expect(await consentJira('u_bob')).toMatchObject({ ok: true, message: expect.stringMatching(/Jira/) });
      const ds = await sharedDs();
      expect(ds).toMatchObject({
        channel: 'jira',
        name: 'スポット作業（Jira）',
        group: true,
        shared: { spaceKey: 'jira:cloud-1/SPW', createdBy: 'u_bob' },
        connector: { kind: 'jira', cloudId: 'cloud-1', projectKey: 'SPW', jql: 'project = SPW AND level IS EMPTY' },
      });
      const dir = await ctx.service.directory();
      expect(dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ds.id)!.id)).toEqual(['u_bob']);
      expect(dir.contactIdOfAddress({ channel: 'jira', value: 'acct-bob' })).toBe('p_bob');
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: ds.id }]);
      expect(await state.source(ds.id)).toMatchObject({ kind: 'jira', userId: 'u_bob', gatewayCredentialId: 'gw_jira', status: 'setup' });
      expect(await ctx.connections.list('u_bob')).toEqual([expect.objectContaining({ kind: 'jira', project: 'SPW', shared: true, created_by: 'u_bob', status: 'setup' })]);
    });

    it('プロジェクトを指定しなければ、つなぐ人が見えるプロジェクトの一覧を返す。見えないプロジェクトはつなげない', async () => {
      await consent('u_bob');
      jira.projectList.push({ key: 'OPS', name: '運用' });
      expect(await ctx.connections.connectJira('u_bob')).toMatchObject({ status: 'choose_project', projects: [{ key: 'SPW' }, { key: 'OPS' }] });
      await expect(ctx.connections.connectJira('u_bob', { projectKey: 'NOPE' })).rejects.toThrow(/見えない/);
    });

    it('デプロイの設定で Jira の共有リストを許していなければ、つなげない（0037 の決定 4）', async () => {
      sharedServices = [];
      ctx = await setup();
      await consent('u_bob');
      await expect(ctx.connections.connectJira('u_bob', { projectKey: 'SPW' })).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('2 人目がつなぐと同じ共有リストで、その場で読者が写る（名乗った人だけ、アプリは外す）。動いていれば資格情報は変えない', async () => {
      await consentJira('u_bob');
      const ds = await sharedDs();
      await state.putSource({ ...(await state.source(ds.id))!, status: 'ok' });
      // Alice も自分の Jira で同じプロジェクトをつなぐ
      jira.browserList.push({ accountId: 'acct-alice', accountType: 'atlassian', active: true });
      const aliceJira = new FakeJira(() => now, undefined, { accountId: 'acct-alice', displayName: 'Alice' });
      aliceJira.browserList = jira.browserList;
      const asAlice = new Connections({ ...(ctx.connections as unknown as { deps: ConstructorParameters<typeof Connections>[0] }).deps, jiraFor: () => aliceJira });
      gw.approve('u_alice');
      expect(await asAlice.connectJira('u_alice', { projectKey: 'SPW' })).toMatchObject({ status: 'connected', created: false, data_source: { id: ds.id } });
      const dir = await ctx.service.directory();
      expect(dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ds.id)!.id).sort()).toEqual(['u_alice', 'u_bob']);
      expect(await state.source(ds.id)).toMatchObject({ userId: 'u_bob', status: 'ok' });
      // Alice の一覧にも出る（読者になっている共有リスト）
      expect(await ctx.connections.list('u_alice')).toEqual([expect.objectContaining({ data_source: ds.id, shared: true, created_by: 'u_bob' })]);
    });

    it('止まっている共有リストに別の読者がつなぐと、その人の委任でつなぎ直す（作った人は変わらない）', async () => {
      await consentJira('u_bob');
      const ds = await sharedDs();
      await state.putSource({ ...(await state.source(ds.id))!, status: 'broken', reason: 'つないだ人がプロジェクトを閲覧できなくなった' });
      jira.browserList.push({ accountId: 'acct-alice', accountType: 'atlassian', active: true });
      const aliceJira = new FakeJira(() => now, undefined, { accountId: 'acct-alice', displayName: 'Alice' });
      aliceJira.browserList = jira.browserList;
      const asAlice = new Connections({ ...(ctx.connections as unknown as { deps: ConstructorParameters<typeof Connections>[0] }).deps, jiraFor: () => aliceJira });
      gw.approve('u_alice');
      queued = [];
      expect(await asAlice.connectJira('u_alice', { projectKey: 'SPW' })).toMatchObject({ status: 'connected', created: false });
      expect(await state.source(ds.id)).toMatchObject({ userId: 'u_alice', gatewayCredentialId: 'gw_alice_jira', status: 'setup' });
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: ds.id }]);
      const after = await sharedDs();
      expect(after.kind === 'service' && after.shared?.createdBy).toBe('u_bob');
    });

    it('ゲートウェイに Jira の接続がなければ、つなげない', async () => {
      gw.credentialsOf.set('u_bob', [{ id: 'gw_bob', service: 'graph', label: 'ubs' }]);
      expect(await consentJira('u_bob')).toMatchObject({ ok: false, message: expect.stringMatching(/Jira/) });
      expect(gw.consents.has('u_bob')).toBe(true);
      expect(await ctx.connections.connectJira('u_bob', { projectKey: 'SPW' })).toMatchObject({ status: 'no_credential' });
    });
  });
  describe('H3 To Do のタスクのリスト（0039）', () => {
    async function consentTodo(asUser: string) {
      const r = await ctx.connections.connectTodo('u_bob');
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      return ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve(asUser), error: null });
    }

    it('同意 → リストを選んでもらう → 個人リストを作り（読者は本人だけ）、キューに setup を積む。何度呼んでも同じ', async () => {
      expect(await consentTodo('u_bob')).toMatchObject({ ok: true, message: expect.stringMatching(/リスト/) });
      expect(await ctx.connections.connectTodo('u_bob')).toEqual({
        status: 'choose_list',
        lists: [
          { id: 'L_default', name: 'タスク', wellknown: 'defaultList' },
          { id: 'L_murmur', name: 'Murmur', wellknown: null },
        ],
      });
      const r = await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' });
      expect(r).toMatchObject({ status: 'connected', created: true, data_source: { name: 'Bob の To Do（Murmur）' } });
      const id = r.status === 'connected' ? r.data_source.id : '';
      const dir = await ctx.service.directory();
      expect(dir.dataSource(id)).toMatchObject({ channel: 'todo', connector: { kind: 'graph-todo', listId: 'L_murmur', listName: 'Murmur' } });
      expect(dir.readersOfList(dir.listOfDataSource(id)!.id)).toEqual(['u_bob']);
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: id }]);
      expect(await state.source(id)).toMatchObject({ kind: 'todo', gatewayCredentialId: 'gw_bob', status: 'setup' });
      expect(await ctx.connections.list('u_bob')).toEqual([expect.objectContaining({ data_source: id, kind: 'todo', list: 'Murmur' })]);
      expect(await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' })).toMatchObject({ status: 'connected', created: false });
    });

    it('見えないリストはつなげない。1 つのアカウントでつなぐリストは 1 つ（0039 の未決 2）', async () => {
      await consentTodo('u_bob');
      await expect(ctx.connections.connectTodo('u_bob', { listId: 'L_nope' })).rejects.toMatchObject({ code: 'not_found' });
      await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' });
      await expect(ctx.connections.connectTodo('u_bob', { listId: 'L_default' })).rejects.toMatchObject({ code: 'conflict' });
    });
  });

  describe('H3 Teams のチャネルの共有リスト（0036・0037）', () => {
    const TID = '11111111-1111-1111-1111-111111111111';
    const BOB = '22222222-2222-2222-2222-222222222222';
    const ALICE = '33333333-3333-3333-3333-333333333333';
    const U_BOB = `entra_${TID}_${BOB}`;
    const U_ALICE = `entra_${TID}_${ALICE}`;

    beforeEach(async () => {
      sharedServices = ['jira', 'teams'];
      ctx = await setup({ ...seed, users: [...seed.users, { id: U_BOB, name: 'Bob' }, { id: U_ALICE, name: 'Alice' }] });
      gw.credentialsOf.set(U_BOB, [{ id: 'gw_bob_graph', service: 'graph', label: 'ubs' }]);
      gw.credentialsOf.set(U_ALICE, [{ id: 'gw_alice_graph', service: 'graph', label: 'ubs' }]);
      gw.approve(U_BOB);
      teams.memberList = [
        { userId: BOB, tenantId: TID, displayName: 'Bob' },
        { userId: ALICE, tenantId: TID, displayName: 'Alice' },
        { userId: null, tenantId: null, displayName: 'ゲスト' },
      ] as never;
    });

    const sharedDs = async () => (await ctx.service.directory()).seed.dataSources.find((d) => d.kind === 'service' && d.shared)!;

    it('チーム → チャネルの順に選んでもらい、チャネルの共有リストを作る。作った人が読者、Entra の ID が名乗り', async () => {
      expect(await ctx.connections.connectTeams(U_BOB)).toMatchObject({ status: 'choose_team', teams: [{ id: 'team-1', name: '全社' }] });
      expect(await ctx.connections.connectTeams(U_BOB, { teamId: 'team-1' })).toMatchObject({ status: 'choose_channel', channels: [{ id: '19:ch@thread.skype' }] });
      await expect(ctx.connections.connectTeams(U_BOB, { teamId: 'team-x' })).rejects.toMatchObject({ code: 'not_found' });
      const r = await ctx.connections.connectTeams(U_BOB, { teamId: 'team-1', channelId: '19:ch@thread.skype' });
      expect(r).toMatchObject({ status: 'connected', created: true, data_source: { name: '全社 / 電話対応（Teams）' } });
      const ds = await sharedDs();
      expect(ds).toMatchObject({
        channel: 'teams',
        group: true,
        shared: { spaceKey: 'teams:team-1/19:ch@thread.skype', createdBy: U_BOB },
        connector: { kind: 'teams', teamId: 'team-1', channelId: '19:ch@thread.skype' },
      });
      const dir = await ctx.service.directory();
      expect(dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ds.id)!.id)).toEqual([U_BOB]);
      expect(await state.source(ds.id)).toMatchObject({ kind: 'teams', userId: U_BOB, gatewayCredentialId: 'gw_bob_graph', status: 'setup', teams: { syncedUntil: now } });
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: ds.id }]);
      expect(await ctx.connections.list(U_BOB)).toEqual([expect.objectContaining({ kind: 'teams', team: 'team-1', channel: '19:ch@thread.skype', shared: true, created_by: U_BOB, status: 'setup' })]);
    });

    it('2 人目がつなぐと同じ共有リストで、その場でチャネルのメンバーが読者に写る（ゲストは外れる）', async () => {
      await ctx.connections.connectTeams(U_BOB, { teamId: 'team-1', channelId: '19:ch@thread.skype' });
      const ds = await sharedDs();
      await state.putSource({ ...(await state.source(ds.id))!, status: 'ok' });
      gw.approve(U_ALICE);
      expect(await ctx.connections.connectTeams(U_ALICE, { teamId: 'team-1', channelId: '19:ch@thread.skype' })).toMatchObject({ status: 'connected', created: false, data_source: { id: ds.id } });
      const dir = await ctx.service.directory();
      expect(dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ds.id)!.id).sort()).toEqual([U_BOB, U_ALICE].sort());
      expect(await state.source(ds.id)).toMatchObject({ userId: U_BOB, status: 'ok' });
    });

    it('デプロイの設定で許していない・Entra でサインインしていない人は、つなげない', async () => {
      sharedServices = ['jira'];
      ctx = await setup({ ...seed, users: [...seed.users, { id: U_BOB, name: 'Bob' }] });
      await expect(ctx.connections.connectTeams(U_BOB, { teamId: 'team-1', channelId: '19:ch@thread.skype' })).rejects.toMatchObject({ code: 'forbidden' });
      sharedServices = ['teams'];
      ctx = await setup();
      gw.approve('u_bob');
      await expect(ctx.connections.connectTeams('u_bob', { teamId: 'team-1', channelId: '19:ch@thread.skype' })).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});
