import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { normalizeMessage } from '../../src/connectors/graph/normalize';
import { stripQuoted } from '../../src/connectors/strip-quoted';
import { jobsFromNotifications } from '../../src/connectors/graph/notifications';
import type { SourceState } from '../../src/connectors/graph/state';
import { planLifecycle, planMaintenance } from '../../src/connectors/graph/subscriptions';
import { GraphMailSync } from '../../src/connectors/graph/sync';
import { GraphMessage } from '../../src/connectors/graph/message';
import { sha256Hex } from '../../src/connectors/secrets';
import { connectMailbox, directionOf, Directory, planMasterEdit, attentionOf, type MailboxPlan, type ServiceDataSource } from '../../src/domain';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeGraph, mail } from '../helpers/fake-graph';
import { answer, seed } from '../helpers/world';

// Outlook の個人の箱の取り込み（0024）。ゲートウェイと Graph は偽物

describe('H5 Graph の message の正規化', () => {
  const parse = (m: unknown) => GraphMessage.parse(m);

  it('sourceRef とアンカーは internetMessageId、In-Reply-To はヘッダーから、宛先は To と Cc', () => {
    const m = parse({
      ...mail({ from: 'carol@example.com', at: '2026-10-30T01:00:00Z', mid: '<c1@example.com>' }),
      ccRecipients: [{ emailAddress: { address: 'dave@example.com' } }],
      internetMessageHeaders: [{ name: 'in-reply-to', value: ' <b0@ubs.example> ' }],
    });
    const n = normalizeMessage('ds_x', m);
    expect(n).toMatchObject({
      kind: 'signal',
      signal: {
        dataSourceId: 'ds_x',
        channel: 'email',
        from: { channel: 'email', value: 'carol@example.com' },
        to: [{ value: 'bob@ubs.example' }, { value: 'dave@example.com' }],
        sourceRef: 'email:<c1@example.com>',
        anchors: { messageId: '<c1@example.com>', inReplyTo: '<b0@ubs.example>' },
        occurredAt: '2026-10-30T01:00:00Z',
      },
    });
  });

  it('消えたもの・下書き・ID のないものは取り込まない', () => {
    expect(normalizeMessage('d', parse({ id: 'x', '@removed': { reason: 'deleted' } })).kind).toBe('skip');
    expect(normalizeMessage('d', parse({ ...mail({ from: 'a@b', at: 't' }), isDraft: true })).kind).toBe('skip');
    expect(normalizeMessage('d', parse({ ...mail({ from: 'a@b', at: 't' }), internetMessageId: undefined })).kind).toBe('skip');
  });

  it('uniqueBody がなければ引用の履歴を落とした本文を使う', () => {
    const body = 'ありがとうございます。承知しました。\n\n________________________________\n差出人: 鈴木\n送信日時: 2026年10月29日\n件名: 見積\n\n前のメール';
    const n = normalizeMessage('d', parse(mail({ from: 'a@b', at: 't', body, uniqueBody: false })));
    expect(n.kind === 'signal' && n.signal.body).toBe('ありがとうございます。承知しました。');
    expect(stripQuoted('了解です\nOn Mon, Oct 27, 2026 at 9:00 Carol wrote:\n> 前')).toBe('了解です');
    expect(stripQuoted('a\n> 引用\nb')).toBe('a\nb');
  });
});

const source = (over: Partial<SourceState> = {}): SourceState => ({
  dataSourceId: 'ds_1',
  userId: 'u_bob',
  gatewayCredentialId: 'gw',
  status: 'ok',
  reason: null,
  folders: {},
  connectedAt: '2026-10-30T00:00:00.000Z',
  lastSyncAt: '2026-10-30T00:00:00.000Z',
  lastRetryAt: null,
  ...over,
});
const sub = (folder: string, expiresAt: string, id = `s_${folder}`) => ({ id, dataSourceId: 'ds_1', folder, clientStateHash: 'h', expiresAt });
const FOLDERS = ['inbox', 'sentitems'];

