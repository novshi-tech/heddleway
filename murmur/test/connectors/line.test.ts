import { beforeEach, describe, expect, it } from 'vitest';
import { EVENTS_QUERY, GatewayLineApi, LineEvent, LineNotReadable, PROBE_QUERY } from '../../src/connectors/line/api';
import { normalizeLineEvent } from '../../src/connectors/line/normalize';
import { LINE_SCOPE } from '../../src/connectors/line/scope';
import { LINE_READERS_MINUTES, LineSync, MAX_PAGES_PER_RUN } from '../../src/connectors/line/sync';
import { LINE_PAGE_SIZE } from '../../src/connectors/line/api';
import {
  addSharedReader,
  attentionOf,
  connectLineAccount,
  directionOf,
  Directory,
  lineReaderIdentity,
  planMasterEdit,
  seedProblems,
  type Seed,
  type ServiceDataSource,
  type SharedSpacePlan,
} from '../../src/domain';
import { GatewayAuthError, GatewayError, inScope, type UpstreamCall } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { FakeLine, FakeLineStore } from '../helpers/fake-line';
import { counterIds, makeService } from '../helpers/service';
import { answer, seed } from '../helpers/world';

// LINE 公式アカウント（0049）: 受け口（業務システム）の原本を見回りで読む共有リスト。ゲートウェイと受け口は偽物

const ORG = 'org_ubs';
const OA = { channel: 'line' as const, value: `oa:${ORG}` };
const CAROL = `U${'c'.repeat(32)}`;
const DAVE = `U${'d'.repeat(32)}`;
const GROUP = `C${'1'.repeat(32)}`;
const T0 = '2026-11-23T00:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
/** 共有リストを続けて作るテストで ID が重ならないように、ID はテストの間で 1 つの連番 */
const ids = counterIds();
const ctxAt = (d: Seed, now = T0) => ({ dir: new Directory(d), now, newId: ids });
const ev = (raw: Partial<LineEvent>) => LineEvent.parse({ id: 'e1', direction: 'INBOUND', type: 'message', messageType: 'text', occurredAt: T0, ...raw });

function connect(world: Seed, userId: string, organizationId = ORG) {
  let plan!: SharedSpacePlan;
  const { after } = planMasterEdit(world, (d) => {
    plan = connectLineAccount(d, ctxAt(d), { userId, gatewayCredentialId: `gw_${userId}`, organizationId, organizationName: 'アーバン' });
  });
  return { after, plan };
}

describe('H3 LINE 公式アカウントの共有リスト（0049 の決定 3・4）', () => {
  it('組織に 1 つ。窓口は公式アカウント、名乗りは受け口の組織とトピック索引の User の組、作った人が最初の読者', () => {
    const { after, plan } = connect(seed, 'u_bob');
    expect(plan.kind).toBe('created');
    expect(plan.dataSource).toMatchObject({ channel: 'line', group: false, selfAddresses: [OA], connector: { kind: 'line', organizationId: ORG }, shared: { spaceKey: `line:${ORG}`, createdBy: 'u_bob' } });
    const again = connect(after, 'u_alice');
    expect(again.plan).toMatchObject({ kind: 'exists', dataSource: { id: plan.dataSource.id } });
    const dir = new Directory(again.after);
    expect(dir.readersOfList(again.after.lists.find((l) => l.dataSourceId === plan.dataSource.id)!.id)).toEqual(['u_bob']);
    expect(lineReaderIdentity(ORG, 'u_bob')).toEqual({ channel: 'line', value: `bm-next:${ORG}:u_bob` });
    expect(seedProblems(again.after)).toEqual([]);
  });

  it('組織が違えば別の共有リスト。組織がなければ断る', () => {
    const first = connect(seed, 'u_bob');
    expect(connect(first.after, 'u_bob', 'org_other').plan.kind).toBe('created');
    expect(() => connect(seed, 'u_bob', ' ')).toThrow(/organization/);
  });
});

