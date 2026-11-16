import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { GRAPH_SCOPE } from '../../src/connectors/graph/scope';
import { GraphMailSync, MAILBOX_READERS_MINUTES } from '../../src/connectors/graph/sync';
import { addSharedReader, connectMailbox, directionOf, connectSharedMailbox, Directory, planMasterEdit, seedProblems, type Seed, type ServiceDataSource, type SharedSpacePlan } from '../../src/domain';
import { GatewayError, inScope } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeGraph, mail } from '../helpers/fake-graph';
import { answer, seed } from '../helpers/world';

// 共有メールボックス（0042）: メンバーの委任（Mail.Read.Shared）で、見回りの delta だけで読む共有リスト。
// 読者は「自分の委任で箱が読めた人」で、見回りで確かめ直す。ゲートウェイと Graph は偽物

const BOX = 'external@ubs.example';
const T0 = '2026-11-16T00:00:00.000Z';
const ctxAt = (d: Seed, now = T0) => ({ dir: new Directory(d), now, newId: counterIds() });

function connect(world: Seed, input: { userId: string; reader: string; mailbox?: string; cred?: string }) {
  let plan!: SharedSpacePlan;
  const { after } = planMasterEdit(world, (d) => {
    plan = connectSharedMailbox(d, ctxAt(d), { userId: input.userId, gatewayCredentialId: input.cred ?? `gw_${input.userId}`, mailbox: input.mailbox ?? BOX, readerAddress: input.reader });
  });
  return { after, plan };
}