describe('H5 サブスクリプションの一生の計画（取りこぼしの保険）', () => {
  const now = '2026-10-30T00:10:00.000Z';

  it('なければ作り、残り 48 時間を切ったら延ばし、期限切れと設定にないフォルダのものは消す', () => {
    expect(planMaintenance(source(), [], FOLDERS, now)).toEqual({ kind: 'maintain', actions: [{ kind: 'create', folder: 'inbox' }, { kind: 'create', folder: 'sentitems' }], sync: false });
    const plan = planMaintenance(
      source(),
      [sub('inbox', '2026-11-01T00:00:00.000Z'), sub('sentitems', '2026-11-05T00:00:00.000Z'), sub('sentitems', '2026-10-29T00:00:00.000Z', 'old'), sub('archive', '2026-11-05T00:00:00.000Z')],
      FOLDERS,
      now,
    );
    expect(plan).toMatchObject({
      kind: 'maintain',
      sync: false,
      actions: [
        { kind: 'renew', subscription: { id: 's_inbox' } },
        { kind: 'create', folder: 'sentitems' },
        { kind: 'delete', subscription: { id: 'old' } },
        { kind: 'delete', subscription: { id: 's_archive' } },
      ].filter((a) => !(a.kind === 'create')),
    });
    expect(planMaintenance(source(), [sub('inbox', '2026-11-05T00:00:00Z'), sub('sentitems', '2026-11-05T00:00:00Z')], FOLDERS, now)).toEqual({ kind: 'idle' });
  });

  it('通知先が変わったら（記録のない古いものも）消して作り直す（0023 の段取り 4: デプロイの形を変えて URL が変わる）', () => {
    const NEW = 'https://gateway.test/murmur/webhooks/graph';
    const at = (url?: string) => [
      { ...sub('inbox', '2026-11-05T00:00:00Z'), ...(url ? { notificationUrl: url } : {}) },
      { ...sub('sentitems', '2026-11-05T00:00:00Z'), ...(url ? { notificationUrl: url } : {}) },
    ];
    expect(planMaintenance(source(), at(NEW), FOLDERS, now, NEW)).toEqual({ kind: 'idle' });
    for (const old of [at('https://murmur.test/webhooks/graph'), at()]) {
      expect(planMaintenance(source(), old, FOLDERS, now, NEW)).toMatchObject({
        kind: 'maintain',
        actions: [
          { kind: 'create', folder: 'inbox' },
          { kind: 'delete', subscription: { id: 's_inbox' } },
          { kind: 'create', folder: 'sentitems' },
          { kind: 'delete', subscription: { id: 's_sentitems' } },
        ],
      });
    }
  });

  it('保険: 最後の delta から 30 分たったら全フォルダを取る', () => {
    const live = [sub('inbox', '2026-11-05T00:00:00Z'), sub('sentitems', '2026-11-05T00:00:00Z')];
    expect(planMaintenance(source(), live, FOLDERS, '2026-10-30T00:30:00.000Z')).toEqual({ kind: 'maintain', actions: [], sync: true });
  });

  it('broken は 1 時間ごとに試し直し、外したものはサブスクリプションを消すだけ', () => {
    expect(planMaintenance(source({ status: 'broken', lastRetryAt: '2026-10-30T00:00:00Z' }), [], FOLDERS, now)).toEqual({ kind: 'idle' });
    expect(planMaintenance(source({ status: 'broken', lastRetryAt: '2026-10-29T23:00:00Z' }), [], FOLDERS, now)).toEqual({ kind: 'retry' });
    expect(planMaintenance(source({ status: 'disconnected' }), [sub('inbox', 'x')], FOLDERS, now)).toMatchObject({ kind: 'maintain', actions: [{ kind: 'delete' }], sync: false });
  });

  it('ライフサイクル: 再認可は延長、消えたら作り直して取り直し、取りこぼしは取り直し', () => {
    const s = sub('inbox', 'x');
    expect(planLifecycle('reauthorizationRequired', s)).toEqual({ actions: [{ kind: 'renew', subscription: s }], sync: false });
    expect(planLifecycle('subscriptionRemoved', s)).toEqual({ actions: [{ kind: 'delete', subscription: s }, { kind: 'create', folder: 'inbox' }], sync: true });
    expect(planLifecycle('missed', s)).toEqual({ actions: [], sync: true });
  });
});

describe('H3 H5 通知の照合', () => {
  it('clientState の合うものだけを、フォルダごとに 1 つの仕事にする', async () => {
    const state = new MemoryConnectorState();
    await state.putSubscription({ id: 's1', dataSourceId: 'ds_1', folder: 'inbox', clientStateHash: await sha256Hex('secret'), expiresAt: 'x' });
    const deps = { subscription: (id: string) => state.subscription(id), hash: sha256Hex };
    const r = await jobsFromNotifications(
      {
        value: [
          { subscriptionId: 's1', clientState: 'secret' },
          { subscriptionId: 's1', clientState: 'secret' },
          { subscriptionId: 's1', clientState: 'wrong' },
          { subscriptionId: 'unknown', clientState: 'secret' },
          { subscriptionId: 's1', clientState: 'secret', lifecycleEvent: 'missed' },
        ],
      },
      deps,
    );
    expect(r.jobs).toEqual([
      { kind: 'sync', dataSourceId: 'ds_1', folder: 'inbox' },
      { kind: 'lifecycle', subscriptionId: 's1', event: 'missed' },
    ]);
    expect(r.rejected).toBe(2);
  });
});