describe('H5 LINE の読める口（0049 の決定 2）', () => {
  it('GET の /graphql だけ。POST（mutation を本文で送れる）とほかのパスは断る', () => {
    expect(inScope(LINE_SCOPE, 'GET', `/graphql?${new URLSearchParams({ query: EVENTS_QUERY })}`)).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(inScope(LINE_SCOPE, method, '/graphql')).toBe(false);
    for (const path of ['/api/line/webhook/org_ubs', '/graphql/', '/graphql/x', '/api/works/saved-filters/1/report']) expect(inScope(LINE_SCOPE, 'GET', path), path).toBe(false);
  });

  it('本体が組み立てるクエリは読み取り（query）だけで、送信の mutation を含まない', () => {
    for (const q of [PROBE_QUERY, EVENTS_QUERY]) {
      expect(q.startsWith('query ')).toBe(true);
      expect(q).not.toMatch(/mutation|sendLineMessage/);
    }
  });

  it('GET で固定のクエリを送り、変数は JSON。after があれば since を送らない', async () => {
    const calls: { method: string; path: string; headers?: Record<string, string> }[] = [];
    const upstream: UpstreamCall = async (method, path, init) => {
      calls.push({ method, path, headers: init?.headers });
      return Response.json({ data: { lineEvents: { events: [{ id: 'e1', direction: 'INBOUND', type: 'message', occurredAt: T0, extra: 1 }, { broken: true }], endCursor: 'c1', hasMore: false } } });
    };
    const r = await new GatewayLineApi(upstream).events({ after: 'c0', since: T0 });
    expect(r).toEqual({ events: [expect.objectContaining({ id: 'e1' })], endCursor: 'c1', hasMore: false });
    expect(calls[0]!.method).toBe('GET');
    const url = new URL(calls[0]!.path, 'https://x.invalid');
    expect(url.pathname).toBe('/graphql');
    expect(url.searchParams.get('query')).toBe(EVENTS_QUERY);
    expect(JSON.parse(url.searchParams.get('variables')!)).toEqual({ after: 'c0', since: null, first: LINE_PAGE_SIZE });
    expect(calls[0]!.headers).toMatchObject({ 'graphql-preflight': '1' });
  });

  it('認可の失敗は読めない（LineNotReadable。資格情報の問題）、ゲートウェイの同意の問題は GatewayAuthError、ほかは一時的な失敗', async () => {
    const api = (res: () => Response) => new GatewayLineApi(async () => res());
    await expect(api(() => Response.json({ errors: [{ message: 'no', extensions: { code: 'AUTH_NOT_AUTHORIZED' } }] })).probe()).rejects.toBeInstanceOf(LineNotReadable);
    await expect(api(() => Response.json({ error: 'consent required' }, { status: 403 })).probe()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(api(() => new Response('{}', { status: 401 })).probe()).rejects.toBeInstanceOf(LineNotReadable);
    const failed = api(() => Response.json({ errors: [{ message: 'boom' }] }, { status: 500 })).probe();
    await expect(failed).rejects.toBeInstanceOf(GatewayError);
    await expect(failed).rejects.not.toBeInstanceOf(GatewayAuthError);
  });
});

describe('H8 LINE のイベントの写し方（0049 の決定 5）', () => {
  const ctx = { dataSourceId: 'ds1', organizationId: ORG };

  it('1 対 1 の受信: 相手の userId から窓口宛て。会話は相手、messageId と引用を持つ', () => {
    expect(normalizeLineEvent(ctx, ev({ id: 'w1', lineUserId: CAROL, sourceType: 'user', messageId: '5001', quotedMessageId: '4999', text: ' 明日の点検は何時ですか ' }))).toEqual({
      kind: 'signal',
      signal: {
        dataSourceId: 'ds1',
        channel: 'line',
        from: { channel: 'line', value: CAROL },
        to: [OA],
        body: '明日の点検は何時ですか',
        anchors: { messageId: '5001', quotedMessageId: '4999', conversationId: CAROL, conversationGroup: false },
        sourceRef: 'line:w1',
        occurredAt: T0,
      },
    });
  });

  it('送信: 窓口から相手宛て。messageId は送ったメッセージの ID（record_sent の sent_ref）', () => {
    const n = normalizeLineEvent(ctx, ev({ id: 'out:6001', direction: 'OUTBOUND', lineUserId: CAROL, messageId: '6001', text: '10 時です' }));
    expect(n).toMatchObject({ kind: 'signal', signal: { from: OA, to: [{ channel: 'line', value: CAROL }], anchors: { messageId: '6001', conversationId: CAROL, conversationGroup: false } } });
  });

  it('グループの受信は文脈だけ（宛先なし）で、会話はグループ。送り主の分からないもの・友だち追加などは取り込まない', () => {
    expect(normalizeLineEvent(ctx, ev({ lineUserId: DAVE, groupId: GROUP, sourceType: 'group', text: 'みなさん' }))).toMatchObject({
      kind: 'signal',
      signal: { from: { value: DAVE }, to: [], anchors: { conversationId: GROUP, conversationGroup: true } },
    });
    expect(normalizeLineEvent(ctx, ev({ groupId: GROUP, text: 'だれか' }))).toMatchObject({ kind: 'skip' });
    expect(normalizeLineEvent(ctx, ev({ type: 'follow', lineUserId: CAROL, messageType: null }))).toMatchObject({ kind: 'skip' });
    expect(normalizeLineEvent(ctx, ev({ type: 'unfollow', lineUserId: CAROL, messageType: null }))).toMatchObject({ kind: 'skip' });
    expect(normalizeLineEvent(ctx, ev({ lineUserId: CAROL, text: '  ' }))).toMatchObject({ kind: 'skip' });
  });

  it('テキスト以外は本文を印にする。postback はボタンのデータ', () => {
    const body = (raw: Partial<LineEvent>) => {
      const n = normalizeLineEvent(ctx, ev({ lineUserId: CAROL, ...raw }));
      return n.kind === 'signal' ? n.signal.body : null;
    };
    expect(body({ messageType: 'image' })).toBe('[画像]');
    expect(body({ messageType: 'sticker' })).toBe('[スタンプ]');
    expect(body({ messageType: 'file', fileName: '報告書.pdf' })).toBe('[ファイル] 報告書.pdf');
    expect(body({ messageType: 'imagemap' })).toBe('[imagemap]');
    expect(body({ type: 'postback', messageType: null, postbackData: 'action=report' })).toBe('[ボタン] action=report');
  });
});

describe('H5 H6 LINE の見回り（偽の受け口）', () => {
  let store: FakeLineStore;
  let lines: Map<string, FakeLine>;
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const first = connect(seed, 'u_bob');
    const { after } = planMasterEdit(first.after, (d) => {
      addSharedReader(d, ctxAt(d), first.plan.dataSource.id, 'u_alice', lineReaderIdentity(ORG, 'u_alice'));
    });
    const ds = first.plan.dataSource as ServiceDataSource;
    const made = await makeService(after, {
      decide: (req) => answer({ thread: req.candidates.length > 0 ? 'existing' : 'new', thread_id: req.candidates[0]?.threadId ?? null, title: req.signal.body.slice(0, 20) }),
    });
    made.clock.set(T0);
    const sync = new LineSync({
      service: made.service,
      state,
      lineFor: async (source) => lines.get(source.userId)!,
      linesOfUser: async (userId) => (lines.has(userId) ? [{ credentialId: `gw_${userId}`, api: lines.get(userId)! }] : []),
      now: () => made.clock.now(),
    });
    await state.putSource({
      kind: 'line',
      dataSourceId: ds.id,
      userId: 'u_bob',
      gatewayCredentialId: 'gw_u_bob',
      status: 'setup',
      reason: null,
      folders: {},
      line: { after: null, setupAt: T0 },
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

  beforeEach(async () => {
    store = new FakeLineStore();
    lines = new Map([
      ['u_bob', new FakeLine(store)],
      ['u_alice', new FakeLine(store)],
    ]);
    state = new MemoryConnectorState();
    ctx = await setup();
  });

  it('setup: つないだ時刻から読み、読者を確かめ、位置を endCursor にして ok', async () => {
    store.add({ id: 'old', lineUserId: CAROL, text: 'つなぐ前', at: at(-10) });
    store.add({ id: 'w1', lineUserId: CAROL, messageId: '5001', text: '見積もりのお願い', at: at(1) });
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(lines.get('u_bob')!.calls).toContain(`events since ${T0}`);
    expect((await threads()).map((t) => t.title)).toEqual(['見積もりのお願い']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: T0, line: { after: FakeLineStore.cursorOf({ receivedAt: at(1), id: 'w1' }), readersSyncedAt: T0 } });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
  });

  it('見回りのたびに前回の位置から読む。1 対 1 の受信は窓口宛て（読者全員へのリスト宛てのアテンション）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    ctx.clock.set(at(5));
    store.add({ id: 'w1', lineUserId: CAROL, messageId: '5001', text: '明日の点検は何時ですか', at: at(3) });
    await ctx.sync.handle({ kind: 'maintain' });
    const [thread] = await threads();
    expect(thread).toBeDefined();
    const dir = await ctx.service.directory();
    expect(attentionOf(dir, thread!).list?.userIds.sort()).toEqual(['u_alice', 'u_bob']);
    // まだ何も読んでいなかったので、つないだ時刻から読み、読んだところまで位置を進める
    expect(lines.get('u_bob')!.calls.at(-1)).toBe(`events since ${T0}`);
    expect((await state.source(ctx.ds.id))!.line!.after).toBe(FakeLineStore.cursorOf({ receivedAt: at(3), id: 'w1' }));
    store.add({ id: 'w2', lineUserId: CAROL, text: '追伸', at: at(6) });
    ctx.clock.set(at(10));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(lines.get('u_bob')!.calls.at(-1)).toBe(`events ${FakeLineStore.cursorOf({ receivedAt: at(3), id: 'w1' })}`);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: at(10) });
  });

  it('送信（受け口の Outbound）は観測された送信として同じ相手のトピックに入る。record_sent が先でも 1 本（H5）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    store.add({ id: 'w1', lineUserId: CAROL, messageId: '5001', text: '明日の点検は何時ですか', at: at(1) });
    ctx.clock.set(at(5));
    await ctx.sync.handle({ kind: 'maintain' });
    const [thread] = await threads();
    // エージェントが受け口で送り、すぐ記録した
    await ctx.service.recordSent('u_bob', { dataSourceId: ctx.ds.id, replyToThreadId: thread!.id, to: [CAROL], toContactIds: [], body: '10 時です', sentRef: '6001', anchors: { conversationId: CAROL } });
    store.add({ id: 'out:6001', direction: 'OUTBOUND', lineUserId: CAROL, messageId: '6001', text: '10 時です', at: at(6) });
    ctx.clock.set(at(10));
    await ctx.sync.handle({ kind: 'maintain' });
    const all = await threads();
    expect(all).toHaveLength(1);
    const p = await ctx.service.state();
    const dir = await ctx.service.directory();
    expect(all[0]!.signalIds.map((id) => directionOf(dir, p.signals[id]!))).toEqual(['inbound', 'outbound']);
  });

  it('別の相手のメッセージは同じトピックに入らない（会話のアンカー。0044）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    store.add({ id: 'w1', lineUserId: CAROL, text: '点検の件', at: at(1) });
    store.add({ id: 'w2', lineUserId: DAVE, text: '点検の件', at: at(2) });
    ctx.clock.set(at(5));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await threads()).toHaveLength(2);
  });

  it(`1 回の見回りは ${MAX_PAGES_PER_RUN} ページまで。残りは位置から次の見回りで続ける`, async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const n = LINE_PAGE_SIZE * MAX_PAGES_PER_RUN + 3;
    for (let i = 0; i < n; i++) store.add({ id: `w${i}`, type: 'follow', messageType: null, lineUserId: CAROL, at: at(1) });
    store.add({ id: 'last', lineUserId: CAROL, text: '最後', at: at(2) });
    ctx.clock.set(at(5));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await threads()).toHaveLength(0);
    expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(T0);
    ctx.clock.set(at(10));
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await threads()).map((t) => t.title)).toEqual(['最後']);
    expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(at(10));
  });

  it(`読者は ${LINE_READERS_MINUTES} 分ごとに確かめ直す。読めなくなった人は読者から外れる`, async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    lines.get('u_alice')!.readable = false;
    ctx.clock.set(at(30));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    ctx.clock.set(at(LINE_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_bob']);
  });

  it('別の組織の接続で読めても、その共有リストの読者にしない', async () => {
    lines.set('u_alice', new FakeLine(new FakeLineStore(), { id: 'org_other', name: 'よそ' }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await readers()).toEqual(['u_bob']);
  });

  it('取り込みに使っている接続が読めなくなったら、読める読者の接続に入れ替えて続ける（作った人は変わらない）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    lines.get('u_bob')!.readable = false;
    store.add({ id: 'w1', lineUserId: CAROL, text: '入れ替えのあと', at: at(10) });
    ctx.clock.set(at(LINE_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual(['u_alice']);
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', userId: 'u_alice', gatewayCredentialId: 'gw_u_alice' });
    const dir = await ctx.service.directory();
    const ds = dir.dataSource(ctx.ds.id) as ServiceDataSource;
    expect(dir.credentialRef(ds.credentialRefId)).toMatchObject({ principal: { kind: 'user', userId: 'u_alice' }, gatewayCredentialId: 'gw_u_alice' });
    expect(ds.shared?.createdBy).toBe('u_bob');
    expect((await threads()).map((t) => t.title)).toEqual(['入れ替えのあと']);
  });

  it('だれも読めなければ broken。間をおいて試し直し、読めるようになれば止まっていた間の分も取って ok に戻る', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    lines.get('u_bob')!.readable = false;
    lines.get('u_alice')!.readable = false;
    ctx.clock.set(at(LINE_READERS_MINUTES));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/読める読者がいない/) });
    lines.get('u_bob')!.readable = true;
    store.add({ id: 'w1', lineUserId: CAROL, text: '止まっていた間', at: at(70) });
    ctx.clock.set(at(LINE_READERS_MINUTES * 2));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', userId: 'u_bob' });
    expect((await threads()).map((t) => t.title)).toEqual(['止まっていた間']);
  });

  it('一時的な失敗（ゲートウェイ・受け口の障害）では読者を減らさず、broken にもしない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    lines.get('u_alice')!.down = true;
    ctx.clock.set(at(LINE_READERS_MINUTES));
    await expect(ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id })).rejects.toThrow(/timeout/);
    expect(await readers()).toEqual(['u_alice', 'u_bob']);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok' });
  });
});