describe('H3 共有メールボックスの共有リスト（0042 の決定 3）', () => {
  it('箱に 1 つの共有リストを作る。窓口は箱のアドレス、経路は箱の graph-mail、作った人が最初の読者', () => {
    const { after, plan } = connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example' });
    expect(plan.kind).toBe('created');
    expect(plan.dataSource).toMatchObject({
      channel: 'email',
      group: false,
      selfAddresses: [{ channel: 'email', value: BOX }],
      connector: { kind: 'graph-mail', mailbox: BOX, folders: ['inbox', 'sentitems'] },
      shared: { spaceKey: `mailbox:${BOX}`, createdBy: 'u_bob' },
    });
    const dir = new Directory(after);
    expect(dir.readersOfList(after.lists.find((l) => l.dataSourceId === plan.dataSource.id)!.id)).toEqual(['u_bob']);
    expect(seedProblems(after)).toEqual([]);
  });

  it('同じ箱（大文字小文字が違っても）は同じ共有リスト。2 人目は addSharedReader で読者に入り、名乗りのアドレスが本人の Contact に付く', () => {
    const first = connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example' });
    const second = connect(first.after, { userId: 'u_alice', reader: 'alice@ubs.example', mailbox: 'External@UBS.example' });
    expect(second.plan).toMatchObject({ kind: 'exists', dataSource: { id: first.plan.dataSource.id } });
    const { after } = planMasterEdit(second.after, (d) => {
      expect(addSharedReader(d, ctxAt(d), first.plan.dataSource.id, 'u_alice', { channel: 'email', value: 'alice@ubs.example' })).toEqual({ added: true });
      expect(addSharedReader(d, ctxAt(d), first.plan.dataSource.id, 'u_alice', { channel: 'email', value: 'alice@ubs.example' })).toEqual({ added: false });
    });
    const dir = new Directory(after);
    expect(dir.readersOfList(after.lists.find((l) => l.dataSourceId === first.plan.dataSource.id)!.id).sort()).toEqual(['u_alice', 'u_bob']);
    expect(seedProblems(after)).toEqual([]);
  });

  it('本人の箱や、だれかの個人のアドレスはつながない。アドレスでないものも断る', () => {
    expect(() => connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example', mailbox: 'BOB@ubs.example' })).toThrow(/本人の箱/);
    // alice@ は Alice の Contact のアドレス（個人の箱）
    expect(() => connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example', mailbox: 'alice@ubs.example' })).toThrow(/個人のアドレス/);
    expect(() => connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example', mailbox: 'external' })).toThrow(/メールアドレス/);
  });

  it('作った人が Outlook（本人の箱）をつないでも、共有メールボックスのデータソースを取り違えない（同じゲートウェイの接続・同じ名乗りのアドレス）', () => {
    const { after, plan } = connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example', cred: 'gw_bob' });
    planMasterEdit(after, (d) => {
      const mine = connectMailbox(d, ctxAt(d), { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', addresses: ['bob@ubs.example'] });
      expect(mine.kind).toBe('created');
      expect(mine.dataSource.id).not.toBe(plan.dataSource.id);
      expect(mine.dataSource.connector).toMatchObject({ kind: 'graph-mail', mailbox: 'me' });
    });
  });
});

describe('H5 共有メールボックスの読める口（0042 の決定 6）', () => {
  it('箱のフォルダと、そのフォルダの delta（Graph が返す nextLink・deltaLink の形も）だけ', () => {
    for (const p of [
      '/v1.0/users/external%40ubs.example/mailFolders/inbox?$select=id',
      '/v1.0/users/external%40ubs.example/mailFolders/inbox/messages/delta?$select=id&$filter=receivedDateTime ge 2026-11-16T00:00:00Z',
      "/v1.0/users/external@ubs.example/mailFolders('inbox')/messages/delta?$skiptoken=abc",
    ]) {
      expect(inScope(GRAPH_SCOPE, 'GET', p), p).toBe(true);
    }
    for (const [m, p] of [
      ['GET', '/v1.0/users/external@ubs.example'],
      ['GET', '/v1.0/users/external@ubs.example/messages'],
      ['GET', '/v1.0/users/external@ubs.example/mailFolders/inbox/messages'],
      ['GET', '/v1.0/users/external@ubs.example/mailFolders/inbox/childFolders'],
      ['POST', '/v1.0/users/external@ubs.example/sendMail'],
      ['PATCH', '/v1.0/users/external@ubs.example/mailFolders/inbox'],
    ] as const) {
      expect(inScope(GRAPH_SCOPE, m, p), `${m} ${p}`).toBe(false);
    }
  });
});

describe('H5 H6 共有メールボックスの見回り（偽の Graph）', () => {
  let graphs: Map<string, FakeGraph>;
  let queued: SyncJob[];
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;

  /** 人ごとの委任（ゲートウェイの graph の接続 1 つ）。readable にした箱だけ読める */
  const graphOf = (userId: string) => graphs.get(userId)!;

  async function setup() {
    const first = connect(seed, { userId: 'u_bob', reader: 'bob@ubs.example' });
    const { after } = planMasterEdit(first.after, (d) => {
      addSharedReader(d, ctxAt(d), first.plan.dataSource.id, 'u_alice', { channel: 'email', value: 'alice@ubs.example' });
    });
    const ds = first.plan.dataSource as ServiceDataSource;
    const made = await makeService(after, {
      decide: (req) => answer({ thread: req.candidates.length > 0 ? 'existing' : 'new', thread_id: req.candidates[0]?.threadId ?? null }),
    });
    made.clock.set(T0);
    const sync = new GraphMailSync({
      service: made.service,
      state,
      queue: { send: async (job) => void queued.push(job) },
      graphFor: async (source) => graphOf(source.userId),
      graphsOfUser: async (userId) => (graphs.has(userId) ? [{ credentialId: `gw_${userId}`, graph: graphOf(userId) }] : []),
      now: () => made.clock.now(),
      notificationUrl: 'https://murmur.test/webhooks/graph',
      newClientState: () => 'cs',
      hash: async (t) => t,
    });
    await state.putSource({
      kind: 'shared-mailbox',
      dataSourceId: ds.id,
      userId: 'u_bob',
      gatewayCredentialId: 'gw_u_bob',
      status: 'setup',
      reason: null,
      folders: {},
      mailbox: {},
      connectedAt: T0,
      lastSyncAt: null,
      lastRetryAt: null,
    });
    return { ...made, ds, sync };
  }

  const readers = async () => {
    const dir = await ctx.service.directory();
    return dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id)!.id).sort();
  };
  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);
  const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

  beforeEach(async () => {
    const bob = new FakeGraph({ id: 'oid_bob', displayName: 'Bob', addresses: ['bob@ubs.example'] });
    const alice = new FakeGraph({ id: 'oid_alice', displayName: 'Alice', addresses: ['alice@ubs.example'] });
    bob.readable.add(BOX);
    alice.readable.add(BOX);
    graphs = new Map([
      ['u_bob', bob],
      ['u_alice', alice],
    ]);
    queued = [];
    state = new MemoryConnectorState();
    ctx = await setup();
    // 箱のメールは、だれの委任で読んでも同じ（フォルダを共有する）
    for (const f of ['inbox', 'sentitems']) {
      bob.folders.set(f, []);
      alice.folders.set(f, bob.folders.get(f)!);
    }
  });

  it('setup: サブスクリプションを作らず、箱の両フォルダの delta を読み、つないだ時刻以降のメールだけ取り込んで ok', async () => {
    const bob = graphOf('u_bob');
    bob.deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: '2026-11-15T23:00:00.000Z', subject: 'つなぐ前' }));
    bob.deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: '2026-11-16T00:00:05.000Z', subject: '見積のお願い' }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(bob.subscriptions.size).toBe(0);
    expect(bob.calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(bob.calls).toEqual(expect.arrayContaining([`deltaStart inbox @${BOX}`, `deltaStart sentitems @${BOX}`]));
    expect((await threads()).map((t) => t.title)).toEqual(['見積のお願い']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: T0, mailbox: { readersSyncedAt: T0 } });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
  });

  it('見回りのたびに delta を読む（通知がないので、本人の箱の 30 分の保険の間隔を待たない）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const bob = graphOf('u_bob');
    ctx.clock.set(at(5));
    bob.deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: at(3), subject: '届いた' }));
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await threads()).map((t) => t.title)).toEqual(['届いた']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: at(5) });
    expect(bob.subscriptions.size).toBe(0);
  });

  it(`読者は ${MAILBOX_READERS_MINUTES} 分ごとに確かめ直す。箱を読めなくなった人・同意を外した人は読者から外れる`, async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graphOf('u_alice').readable.clear();
    ctx.clock.set(at(30));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    ctx.clock.set(at(MAILBOX_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_bob']);
  });

  it('取り込みに委任を使っている人が読めなくなったら、読める読者の委任に入れ替えて続ける（作った人は変わらない）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graphOf('u_bob').readable.clear();
    ctx.clock.set(at(MAILBOX_READERS_MINUTES));
    graphOf('u_alice').deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: at(10), subject: '入れ替えのあと' }));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', userId: 'u_alice', gatewayCredentialId: 'gw_u_alice' });
    const dir = await ctx.service.directory();
    const ds = dir.dataSource(ctx.ds.id) as ServiceDataSource;
    expect(dir.credentialRef(ds.credentialRefId)).toMatchObject({ principal: { kind: 'user', userId: 'u_alice' }, gatewayCredentialId: 'gw_u_alice' });
    expect(ds.shared?.createdBy).toBe('u_bob');
    expect((await threads()).map((t) => t.title)).toEqual(['入れ替えのあと']);
  });

  it('取り込みに使っている接続がゲートウェイで使えなくなっても（同意の取り消し）、読める読者に入れ替えて続ける', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graphOf('u_bob').authBroken = true;
    ctx.clock.set(at(MAILBOX_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', userId: 'u_alice' });
    expect(await readers()).toEqual(['u_alice']);
  });

  it('setup の仕事が落ちたきりでも、見回りが setup をやり直して ok にする', async () => {
    graphOf('u_bob').deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: at(1), subject: '落ちたあと' }));
    ctx.clock.set(at(5));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok' });
    expect((await threads()).map((t) => t.title)).toEqual(['落ちたあと']);
  });

  it('だれも読めなければ broken。間をおいて試し直し、読めるようになれば止まっていた間の分も取って ok に戻る', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graphOf('u_bob').readable.clear();
    graphOf('u_alice').readable.clear();
    ctx.clock.set(at(MAILBOX_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/読める読者がいない/) });
    graphOf('u_bob').readable.add(BOX);
    graphOf('u_bob').deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: at(70), subject: '止まっていた間' }));
    ctx.clock.set(at(MAILBOX_READERS_MINUTES + 30));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken' });
    ctx.clock.set(at(MAILBOX_READERS_MINUTES * 2));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', userId: 'u_bob' });
    expect((await threads()).map((t) => t.title)).toEqual(['止まっていた間']);
  });

  it('確かめ直しの一時的な失敗（ゲートウェイの障害）では読者を減らさない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graphOf('u_alice').mailboxReadable = async () => {
      throw new GatewayError('upstream timeout', 502);
    };
    ctx.clock.set(at(MAILBOX_READERS_MINUTES));
    await expect(ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id })).rejects.toThrow(/timeout/);
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
  });

  it('窓口のアドレス（箱）から送ったものは送信、箱への受信は受信として畳む', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const bob = graphOf('u_bob');
    bob.deliver('inbox', mail({ from: 'carol@example.com', to: [BOX], at: at(1), subject: '見積のお願い', mid: '<c1@example.com>' }));
    bob.deliver('sentitems', mail({ from: BOX, to: ['carol@example.com'], at: at(2), subject: 'RE: 見積のお願い', inReplyTo: '<c1@example.com>' }));
    ctx.clock.set(at(5));
    await ctx.sync.handle({ kind: 'maintain' });
    const all = await threads();
    expect(all).toHaveLength(1);
    const p = await ctx.service.state();
    const dir = await ctx.service.directory();
    expect(all[0]!.signalIds.map((id) => directionOf(dir, p.signals[id]!))).toEqual(['inbound', 'outbound']);
  });
});