describe('H5 H6 個人の箱の同期（偽の Graph）', () => {
  let graph: FakeGraph;
  let queued: SyncJob[];
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    let plan!: MailboxPlan;
    const newId = counterIds();
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectMailbox(d, { dir: new Directory(d), now: '2026-10-30T00:00:00.000Z', newId }, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', addresses: ['bob@ubs.example'] });
    });
    const ds = plan.dataSource as ServiceDataSource;
    const made = await makeService(after, {
      decide: (req) => answer({ thread: req.candidates.length > 0 ? 'existing' : 'new', thread_id: req.candidates[0]?.threadId ?? null, needs_response: true }),
    });
    made.clock.set('2026-10-30T00:00:00.000Z');
    let clientStates = 0;
    const sync = new GraphMailSync({
      service: made.service,
      state,
      queue: { send: async (job) => void queued.push(job) },
      graphFor: async () => graph,
      now: () => made.clock.now(),
      notificationUrl: 'https://murmur.test/webhooks/graph',
      newClientState: () => `cs${++clientStates}`,
      hash: sha256Hex,
    });
    await state.putSource({ ...source({ dataSourceId: ds.id, status: 'setup', lastSyncAt: null }), connectedAt: made.clock.now() });
    return { ...made, ds, sync };
  }

  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);

  beforeEach(async () => {
    graph = new FakeGraph();
    queued = [];
    state = new MemoryConnectorState();
    ctx = await setup();
  });

  it('つないだあと: 両フォルダにサブスクリプションを作り、つないだ時刻以降のメールだけを取り込み、ok になる', async () => {
    graph.deliver('inbox', mail({ from: 'carol@example.com', at: '2026-10-29T23:00:00.000Z', subject: 'つなぐ前' }));
    graph.deliver('inbox', mail({ from: 'carol@example.com', at: '2026-10-30T00:00:05.000Z', subject: '見積のお願い' }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect([...graph.subscriptions.values()].map((s) => [s.folder, s.notificationUrl])).toEqual([
      ['inbox', 'https://murmur.test/webhooks/graph'],
      ['sentitems', 'https://murmur.test/webhooks/graph'],
    ]);
    // 台帳には clientState のハッシュだけ
    const subs = await state.subscriptions(ctx.ds.id);
    expect(subs.map((s) => s.clientStateHash)).toEqual([await sha256Hex('cs1'), await sha256Hex('cs2')]);
    expect((await threads()).map((t) => t.title)).toEqual(['見積のお願い']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: '2026-10-30T00:00:00.000Z' });
  });

  it('通知 → delta: 受信と、送信済みフォルダの返信（ヘッダーなし）が同じスレッドに入る。同じ通知が重なっても二重にならない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graph.deliver('inbox', mail({ from: 'carol@example.com', at: '2026-10-30T01:00:00.000Z', subject: '見積のお願い', mid: '<c1@example.com>' }));
    const { jobs } = await jobsFromNotifications(graph.notification('inbox'), { subscription: (id) => state.subscription(id), hash: sha256Hex });
    for (const job of [...jobs, ...jobs]) await ctx.sync.handle(job);
    // 送信済みにはヘッダーがない（実物）。In-Reply-To のアンカーなしで、区切りは直近のスレッドから決まる
    graph.deliver('sentitems', mail({ from: 'bob@ubs.example', to: ['carol@example.com'], at: '2026-10-30T02:00:00.000Z', subject: 'RE: 見積のお願い' }));
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'sentitems' });
    const [thread] = await threads();
    expect(await threads()).toHaveLength(1);
    const p = await ctx.service.state();
    const dir = await ctx.service.directory();
    expect(thread!.signalIds.map((id) => directionOf(dir, p.signals[id]!))).toEqual(['inbound', 'outbound']);
    // 送信で相手が名指しされる（アドレスを、クエリ層で Contact に解決する。0030・0038）
    // 受信の宛先の本人（Bob）への名指しは、本人が外すまで残る
    expect(attentionOf(dir, thread!).named.map((n) => [n.address.value, n.userId, n.contactId])).toEqual([
      ['bob@ubs.example', 'u_bob', null],
      ['carol@example.com', null, 'p_carol'],
    ]);
  });

  it('記録した送信（下書きの internetMessageId）があとで送信済みに現れても 1 本のまま（H5）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    await ctx.service.recordSent('u_bob', {
      dataSourceId: ctx.ds.id,
      to: ['carol@example.com'],
      toContactIds: [],
      subject: 'ご案内',
      body: 'ご案内です',
      sentRef: '<draft1@ubs.example>',
      anchors: {},
    });
    graph.deliver('sentitems', mail({ from: 'bob@ubs.example', to: ['carol@example.com'], at: '2026-10-30T01:00:00.000Z', subject: 'ご案内', mid: '<draft1@ubs.example>' }));
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'sentitems' });
    const ts = await threads();
    expect(ts).toHaveLength(1);
    expect(ts[0]!.signalIds).toHaveLength(1);
  });

  it('ページの上限を超えたら、読んだところまで cursor を進めて続きを積む', async () => {
    graph.pageSize = 1;
    for (let i = 0; i < 25; i++) graph.deliver('inbox', mail({ from: `x${i}@example.com`, at: `2026-10-30T01:${String(i).padStart(2, '0')}:00.000Z`, subject: `件 ${i}` }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await threads()).toHaveLength(20);
    expect(queued).toEqual([{ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'inbox' }]);
    // 全部を読み切っていないので、最後の同期の時刻は進めない
    expect((await state.source(ctx.ds.id))!.lastSyncAt).toBeNull();
    await ctx.sync.handle(queued.shift()!);
    expect(await threads()).toHaveLength(25);
  });

  it('delta の位置が無効（410）なら、最後に取り込んだ時刻から取り直す（取り込み済みは重複排除で落ちる）', async () => {
    graph.deliver('inbox', mail({ from: 'carol@example.com', at: '2026-10-30T01:00:00.000Z', subject: 'A' }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const link = (await state.source(ctx.ds.id))!.folders.inbox!.link!;
    graph.invalidLinks.add(link);
    graph.deliver('inbox', mail({ from: 'dave@example.com', at: '2026-10-30T02:00:00.000Z', subject: 'B' }));
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'inbox' });
    expect((await threads()).map((t) => t.title).sort()).toEqual(['A', 'B']);
    expect(graph.calls.filter((c) => c === 'deltaStart inbox')).toHaveLength(2);
  });

  it('消えたサブスクリプション: 延長が 404 なら作り直し、subscriptionRemoved でも作り直して取り直す', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const body = graph.notification('inbox', 'subscriptionRemoved');
    graph.subscriptions.clear();
    const { jobs } = await jobsFromNotifications(body, { subscription: (id) => state.subscription(id), hash: sha256Hex });
    await ctx.sync.handle(jobs[0]!);
    expect([...graph.subscriptions.values()].map((s) => s.folder)).toEqual(['inbox']);
    // 期限が近づいた sentitems の延長は 404 → 作り直す
    ctx.clock.set('2026-11-05T00:00:00.000Z');
    await ctx.sync.handle({ kind: 'maintain' });
    expect([...graph.subscriptions.values()].map((s) => s.folder).sort()).toEqual(['inbox', 'sentitems']);
    expect((await state.subscriptions(ctx.ds.id)).every((s) => s.expiresAt > '2026-11-11T00:00:00.000Z')).toBe(true);
  });

  it('同意の問題なら broken にして止まり、1 時間後の見回りで試し直して戻る', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    graph.authBroken = true;
    ctx.clock.set('2026-10-30T01:00:00.000Z');
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: 'credential must be reconnected' });
    graph.authBroken = false;
    graph.deliver('inbox', mail({ from: 'carol@example.com', at: '2026-10-30T01:10:00.000Z', subject: '止まっている間' }));
    ctx.clock.set('2026-10-30T01:30:00.000Z');
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await state.source(ctx.ds.id))!.status).toBe('broken');
    ctx.clock.set('2026-10-30T02:00:00.000Z');
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', reason: null });
    expect((await threads()).map((t) => t.title)).toEqual(['止まっている間']);
  });

  it('同意の問題でない失敗は投げる（キューが試し直す）。cursor は進まない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const before = await state.source(ctx.ds.id);
    graph.deltaNext = async () => {
      throw new Error('boom');
    };
    await expect(ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'inbox' })).rejects.toThrow('boom');
    expect(await state.source(ctx.ds.id)).toEqual(before);
  });

  it('外したら: サブスクリプションを消し、そのあとの通知や見回りでは何もしない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected', folders: {} });
    await ctx.sync.handle({ kind: 'disconnect', dataSourceId: ctx.ds.id });
    expect(graph.subscriptions.size).toBe(0);
    expect(await state.subscriptions(ctx.ds.id)).toEqual([]);
    const calls = graph.calls.length;
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'inbox' });
    await ctx.sync.handle({ kind: 'maintain' });
    expect(graph.calls.length).toBe(calls);
  });

});
