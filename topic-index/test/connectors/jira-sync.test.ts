import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import type { SourceState } from '../../src/connectors/graph/state';
import { isAllowed, JiraError } from '../../src/connectors/jira/api';
import { deltaJql, planJiraMaintenance, webhookFilter } from '../../src/connectors/jira/plan';
import { JiraSync } from '../../src/connectors/jira/sync';
import { connectJiraProject, Directory, planMasterEdit, assigneeOf, type SharedSpacePlan } from '../../src/domain';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { FakeJira } from '../helpers/fake-jira';
import { counterIds, makeService } from '../helpers/service';
import { answer, seed } from '../helpers/world';

// Jira の取り込み（0034 の決定 3・5。S2）。ゲートウェイと Jira は偽物

const T0 = '2026-11-04T05:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
/** Jira の時刻の書き方（+0900、コロンなし） */
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().replace('Z', '+0900');

function issue(key: string, updatedAt: string, over: { assignee?: string | null; createdAt?: string; status?: [string, string] } = {}) {
  return {
    id: key.replace(/\D/g, ''),
    key,
    fields: {
      summary: `${key} の件`,
      status: { name: over.status?.[0] ?? '進行中', statusCategory: { key: over.status?.[1] ?? 'indeterminate' } },
      assignee: over.assignee === null ? null : { accountId: over.assignee ?? 'acct-bob' },
      reporter: { accountId: 'acct-mori' },
      duedate: null,
      created: jst(over.createdAt ?? updatedAt),
      updated: jst(updatedAt),
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '説明' }] }] },
    },
  };
}
const comment = (id: string, author: string, createdAt: string, text: string) => ({
  id,
  author: { accountId: author },
  created: jst(createdAt),
  body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});

