import { beforeEach, describe, expect, it } from 'vitest';
import { Connections } from '../../src/app/connections';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { connectorOwner, connectSharedSpace, deriveViewer, seedProblems } from '../../src/domain';
import { ConsentRequired, GatewayAuthError, type GatewayCredential, type GatewayPort, type UpstreamKind } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeGraph } from '../helpers/fake-graph';
import { FakeJira } from '../helpers/fake-jira';
import { FakeTeams } from '../helpers/fake-teams';
import { FakeTodo } from '../helpers/fake-todo';
import { FakeGtasks } from '../helpers/fake-gtasks';
import { FakeGmail } from '../helpers/fake-gmail';
import { seed } from '../helpers/world';

// 個人の箱をつなぐ（0024 の決定 3）。ゲートウェイは口（ports/gateway.ts）の偽物。
// 本物はゲートウェイの中核（heddleway の src/feature-port.ts）で、そちらのテストは test/murmur-feature.test.ts。

const GATEWAY = 'https://gateway.test';

/** 種類ごとのゲートウェイの接続先（本物は組み立て時に決まる。Teams は Graph の接続で読む） */
const serviceOf = (kind: UpstreamKind) => (kind === 'teams' ? 'graph' : kind === 'gtasks' ? 'tasks' : kind);

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
  let gtasks: FakeGtasks;
  let gmail: FakeGmail;

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
      gtasksFor: () => gtasks,
      gmailFor: () => gmail,
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
    gtasks = new FakeGtasks(undefined, 'bob@gws.example');
    gmail = new FakeGmail('bob@gws.example', [
      { sendAsEmail: 'bob@gws.example', displayName: 'Bob Tanaka', isPrimary: true },
      { sendAsEmail: 'sales@gws.example', verificationStatus: 'accepted' },
      { sendAsEmail: 'pending@gws.example', verificationStatus: 'pending' },
    ]);
    gw.credentialsOf.set('u_bob', [...gw.credentialsOf.get('u_bob')!, { id: 'gw_gmail', service: 'gmail', label: 'gws' }]);
    gw.credentialsOf.set('u_bob', [...gw.credentialsOf.get('u_bob')!, { id: 'gw_tasks', service: 'tasks', label: 'gws' }]);
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

  it('H3 Outlook: ゲートウェイの接続を消して足し直し（ID が変わった）ても、同じメールボックスとして付け替え、フォルダの位置を残してつなぎ直す。conflict にしない', async () => {
    await consent('u_bob');
    const [view] = await ctx.connections.list('u_bob');
    const id = view!.data_source;
    const folders = { inbox: { link: 'https://graph.example/delta?token=abc', lastReceivedAt: '2026-10-29T00:00:00.000Z' } };
    await state.putSource({ ...(await state.source(id))!, status: 'ok', folders });
    gw.credentialsOf.set('u_bob', [{ id: 'gw_bob_new', service: 'graph', label: 'ubs' }]);
    now = '2026-10-31T00:00:00.000Z';
    queued.length = 0;
    expect(await ctx.connections.connectOutlook('u_bob')).toMatchObject({ status: 'connected', created: false, data_source: { id } });
    const dir = await ctx.service.directory();
    expect(dir.seed.dataSources.filter((d) => d.kind === 'service' && d.connector?.kind === 'graph-mail')).toHaveLength(1);
    const ds = dir.dataSource(id) as { credentialRefId: string };
    expect(dir.credentialRef(ds.credentialRefId)).toMatchObject({ gatewayCredentialId: 'gw_bob_new' });
    expect(await state.source(id)).toMatchObject({ gatewayCredentialId: 'gw_bob_new', status: 'setup', folders, connectedAt: '2026-10-30T00:00:00.000Z' });
    expect(queued).toEqual([{ kind: 'setup', dataSourceId: id }]);
    // 同じ接続で何度呼んでも、動いているものは触らない（今までどおり）
    await state.putSource({ ...(await state.source(id))!, status: 'ok' });
    queued.length = 0;
    await ctx.connections.connectOutlook('u_bob');
    expect(queued).toEqual([]);
    expect(await state.source(id)).toMatchObject({ status: 'ok', gatewayCredentialId: 'gw_bob_new' });
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

    it('見えないリストはつなげない。リストはいくつでもつなげ、1 つずつが別の個人リストになる（フラグを付けたメールのリストも同じ。0039 の未決 2）', async () => {
      todo.listsInfo.push({ id: 'L_flagged', displayName: 'フラグを設定したメール', wellknownListName: 'flaggedEmails' });
      await consentTodo('u_bob');
      await expect(ctx.connections.connectTodo('u_bob', { listId: 'L_nope' })).rejects.toMatchObject({ code: 'not_found' });
      const a = await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' });
      const b = await ctx.connections.connectTodo('u_bob', { listId: 'L_flagged' });
      expect(b).toMatchObject({ status: 'connected', created: true, data_source: { name: 'Bob の To Do（フラグを設定したメール）' } });
      const ids = [a, b].map((r) => (r.status === 'connected' ? r.data_source.id : ''));
      expect(ids[0]).not.toBe(ids[1]);
      const dir = await ctx.service.directory();
      // 同じアカウントの資格情報を使い回し、どちらも読者は本人だけ
      expect(dir.dataSource(ids[0]!)!.credentialRefId).toBe(dir.dataSource(ids[1]!)!.credentialRefId);
      for (const id of ids) expect(dir.readersOfList(dir.listOfDataSource(id)!.id)).toEqual(['u_bob']);
      expect(queued).toEqual(ids.map((dataSourceId) => ({ kind: 'setup', dataSourceId })));
      expect((await ctx.connections.list('u_bob')).map((c) => c.list).sort()).toEqual(['Murmur', 'フラグを設定したメール']);
      expect(seedProblems((await ctx.service.directory()).seed)).toEqual([]);
    });

    it('ゲートウェイの接続を足し直して ID が変わっても、同じアカウントならつなげる。ほかのリストも新しい接続で読む', async () => {
      await consentTodo('u_bob');
      const first = await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' });
      const firstId = first.status === 'connected' ? first.data_source.id : '';
      await state.putSource({ ...(await state.source(firstId))!, status: 'broken', reason: 'credential must be reconnected' });
      gw.credentialsOf.set('u_bob', [{ id: 'gw_bob2', service: 'graph', label: 'ubs' }]);
      queued = [];
      const second = await ctx.connections.connectTodo('u_bob', { listId: 'L_default' });
      expect(second).toMatchObject({ status: 'connected', created: true });
      const secondId = second.status === 'connected' ? second.data_source.id : '';
      expect(await state.source(firstId)).toMatchObject({ gatewayCredentialId: 'gw_bob2', status: 'setup' });
      expect(await state.source(secondId)).toMatchObject({ gatewayCredentialId: 'gw_bob2' });
      expect(queued.map((j) => j.kind === 'setup' && j.dataSourceId).sort()).toEqual([firstId, secondId].sort());
      const dir = await ctx.service.directory();
      expect(dir.credentialRef(dir.dataSource(firstId)!.credentialRefId)?.gatewayCredentialId).toBe('gw_bob2');
      // 同じリストをもう一度つなげば、新しい接続で読み直す
      expect(await ctx.connections.connectTodo('u_bob', { listId: 'L_murmur' })).toMatchObject({ status: 'connected', created: false });
    });
  });

  describe('H3 Google Tasks のタスクのリスト（0041）', () => {
    async function consentGtasks(asUser: string) {
      const r = await ctx.connections.connectGoogleTasks('u_bob');
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      return ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve(asUser), error: null });
    }

    it('同意 → リストを選んでもらう → 個人リストを作り（読者は本人だけ。アドレスは userinfo のメール）、キューに setup を積む。何度呼んでも同じ', async () => {
      expect(await consentGtasks('u_bob')).toMatchObject({ ok: true, message: expect.stringMatching(/Google Tasks のタスクのリストを選んで/) });
      expect(await ctx.connections.connectGoogleTasks('u_bob')).toEqual({
        status: 'choose_list',
        lists: [
          { id: 'L_default', name: 'My Tasks', wellknown: null },
          { id: 'L_murmur', name: 'Murmur', wellknown: null },
        ],
      });
      const r = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' });
      expect(r).toMatchObject({ status: 'connected', created: true, data_source: { name: 'Bob の Google Tasks（Murmur）' } });
      const id = r.status === 'connected' ? r.data_source.id : '';
      const dir = await ctx.service.directory();
      expect(dir.dataSource(id)).toMatchObject({ channel: 'todo', connector: { kind: 'google-tasks', listId: 'L_murmur', listName: 'Murmur' } });
      expect(dir.credentialRef(dir.dataSource(id)!.credentialRefId)).toMatchObject({ address: { channel: 'todo', value: 'bob@gws.example' }, gatewayCredentialId: 'gw_tasks' });
      expect(dir.readersOfList(dir.listOfDataSource(id)!.id)).toEqual(['u_bob']);
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: id }]);
      expect(await state.source(id)).toMatchObject({ kind: 'gtasks', gatewayCredentialId: 'gw_tasks', status: 'setup', gtasks: { updatedMin: null } });
      expect(await ctx.connections.list('u_bob')).toEqual([expect.objectContaining({ data_source: id, kind: 'google-tasks', list: 'Murmur', status: 'setup' })]);
      expect(await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' })).toMatchObject({ status: 'connected', created: false });
      expect(seedProblems((await ctx.service.directory()).seed)).toEqual([]);
    });

    it('見えないリストはつなげない。リストはいくつでもつなげ、1 つずつが別の個人リストになる', async () => {
      await consentGtasks('u_bob');
      await expect(ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_nope' })).rejects.toMatchObject({ code: 'not_found' });
      const a = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' });
      const b = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_default' });
      expect(b).toMatchObject({ status: 'connected', created: true, data_source: { name: 'Bob の Google Tasks（My Tasks）' } });
      const ids = [a, b].map((r) => (r.status === 'connected' ? r.data_source.id : ''));
      const dir = await ctx.service.directory();
      expect(dir.dataSource(ids[0]!)!.credentialRefId).toBe(dir.dataSource(ids[1]!)!.credentialRefId);
      expect((await ctx.connections.list('u_bob')).map((c) => c.list).sort()).toEqual(['Murmur', 'My Tasks']);
    });

    it('名前が空のリストは、名前のないリスト用の名前でつなぐ（listName を空にしない）。選ぶ一覧にも同じ名前で出る', async () => {
      await consentGtasks('u_bob');
      gtasks.listsInfo.push({ id: 'L_blank', title: '' });
      const chosen = await ctx.connections.connectGoogleTasks('u_bob');
      expect(chosen).toMatchObject({ status: 'choose_list', lists: expect.arrayContaining([{ id: 'L_blank', name: '(名前のないリスト)', wellknown: null }]) });
      const r = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_blank' });
      expect(r).toMatchObject({ status: 'connected', created: true, data_source: { name: 'Bob の Google Tasks（(名前のないリスト)）' } });
      const id = r.status === 'connected' ? r.data_source.id : '';
      expect((await ctx.service.directory()).dataSource(id)).toMatchObject({ connector: { kind: 'google-tasks', listId: 'L_blank', listName: '(名前のないリスト)' } });
      expect(seedProblems((await ctx.service.directory()).seed)).toEqual([]);
      expect(await state.source(id)).toMatchObject({ status: 'setup', gtasks: { updatedMin: null, setupAt: expect.any(String) } });
    });

    it('アカウントのアドレスがわからない（email がない・確認済みでない）ならつながない（To Do が本人を特定できないときと同じ）', async () => {
      await consentGtasks('u_bob');
      gtasks.email = '';
      await expect(ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' })).rejects.toMatchObject({ code: 'invalid' });
      expect(await state.sources()).toEqual([]);
      expect(queued).toEqual([]);
    });

    it('ゲートウェイに Google Tasks の接続がなければ no_credential。To Do（graph）の接続は使わない', async () => {
      gw.credentialsOf.set('u_bob', [{ id: 'gw_bob', service: 'graph', label: 'ubs' }]);
      const r = await ctx.connections.connectGoogleTasks('u_bob');
      if (r.status !== 'authorize') throw new Error('expected authorize');
      const done = await ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve('u_bob'), error: null });
      expect(done).toMatchObject({ ok: false, message: expect.stringMatching(/Google Tasks の接続がありません/) });
      expect(await ctx.connections.connectGoogleTasks('u_bob')).toMatchObject({ status: 'no_credential' });
    });

    it('ゲートウェイの接続を足し直して ID が変わっても、同じアカウントならつなげる。ほかのリストも新しい接続で読む', async () => {
      await consentGtasks('u_bob');
      const first = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' });
      const firstId = first.status === 'connected' ? first.data_source.id : '';
      await state.putSource({ ...(await state.source(firstId))!, status: 'broken', reason: 'credential must be reconnected' });
      gw.credentialsOf.set('u_bob', [{ id: 'gw_tasks2', service: 'tasks', label: 'gws' }]);
      queued = [];
      const second = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_default' });
      const secondId = second.status === 'connected' ? second.data_source.id : '';
      expect(await state.source(firstId)).toMatchObject({ gatewayCredentialId: 'gw_tasks2', status: 'setup' });
      expect(queued.map((j) => j.kind === 'setup' && j.dataSourceId).sort()).toEqual([firstId, secondId].sort());
    });

    it('外す: disconnected にしてキューに積む（上流に消すものはない）。本人以外は外せない', async () => {
      await consentGtasks('u_bob');
      const r = await ctx.connections.connectGoogleTasks('u_bob', { listId: 'L_murmur' });
      const id = r.status === 'connected' ? r.data_source.id : '';
      await expect(ctx.connections.disconnect('u_alice', id)).rejects.toThrow(/not found/);
      expect(await ctx.connections.disconnect('u_bob', id)).toEqual([expect.objectContaining({ kind: 'google-tasks', status: 'disconnected' })]);
      expect(queued.at(-1)).toEqual({ kind: 'disconnect', dataSourceId: id });
      expect(gtasks.calls.filter((c) => c.fn === 'tasks')).toEqual([]);
    });
  });

  describe('H3 Gmail のメールボックス（0041）', () => {
    async function consentGmail(asUser: string, credentialId?: string) {
      const r = await ctx.connections.connectGmail('u_bob', credentialId);
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      return ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve(asUser), error: null });
    }

    it('同意 → 個人リストを作り（読者は本人だけ。アドレスは profile の主のアドレスだけ）、キューに setup を積む。何度呼んでも同じ', async () => {
      expect(await consentGmail('u_bob')).toMatchObject({ ok: true, message: expect.stringMatching(/Bob Tanaka の Gmail をつなぎました。これから届くメールを取り込みます/) });
      // 同意から戻ったところで作る（何度呼んでも同じデータソース）
      const queuedByConsent = [...queued];
      const r = await ctx.connections.connectGmail('u_bob');
      expect(r).toMatchObject({ status: 'connected', created: false, data_source: { name: 'Bob Tanaka の Gmail' } });
      const id = r.status === 'connected' ? r.data_source.id : '';
      const dir = await ctx.service.directory();
      const ds = dir.dataSource(id)!;
      expect(ds).toMatchObject({ channel: 'email', selfAddresses: [], connector: { kind: 'gmail', mailbox: 'me' } });
      expect(connectorOwner(dir.seed, ds)).toBe('u_bob');
      expect(dir.readersOfList(dir.listOfDataSource(id)!.id)).toEqual(['u_bob']);
      expect(deriveViewer(dir, 'u_alice').dataSourceIds).not.toContain(id);
      expect(dir.credentialRef(ds.credentialRefId)).toMatchObject({ address: { channel: 'email', value: 'bob@gws.example' }, gatewayCredentialId: 'gw_gmail' });
      // 本人の Contact に付くのは主のアドレスだけ。sendAs の別名（共有のアドレスかもしれない）は、確認済みでも付けない
      expect(dir.addressesOfContact('p_bob', 'email').map((a) => a.value).sort()).toEqual(['bob@gws.example']);
      expect(queuedByConsent).toEqual([{ kind: 'setup', dataSourceId: id }]);
      expect(await state.source(id)).toMatchObject({ kind: 'gmail', userId: 'u_bob', gatewayCredentialId: 'gw_gmail', status: 'setup', gmail: { historyId: null }, connectedAt: now });
      expect(await ctx.connections.list('u_bob')).toEqual([expect.objectContaining({ data_source: id, kind: 'gmail', status: 'setup' })]);
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'connected', created: false });
      expect(seedProblems((await ctx.service.directory()).seed)).toEqual([]);
    });

    it('表示名がなければ、サインインの名前に倒れる（Google Tasks と同じ）', async () => {
      gmail.sendAsList = [{ sendAsEmail: 'bob@gws.example', isPrimary: true }];
      expect(await consentGmail('u_bob')).toMatchObject({ ok: true, message: expect.stringMatching(/Bob の Gmail をつなぎました/) });
    });

    it('主のアドレスが別の人のアドレスなら 409 でつながない（Outlook と同じ。何も残さない）', async () => {
      gmail.email = 'alice@ubs.example';
      gmail.sendAsList = [{ sendAsEmail: 'alice@ubs.example', displayName: 'Bob Tanaka', isPrimary: true }];
      const r = await ctx.connections.connectGmail('u_bob');
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      const back = ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve('u_bob'), error: null });
      await expect(back).rejects.toMatchObject({ code: 'conflict' });
      // 同意は残っているので、つなぎ直しを頼んでも同じ理由で断る
      await expect(ctx.connections.connectGmail('u_bob')).rejects.toMatchObject({ code: 'conflict' });
      expect(await state.sources()).toEqual([]);
      expect(queued).toEqual([]);
      expect((await ctx.service.directory()).seed.dataSources.some((d) => d.kind === 'service' && d.connector?.kind === 'gmail')).toBe(false);
    });

    it('別の人のアドレスが sendAs にあっても（共有のアドレスかもしれない）、つなげる。そのアドレスは本人のものにしない', async () => {
      gmail.sendAsList = [...gmail.sendAsList, { sendAsEmail: 'alice@ubs.example', verificationStatus: 'accepted' }];
      expect(await consentGmail('u_bob')).toMatchObject({ ok: true });
      const dir = await ctx.service.directory();
      expect(dir.addressesOfContact('p_bob', 'email').map((a) => a.value)).toEqual(['bob@gws.example']);
      expect(dir.addressesOfContact('p_alice', 'email').map((a) => a.value)).toEqual(['alice@ubs.example']);
    });

    it('同じ「送信元として使えるアドレス」（グループのアドレスなど）を持つ 2 人が、どちらもつなげる。共有のアドレスはどちらの本人のものにもならない。主のアドレスは今までどおり別の人のものなら conflict', async () => {
      gw.credentialsOf.set('u_alice', [...gw.credentialsOf.get('u_alice')!, { id: 'gw_gmail_alice', service: 'gmail', label: 'gws' }]);
      const shared = { sendAsEmail: 'sales@gws.example', displayName: 'Sales', verificationStatus: 'accepted' };
      gmail.sendAsList = [{ sendAsEmail: 'bob@gws.example', displayName: 'Bob Tanaka', isPrimary: true }, shared];
      expect(await consentGmail('u_bob')).toMatchObject({ ok: true });
      // 2 人目: 同じ共有のアドレスを sendAs に持つ
      gmail.email = 'alice2@gws.example';
      gmail.sendAsList = [{ sendAsEmail: 'alice2@gws.example', displayName: 'Alice Two', isPrimary: true }, shared];
      const r = await ctx.connections.connectGmail('u_alice');
      if (r.status !== 'authorize') throw new Error(`expected authorize, got ${r.status}`);
      expect(await ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve('u_alice'), error: null })).toMatchObject({ ok: true });
      const dir = await ctx.service.directory();
      expect(dir.addressesOfContact('p_bob', 'email').map((a) => a.value)).toEqual(['bob@gws.example']);
      expect(dir.addressesOfContact('p_alice', 'email').map((a) => a.value).sort()).toEqual(['alice2@gws.example', 'alice@ubs.example']);
      // 共有のアドレスは、どの Contact にも付いていない（そこから来たメールは本人の送信にならない）
      expect(dir.seed.addresses.filter((a) => a.value === 'sales@gws.example')).toEqual([]);
      expect((await ctx.connections.list('u_alice')).map((c) => c.kind)).toEqual(['gmail']);
      expect(seedProblems(dir.seed)).toEqual([]);
      // 主のアドレスが別の人のものなら、今までどおり conflict
      gw.credentialsOf.set('u_bob', [...gw.credentialsOf.get('u_bob')!, { id: 'gw_gmail_2', service: 'gmail', label: 'gws2' }]);
      gmail.email = 'alice2@gws.example';
      await expect(ctx.connections.connectGmail('u_bob', 'gw_gmail_2')).rejects.toMatchObject({ code: 'conflict' });
    });

    it('H3 ゲートウェイの接続を消して足し直し（ID が変わった）ても、同じメールボックスとして付け替え、位置を残してつなぎ直す（conflict にしない。古いデータソースを放置しない）', async () => {
      await consentGmail('u_bob');
      const r = await ctx.connections.connectGmail('u_bob');
      const id = r.status === 'connected' ? r.data_source.id : '';
      // 動いていた（位置あり）ところで、接続を足し直した
      await state.putSource({ ...(await state.source(id))!, status: 'ok', gmail: { historyId: '4242', recovery: null }, lastSyncAt: '2026-10-30T00:00:00.000Z' });
      gw.credentialsOf.set('u_bob', [{ id: 'gw_gmail_new', service: 'gmail', label: 'gws' }]);
      now = '2026-10-31T00:00:00.000Z';
      queued.length = 0;
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'connected', created: false, data_source: { id } });
      const dir = await ctx.service.directory();
      expect(dir.credentialRef((dir.dataSource(id) as { credentialRefId: string }).credentialRefId)).toMatchObject({ gatewayCredentialId: 'gw_gmail_new' });
      expect(dir.seed.dataSources.filter((d) => d.kind === 'service' && d.connector?.kind === 'gmail')).toHaveLength(1);
      expect(await state.source(id)).toMatchObject({
        gatewayCredentialId: 'gw_gmail_new',
        status: 'setup',
        reason: null,
        gmail: { historyId: '4242' },
        connectedAt: '2026-10-30T00:00:00.000Z',
        lastSyncAt: '2026-10-30T00:00:00.000Z',
      });
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: id }]);
      // 止まっていた（broken）ものも同じ
      await state.putSource({ ...(await state.source(id))!, status: 'broken', reason: 'credential must be reconnected' });
      gw.credentialsOf.set('u_bob', [{ id: 'gw_gmail_newer', service: 'gmail', label: 'gws' }]);
      await ctx.connections.connectGmail('u_bob');
      expect(await state.source(id)).toMatchObject({ gatewayCredentialId: 'gw_gmail_newer', status: 'setup', gmail: { historyId: '4242' } });
    });

    it('つなぎ直しの呼び出しが setup の前にもう一度来ても（setup は broken と別の状態）、残した位置・つないだ時刻を捨てない。外したあとは、その時点から取る', async () => {
      await consentGmail('u_bob');
      const r = await ctx.connections.connectGmail('u_bob');
      const id = r.status === 'connected' ? r.data_source.id : '';
      const kept = { historyId: '4242', recovery: { nextHistoryId: '5000', after: 1, pageToken: 'l:2', ids: ['a', 'b'], listed: false } };
      await state.putSource({ ...(await state.source(id))!, status: 'broken', reason: 'boom', gmail: kept });
      // 1 回目: broken → setup（位置は残る）。2 回目: setup のまま（setup が走る前）でも残る
      await ctx.connections.connectGmail('u_bob');
      expect(await state.source(id)).toMatchObject({ status: 'setup', gmail: kept, connectedAt: '2026-10-30T00:00:00.000Z' });
      now = '2026-10-31T00:00:00.000Z';
      await ctx.connections.connectGmail('u_bob');
      expect(await state.source(id)).toMatchObject({ status: 'setup', gmail: kept, connectedAt: '2026-10-30T00:00:00.000Z' });
      // 外したあとのつなぎ直しは、その時点から取る
      await ctx.connections.disconnect('u_bob', id);
      now = '2026-11-01T00:00:00.000Z';
      await ctx.connections.connectGmail('u_bob');
      expect(await state.source(id)).toMatchObject({ status: 'setup', gmail: { historyId: null, recovery: null }, connectedAt: now });
    });

    it('有効にしたのが頼んだ本人でなければ作らない。ゲートウェイに Gmail の接続がなければ no_credential（Outlook の graph の接続は使わない）', async () => {
      expect(await consentGmail('u_alice')).toMatchObject({ ok: false });
      gw.credentialsOf.set('u_bob', [{ id: 'gw_bob', service: 'graph', label: 'ubs' }]);
      const r = await ctx.connections.connectGmail('u_bob');
      if (r.status !== 'authorize') throw new Error('expected authorize');
      const done = await ctx.connections.callback({ state: new URL(r.authorize_url).searchParams.get('state'), code: gw.approve('u_bob'), error: null });
      expect(done).toMatchObject({ ok: false, message: expect.stringMatching(/Gmail の接続がありません/) });
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'no_credential' });
    });

    it('Gmail の接続が複数なら選んでもらう。サインインしていない User はつなげない', async () => {
      gw.credentialsOf.set('u_bob', [{ id: 'gw_a', service: 'gmail', label: 'a' }, { id: 'gw_b', service: 'gmail', label: 'b' }]);
      await consentGmail('u_bob');
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'choose', credentials: [{ id: 'gw_a' }, { id: 'gw_b' }] });
      expect(await ctx.connections.connectGmail('u_bob', 'gw_b')).toMatchObject({ status: 'connected', created: true });
      await expect(ctx.connections.connectGmail('u_nobody')).rejects.toThrow(/サインイン/);
    });

    it('Outlook と Gmail は別のデータソース（種類で区別する）', async () => {
      await consent('u_bob');
      // 同意は本人に 1 つ。Outlook をつないだあとは、Gmail の接続を選ぶだけで作れる
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'connected', created: true });
      expect((await ctx.connections.list('u_bob')).map((c) => c.kind).sort()).toEqual(['gmail', 'outlook']);
    });

    it('同意は有効で、選んだ接続がゲートウェイでつなぎ直しを要るときは 409', async () => {
      await consentGmail('u_bob');
      gw.reconnect.add('gw_gmail');
      await expect(ctx.connections.connectGmail('u_bob')).rejects.toMatchObject({ code: 'conflict' });
      expect(gw.consents.has('u_bob')).toBe(true);
    });

    it('外す: disconnected にしてキューに積む（上流に消すものはない）。本人以外は外せない。つなぎ直すと、その時点から取る', async () => {
      await consentGmail('u_bob');
      const r = await ctx.connections.connectGmail('u_bob');
      const id = r.status === 'connected' ? r.data_source.id : '';
      await state.putSource({ ...(await state.source(id))!, status: 'ok', gmail: { historyId: '4242', recovery: null } });
      await expect(ctx.connections.disconnect('u_alice', id)).rejects.toThrow(/not found/);
      expect(await ctx.connections.disconnect('u_bob', id)).toEqual([expect.objectContaining({ kind: 'gmail', status: 'disconnected' })]);
      expect(queued.at(-1)).toEqual({ kind: 'disconnect', dataSourceId: id });
      expect(gmail.calls.filter((c) => c.startsWith('message') || c.startsWith('history'))).toEqual([]);
      now = '2026-10-31T00:00:00.000Z';
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'connected', created: false });
      expect(await state.source(id)).toMatchObject({ status: 'setup', connectedAt: now, gmail: { historyId: null } });
    });

    it('broken からのつなぎ直しは位置を残す（止まっている間のメールを取り逃さない）', async () => {
      await consentGmail('u_bob');
      const r = await ctx.connections.connectGmail('u_bob');
      const id = r.status === 'connected' ? r.data_source.id : '';
      const first = await state.source(id);
      await state.putSource({ ...first!, status: 'broken', reason: 'credential must be reconnected', gmail: { historyId: '4242', recovery: null } });
      now = '2026-10-31T00:00:00.000Z';
      queued = [];
      expect(await ctx.connections.connectGmail('u_bob')).toMatchObject({ status: 'connected', created: false });
      expect(await state.source(id)).toMatchObject({ status: 'setup', gatewayCredentialId: 'gw_gmail', connectedAt: first!.connectedAt, gmail: { historyId: '4242' } });
      expect(queued).toEqual([{ kind: 'setup', dataSourceId: id }]);
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