describe('H9 Jira の計画（純関数）', () => {
  it('差分の JQL: 相対時刻（前回からの分数 + 重なり 5 分）。開いているスレッドの課題も取る', () => {
    expect(deltaJql('assignee = currentUser()', [], at(0), at(12))).toBe('(assignee = currentUser()) AND updated >= -17m ORDER BY updated ASC');
    expect(deltaJql('project = SPW', ['SPW-1', 'SPW-2'], at(0), at(0))).toBe('((project = SPW) OR key in (SPW-1, SPW-2)) AND updated >= -6m ORDER BY updated ASC');
  });

  it('Webhook の jqlFilter: watcher は使えない（S0）ので、担当・起票に広げる', () => {
    expect(webhookFilter('assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()')).toBe('assignee = currentUser() OR reporter = currentUser()');
    expect(webhookFilter('project = SPW')).toBe('project = SPW');
  });

  it('見回り: 登録がなければ登録、期限の 7 日前から延長、10 分おきに差分。broken は 60 分おきに試し直す', () => {
    const base: SourceState = { kind: 'jira', dataSourceId: 'd', userId: 'u', gatewayCredentialId: 'g', status: 'ok', reason: null, folders: {}, connectedAt: at(0), lastSyncAt: at(0), lastRetryAt: null };
    expect(planJiraMaintenance({ ...base, jira: { syncedUntil: at(0), webhookIds: [], webhookExpiresAt: null } }, at(1), true)).toEqual({ kind: 'maintain', register: true, refresh: false, sync: false });
    const live = { syncedUntil: at(0), webhookIds: [1], webhookExpiresAt: at(30 * 24 * 60) };
    expect(planJiraMaintenance({ ...base, jira: live }, at(5), true)).toEqual({ kind: 'idle' });
    expect(planJiraMaintenance({ ...base, jira: live }, at(10), true)).toEqual({ kind: 'maintain', register: false, refresh: false, sync: true });
    expect(planJiraMaintenance({ ...base, jira: live }, at(24 * 24 * 60), true)).toMatchObject({ refresh: true });
    // Webhook を使わないデプロイは差分だけ
    expect(planJiraMaintenance({ ...base, jira: { ...live, webhookIds: [] } }, at(5), false)).toEqual({ kind: 'idle' });
    expect(planJiraMaintenance({ ...base, status: 'broken', lastRetryAt: at(0) }, at(30), true)).toEqual({ kind: 'idle' });
    expect(planJiraMaintenance({ ...base, status: 'broken', lastRetryAt: at(0) }, at(60), true)).toEqual({ kind: 'retry' });
    expect(planJiraMaintenance({ ...base, status: 'disconnected', jira: live }, at(1), true)).toEqual({ kind: 'cleanup' });
  });

  it('受け口の URL が変わったら（記録のない古いものも）登録し直す（0023 の段取り 4）', () => {
    const base: SourceState = { kind: 'jira', dataSourceId: 'd', userId: 'u', gatewayCredentialId: 'g', status: 'ok', reason: null, folders: {}, connectedAt: at(0), lastSyncAt: at(0), lastRetryAt: null };
    const live = { syncedUntil: at(0), webhookIds: [1], webhookExpiresAt: at(30 * 24 * 60), webhookUrlHash: 'new' };
    expect(planJiraMaintenance({ ...base, jira: live }, at(5), true, 'new')).toEqual({ kind: 'idle' });
    expect(planJiraMaintenance({ ...base, jira: { ...live, webhookUrlHash: 'old' } }, at(5), true, 'new')).toMatchObject({ register: true });
    const { webhookUrlHash: _, ...unrecorded } = live;
    expect(planJiraMaintenance({ ...base, jira: unrecorded }, at(5), true, 'new')).toMatchObject({ register: true });
  });

  it('呼べる口は読み取りと Webhook の管理だけ（0034 の決定 5）', () => {
    const site = '/ex/jira/cloud-1/rest/api/3';
    for (const [m, p] of [
      ['GET', '/oauth/token/accessible-resources'],
      ['GET', `${site}/myself`],
      ['GET', `${site}/search/jql`],
      ['GET', `${site}/issue/SPW-2040/comment`],
      ['POST', `${site}/webhook`],
      ['PUT', `${site}/webhook/refresh`],
      ['DELETE', `${site}/webhook`],
    ] as const) {
      expect(isAllowed(m, p)).toBe(true);
    }
    for (const [m, p] of [
      ['POST', `${site}/issue`],
      ['POST', `${site}/issue/SPW-2040/comment`],
      ['PUT', `${site}/issue/SPW-2040`],
      ['POST', `${site}/issue/SPW-2040/transitions`],
      ['DELETE', `${site}/issue/SPW-2040`],
      ['GET', `${site}/issue/SPW-2040/../../webhook`],
    ] as const) {
      expect(isAllowed(m, p)).toBe(false);
    }
  });
});

describe('H9 H5 Jira の同期（偽の Jira）', () => {
  let now: string;
  let jira: FakeJira;
  let state: MemoryConnectorState;
  let queued: SyncJob[];
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    let plan!: SharedSpacePlan;
    const newId = counterIds();
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectJiraProject(d, { dir: new Directory(d), now: T0, newId }, {
        userId: 'u_bob',
        gatewayCredentialId: 'gw_jira',
        cloudId: 'cloud-1',
        site: 'https://acme.atlassian.net',
        siteName: 'acme',
        projectKey: 'SPW',
        projectName: 'スポット作業',
        accountId: 'acct-bob',
      });
    });
    const made = await makeService(after, { decide: () => answer({ needs_response: true }) });
    made.clock.set(T0);
    const ds = plan.dataSource;
    await state.putSource({
      kind: 'jira',
      dataSourceId: ds.id,
      userId: 'u_bob',
      gatewayCredentialId: 'gw_jira',
      status: 'setup',
      reason: null,
      folders: {},
      jira: { syncedUntil: T0, webhookIds: [], webhookExpiresAt: null },
      connectedAt: T0,
      lastSyncAt: null,
      lastRetryAt: null,
    });
    const sync = new JiraSync({
      service: made.service,
      state,
      queue: { send: async (j) => void queued.push(j) },
      jiraFor: async () => jira,
      now: () => now,
      webhookUrlFor: async (userId) => `https://topic-index.test/webhooks/jira/secret-${userId}`,
    });
    return { ...made, sync, ds };
  }

  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);

  beforeEach(async () => {
    now = T0;
    jira = new FakeJira(() => now);
    state = new MemoryConnectorState();
    queued = [];
    ctx = await setup();
  });

  it('setup: 共有リストの Webhook はプロジェクトで絞って登録し、期限を延長の結果で置き、ok にする（0037）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect([...jira.webhooks.values()]).toEqual([
      expect.objectContaining({ url: 'https://topic-index.test/webhooks/jira/secret-u_bob', spec: { events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'], jqlFilter: 'project = SPW' } }),
    ]);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: T0, jira: { webhookIds: [1], webhookExpiresAt: at(30 * 24 * 60) } });
    // もう一度 setup しても Webhook は 1 つのまま（消してから登録し直す）
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(jira.webhooks.size).toBe(1);
  });

  it('通知 → 差分: つないだあとの更新だけ取り込み、写しとシグナルでスレッドになる。重なりで二重にならない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    // つなぐ前に起票された課題に、つないだあとでコメントが付いた
    jira.put(issue('SPW-1', at(3), { createdAt: at(-60 * 24) }), [comment('10', 'acct-mori', at(-60), '前のコメント'), comment('11', 'acct-mori', at(3), '確認お願いします')]);
    // つないだあとに起票された課題（担当は加藤）
    jira.put(issue('SPW-2', at(4), { assignee: 'acct-kato' }));
    now = at(5);
    expect(await ctx.sync.notified('u_bob')).toBe(1);
    expect(queued).toEqual([{ kind: 'jira-sync', dataSourceId: ctx.ds.id }]);
    await ctx.sync.handle(queued.shift()!);
    expect(jira.jqls.at(-1)).toBe('(project = SPW AND level IS EMPTY) AND updated >= -10m ORDER BY updated ASC');

    const ts = await threads();
    expect(ts.map((t) => [t.sourceKey, t.title, t.signalIds.length]).sort()).toEqual([
      ['SPW-1', 'SPW-1 の件', 1],
      ['SPW-2', 'SPW-2 の件', 1],
    ]);
    const p = await ctx.service.state();
    const dir = await ctx.service.directory();
    const spw1 = ts.find((t) => t.sourceKey === 'SPW-1')!;
    expect(p.signals[spw1.signalIds[0]!]!.body).toBe('確認お願いします');
    expect(assigneeOf(dir, spw1)).toEqual({ by: 'source', userIds: ['u_bob'], contactIds: [], addresses: [] });
    expect(await state.source(ctx.ds.id)).toMatchObject({ jira: { syncedUntil: at(5) }, lastSyncAt: at(5) });

    // 次の差分は重なりで同じ課題をもう一度読むが、二重にならない
    now = at(7);
    await ctx.sync.handle({ kind: 'jira-sync', dataSourceId: ctx.ds.id });
    expect((await threads()).map((t) => t.signalIds.length).sort()).toEqual([1, 1]);
    expect(jira.jqls.at(-1)).toBe('(project = SPW AND level IS EMPTY) AND updated >= -7m ORDER BY updated ASC');
  });

  it('ページの上限を超えたら、検索の位置を持ち越して続きを積む（読み直さない）。読み終えてから位置を進める', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    jira.pageSize = 1;
    for (let i = 1; i <= 12; i++) jira.put(issue(`SPW-${i}`, at(i * 0.1)));
    now = at(5);
    await ctx.sync.handle({ kind: 'jira-sync', dataSourceId: ctx.ds.id });
    expect(queued).toEqual([{ kind: 'jira-sync', dataSourceId: ctx.ds.id }]);
    expect((await state.source(ctx.ds.id))!.jira).toMatchObject({ syncedUntil: T0, resume: { startedAt: at(5), batch: 0, nextPageToken: '10' } });
    now = at(5.5);
    const searches = jira.jqls.length;
    await ctx.sync.handle(queued.shift()!);
    expect(jira.jqls.length - searches).toBe(2);
    expect(await threads()).toHaveLength(12);
    const done = (await state.source(ctx.ds.id))!;
    expect(done.jira!.syncedUntil).toBe(at(5));
    expect(done.jira!.resume).toBeUndefined();
  });

  it('見回り: 期限が近ければ延長、Webhook が消えていたら登録し直す', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    now = at(24 * 24 * 60);
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await state.source(ctx.ds.id))!.jira!.webhookExpiresAt).toBe(at(54 * 24 * 60));
    jira.webhooks.clear();
    now = at(48 * 24 * 60);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(jira.webhooks.size).toBe(1);
  });

  it('同意の問題なら broken にして止める。外したら Webhook を消す', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    jira.authBroken = true;
    now = at(20);
    await ctx.sync.handle({ kind: 'jira-sync', dataSourceId: ctx.ds.id });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: 'credential must be reconnected' });
    jira.authBroken = false;
    const s = (await state.source(ctx.ds.id))!;
    await state.putSource({ ...s, status: 'disconnected' });
    await ctx.sync.handle({ kind: 'disconnect', dataSourceId: ctx.ds.id });
    expect(jira.webhooks.size).toBe(0);
    expect((await state.source(ctx.ds.id))!.jira!.webhookIds).toEqual([]);
    // 外したデータソースには通知が来ても積まない
    expect(await ctx.sync.notified('u_bob')).toBe(0);
  });

  it('H3 共有リストの読者: setup でプロジェクトを閲覧できる人を写し（名乗った人だけ、アプリは外す）、60 分ごとに写し直す（0037 の決定 2）', async () => {
    // Alice は自分の Jira をつないで名乗っている（accountId が Contact に付いている）
    await ctx.service.changeMaster('u_alice', '名乗り', (d) => void d.addresses.push({ id: 'a_alice_jira', channel: 'jira', value: 'acct-alice', contactId: 'p_alice' }));
    jira.browserList.push({ accountId: 'acct-alice', accountType: 'atlassian', active: true }, { accountId: 'acct-stranger', accountType: 'atlassian', active: true });
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const readers = async () => {
      const dir = await ctx.service.directory();
      return dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id)!.id).sort();
    };
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    expect((await state.source(ctx.ds.id))!.jira!.readersSyncedAt).toBe(T0);
    // 30 分後の見回りでは読まない。60 分後に読み、外れた人を外す
    jira.browserList = jira.browserList.filter((b) => b.accountId !== 'acct-alice');
    now = at(30);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    now = at(61);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_bob']);
  });

  it('H3 つないだ人がプロジェクトを閲覧できなくなったら broken（ほかの読者がつなぎ直す）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    jira.browserList = [];
    jira.projectList = [];
    now = at(61);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/閲覧できなくなった/) });
  });

  it('H3 閲覧できる人の一覧が当てにならない（Jira が断る・本人が載らない）ときは、読者を変えず止めもしない。次の間隔で試す', async () => {
    await ctx.service.changeMaster('u_alice', '名乗り', (d) => void d.addresses.push({ id: 'a_alice_jira', channel: 'jira', value: 'acct-alice', contactId: 'p_alice' }));
    jira.browserList.push({ accountId: 'acct-alice', accountType: 'atlassian', active: true });
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const readers = async () => {
      const dir = await ctx.service.directory();
      return dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id)!.id).sort();
    };
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    // 「ユーザーとグループの閲覧」の権限がないと空が返る（プロジェクトは見えている）
    jira.browserList = [];
    now = at(61);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', jira: { readersSyncedAt: at(61) } });
    // Jira が 403 で断る
    jira.browsers = async () => {
      throw new JiraError(403, 'forbidden');
    };
    now = at(122);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', jira: { readersSyncedAt: at(122) } });
  });

  it('共有リストの差分は key in (...) で広げない（あとからセキュリティレベルが付いた課題を取らない）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    jira.put(issue('SPW-1', at(3)), [comment('11', 'acct-mori', at(3), '確認お願いします')]);
    now = at(5);
    await ctx.sync.handle({ kind: 'jira-sync', dataSourceId: ctx.ds.id });
    now = at(20);
    jira.jqls.length = 0;
    await ctx.sync.handle({ kind: 'jira-sync', dataSourceId: ctx.ds.id });
    expect(jira.jqls.every((q) => q.startsWith('(project = SPW AND level IS EMPTY) AND updated >='))).toBe(true);
  });

  it('Outlook の仕事（フォルダの同期）は扱わない', async () => {
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'inbox' });
    expect(jira.calls).toEqual([]);
  });
});
