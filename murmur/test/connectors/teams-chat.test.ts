import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { chatIdOfResource, jobsFromNotifications } from '../../src/connectors/graph/notifications';
import type { TeamsChatRecord } from '../../src/connectors/graph/state';
import { chatRecord, planChatsPage } from '../../src/connectors/teams-chat/plan';
import { normalizeChatMessage } from '../../src/connectors/teams-chat/normalize';
import { TEAMS_CHAT_SCOPE } from '../../src/connectors/teams-chat/scope';
import { TeamsChatSync } from '../../src/connectors/teams-chat/sync';
import { Chat } from '../../src/connectors/teams-chat/message';
import { MessageBase } from '../../src/connectors/teams/message';
import { normalizeChannelMessage } from '../../src/connectors/teams/normalize';
import { TEAMS_SCOPE } from '../../src/connectors/teams/scope';
import { connectTeamsChats, Directory, planMasterEdit, summarizeThread, type MailboxPlan } from '../../src/domain';
import { inScope } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { FakeTeamsChat } from '../helpers/fake-teams-chat';
import { counterIds, makeService } from '../helpers/service';
import { answer, seed } from '../helpers/world';

// Teams のチャット（0044）

const T0 = '2026-11-17T03:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const TN = 'tenant-1';
const SELF = { tenantId: TN, objectId: 'oid-alice' };
const URL_ = 'https://gw.test/murmur/webhooks/graph';
const DIRECT = '19:oid-alice_oid-carol@unq.gbl.spaces';
const GROUP = '19:group1@thread.v2';

const from = (oid: string, tenantId: string | null = TN) => ({ user: { id: oid, displayName: oid, ...(tenantId ? { tenantId } : {}) } });
const message = (id: string, min: number, over: Record<string, unknown> = {}) => ({
  id,
  messageType: 'message',
  createdDateTime: at(min),
  lastModifiedDateTime: at(min),
  body: { contentType: 'html', content: `<p>本文 ${id}</p>` },
  from: from('oid-carol'),
  mentions: [],
  attachments: [],
  ...over,
});
const record = (kind: TeamsChatRecord['kind'], members: string[] = ['oid-alice', 'oid-carol']): TeamsChatRecord => ({
  kind,
  tenantId: TN,
  members: members.map((objectId) => ({ objectId, tenantId: TN })),
  checkedAt: T0,
});
const norm = (rec: TeamsChatRecord, raw: unknown, chatId = DIRECT) => normalizeChatMessage({ dataSourceId: 'ds_c', chatId, record: rec, self: SELF }, MessageBase.parse(raw));

describe('正規化（0044 の決定 2〜4）', () => {
  it('1 対 1: 相手からは本人宛て、本人からは相手宛て。会話のアンカーが付く', () => {
    expect(norm(record('direct'), message('1', 0))).toMatchObject({
      kind: 'signal',
      signal: {
        channel: 'teams',
        from: { channel: 'teams', value: `${TN}/oid-carol` },
        to: [{ channel: 'teams', value: `${TN}/oid-alice` }],
        body: '本文 1',
        anchors: { messageId: '1', conversationId: DIRECT, conversationGroup: false },
        sourceRef: `teams-chat:${DIRECT}/1`,
      },
    });
    expect(norm(record('direct'), message('2', 0, { from: from('oid-alice') }))).toMatchObject({ signal: { to: [{ value: `${TN}/oid-carol` }] } });
  });

  it('グループ: 個人へのメンションだけが宛先。tenantId のないメンションはメンバー、チャットのテナントの順に補う（S0）。チャット全体へのメンションは落とす', () => {
    const rec: TeamsChatRecord = { ...record('group', ['oid-alice', 'oid-carol', 'oid-guest']), members: [{ objectId: 'oid-alice', tenantId: TN }, { objectId: 'oid-carol', tenantId: TN }, { objectId: 'oid-guest', tenantId: 'other' }] };
    expect(norm(rec, message('1', 0), GROUP)).toMatchObject({ signal: { to: [], anchors: { conversationGroup: true } } });
    const mentions = [
      { id: 0, mentioned: { user: { id: 'oid-guest', userIdentityType: 'aadUser' } } },
      { id: 1, mentioned: { user: { id: 'oid-left', userIdentityType: 'aadUser' } } },
      { id: 2, mentioned: { conversation: { id: GROUP } } },
    ];
    expect(norm(rec, message('2', 0, { mentions }), GROUP)).toMatchObject({ signal: { to: [{ value: 'other/oid-guest' }, { value: `${TN}/oid-left` }] } });
  });

  it('引用の返信は quotedMessageId。転送はアンカーにしない。アプリ・システム・削除は取り込まない。取り込まないチャットは何も出さない', () => {
    expect(norm(record('direct'), message('3', 0, { attachments: [{ id: '1', contentType: 'messageReference' }] }))).toMatchObject({ signal: { anchors: { quotedMessageId: '1' } } });
    const fwd = norm(record('direct'), message('4', 0, { attachments: [{ id: '99', contentType: 'forwardedMessageReference' }] }));
    expect(fwd.kind === 'signal' && fwd.signal.anchors?.quotedMessageId).toBeUndefined();
    expect(norm(record('direct'), message('5', 0, { from: { application: { id: 'jira' } } })).kind).toBe('skip');
    expect(norm(record('direct'), message('6', 0, { messageType: 'systemEventMessage' })).kind).toBe('skip');
    expect(norm(record('direct'), message('7', 0, { deletedDateTime: at(1) })).kind).toBe('skip');
    expect(norm(record('skip'), message('8', 0)).kind).toBe('skip');
  });

  it('チャネルの正規化も、tenantId のないメンションを投稿者のテナントで補う（落とさない）', () => {
    const n = normalizeChannelMessage('ds_t', '19:ch', { ...MessageBase.parse(message('1', 0, { mentions: [{ id: 0, mentioned: { user: { id: 'oid-bob' } } }] })), replies: [] });
    expect(n).toMatchObject({ signal: { to: [{ value: `${TN}/oid-bob` }] } });
  });
});

describe('チャットの種類と見回りの計画（0044 の決定 1・5）', () => {
  const chat = (id: string, chatType: string, last?: string) => Chat.parse({ id, chatType, tenantId: TN, ...(last ? { lastMessagePreview: { createdDateTime: last } } : {}) });
  const people = (...oids: string[]) => oids.map((userId) => ({ userId, tenantId: TN }));

  it('取り込むのは 1 対 1 とグループだけ。会議・未知の種類・相手がアプリだけの 1 対 1 は取り込まない', () => {
    expect(chatRecord(chat('a', 'oneOnOne'), people('oid-alice', 'oid-carol'), 'oid-alice', T0).kind).toBe('direct');
    expect(chatRecord(chat('b', 'group'), people('oid-alice', 'oid-carol', 'oid-dave'), 'oid-alice', T0).kind).toBe('group');
    expect(chatRecord(chat('c', 'meeting'), people('oid-alice'), 'oid-alice', T0).kind).toBe('skip');
    expect(chatRecord(chat('d', 'unknownFutureValue'), [], 'oid-alice', T0).kind).toBe('skip');
    expect(chatRecord(chat('e', 'oneOnOne'), [...people('oid-alice'), { userId: null }], 'oid-alice', T0).kind).toBe('skip');
    expect(chatRecord(chat('f', 'group'), null, 'oid-alice', T0).kind).toBe('skip');
  });

  it('一覧のページから、前に読んだあとに動いたチャットだけを選び、一覧の重なりより古いところで止まる', () => {
    // a は位置（at 10）から重なり（30 分）を引いた時刻より前に動いたきり。s は取り込まないチャット。o で一覧の重なりより古くなる
    const records = { a: { ...record('direct'), syncedUntil: at(10) }, s: record('skip') };
    const page = [chat('n', 'oneOnOne', at(20)), chat('a', 'oneOnOne', at(-25)), chat('s', 'meeting', at(-26)), chat('o', 'group', at(-90)), chat('x', 'group', at(3))];
    expect(planChatsPage(page, at(-60), records, at(-120), at(30))).toEqual({ read: [page[0]], done: true });
    // 種類を読み直す時期（1 日）を過ぎた取り込まないチャットは、もう一度読む
    expect(planChatsPage([page[2]!], at(-60), records, at(-120), at(24 * 60 + 1)).read).toEqual([page[2]]);
  });

  it('通知の resource からチャットの ID を取る。チャットでなければ取らない。通知の仕事はチャットごとにまとまる', async () => {
    expect(chatIdOfResource(`chats('${DIRECT}')/messages('1612289765949')`)).toBe(DIRECT);
    expect(chatIdOfResource("teams('t')/channels('c')/messages('1')")).toBeNull();
    expect(chatIdOfResource('Users/u/Messages/m')).toBeNull();
    const sub = { id: 'sub-1', dataSourceId: 'ds_c', folder: 'chats', clientStateHash: 'h(cs)', expiresAt: at(100) };
    const n = (chatId: string, m: string) => ({ subscriptionId: 'sub-1', clientState: 'cs', resource: `chats('${chatId}')/messages('${m}')` });
    const r = await jobsFromNotifications({ value: [n(DIRECT, '1'), n(DIRECT, '2'), n(GROUP, '3')] }, { subscription: async () => sub, hash: async (t) => `h(${t})` });
    expect(r.jobs).toEqual([
      { kind: 'sync', dataSourceId: 'ds_c', folder: 'chats', chatId: DIRECT },
      { kind: 'sync', dataSourceId: 'ds_c', folder: 'chats', chatId: GROUP },
    ]);
  });

  it('H3 読める口: チャットの読み取りと購読の管理だけ。投稿は通らない。チャネルの口からはチャットを読めない', () => {
    const id = encodeURIComponent(DIRECT);
    expect(inScope(TEAMS_CHAT_SCOPE, 'GET', '/v1.0/me/chats?$expand=lastMessagePreview')).toBe(true);
    expect(inScope(TEAMS_CHAT_SCOPE, 'GET', `/v1.0/chats/${id}/messages?$top=50`)).toBe(true);
    expect(inScope(TEAMS_CHAT_SCOPE, 'GET', `/v1.0/chats/${id}/members`)).toBe(true);
    expect(inScope(TEAMS_CHAT_SCOPE, 'POST', `/v1.0/chats/${id}/messages`)).toBe(false);
    expect(inScope(TEAMS_CHAT_SCOPE, 'GET', '/v1.0/me/messages')).toBe(false);
    expect(inScope(TEAMS_CHAT_SCOPE, 'GET', '/v1.0/teams/t/channels/c/messages')).toBe(false);
    expect(inScope(TEAMS_SCOPE, 'GET', `/v1.0/chats/${id}/messages`)).toBe(false);
  });
});

describe('H3 H8 Teams のチャットの同期（偽の Teams）', () => {
  let now: string;
  let fake: FakeTeamsChat;
  let state: MemoryConnectorState;
  let queued: SyncJob[];
  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    let plan!: MailboxPlan;
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectTeamsChats(d, { dir: new Directory(d), now: T0, newId: counterIds() }, { userId: 'u_alice', gatewayCredentialId: 'gw_graph', displayName: 'Alice', ...SELF });
    });
    // 区切りの AI の代わり: 候補があれば最初の候補の続き（候補が同じ会話に限られることを確かめる）
    const made = await makeService(after, {
      decide: (req) => {
        if (req.mode !== 'choose') return answer();
        const p = req.signal.anchors.conversationId;
        expect(req.candidates.length).toBeGreaterThan(0);
        return answer({ thread: 'existing', thread_id: req.candidates[0]!.threadId, reason: `same ${p}` });
      },
    });
    made.clock.set(T0);
    const ds = plan.dataSource;
    await state.putSource({ kind: 'teams-chat', dataSourceId: ds.id, userId: 'u_alice', gatewayCredentialId: 'gw_graph', status: 'setup', reason: null, folders: {}, teamsChat: { syncedUntil: T0, chats: {} }, connectedAt: T0, lastSyncAt: null, lastRetryAt: null });
    const sync = new TeamsChatSync({
      service: made.service,
      state,
      queue: { send: async (j) => void queued.push(j) },
      chatsFor: async () => fake,
      now: () => now,
      notificationUrl: URL_,
      newClientState: () => 'cs',
      hash: async (t) => `h(${t})`,
    });
    return { ...made, sync, ds };
  }

  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);
  const summaries = async () => {
    const dir = await ctx.service.directory();
    const p = await ctx.service.state();
    return (await threads()).map((t) => summarizeThread(dir, p, t));
  };

  beforeEach(async () => {
    now = T0;
    fake = new FakeTeamsChat();
    fake.addChat({ id: DIRECT, chatType: 'oneOnOne', tenantId: TN }, [{ userId: 'oid-alice', tenantId: TN }, { userId: 'oid-carol', tenantId: TN }]);
    fake.addChat({ id: GROUP, chatType: 'group', tenantId: TN }, [{ userId: 'oid-alice', tenantId: TN }, { userId: 'oid-carol', tenantId: TN }, { userId: 'oid-dave', tenantId: TN }]);
    fake.addChat({ id: '19:meeting@thread.v2', chatType: 'meeting', tenantId: TN }, [{ userId: 'oid-alice', tenantId: TN }]);
    fake.addChat({ id: '19:bot@unq.gbl.spaces', chatType: 'oneOnOne', tenantId: TN }, [{ userId: 'oid-alice', tenantId: TN }]);
    fake.addChat({ id: '19:unknown@thread.v2', chatType: 'unknownFutureValue', tenantId: TN }, [], { forbidden: true });
    state = new MemoryConnectorState();
    queued = [];
    ctx = await setup();
  });

  it('setup: 本人の全チャットの購読を作り、つないだあとのメッセージを取り込む。会議・アプリだけ・読めないチャットは取り込まない', async () => {
    fake.post(DIRECT, message('d0', -60));
    fake.post(DIRECT, message('d1', 2));
    fake.post(GROUP, message('g1', 3, { from: from('oid-dave') }));
    fake.post('19:meeting@thread.v2', message('m1', 4));
    fake.post('19:bot@unq.gbl.spaces', message('b1', 5, { from: { application: { id: 'jira' } } }));
    fake.post('19:unknown@thread.v2', message('u1', 6));
    now = at(10);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect([...fake.subscriptions.values()]).toEqual([{ resource: '/users/oid-alice/chats/getAllMessages', notificationUrl: URL_, expiresAt: expect.any(String) }]);
    const source = await state.source(ctx.ds.id);
    expect(source).toMatchObject({ status: 'ok', lastSyncAt: at(10), teamsChat: { syncedUntil: at(10) } });
    expect(Object.fromEntries(Object.entries(source!.teamsChat!.chats).map(([k, v]) => [k, v.kind]))).toEqual({
      [DIRECT]: 'direct',
      [GROUP]: 'group',
      '19:meeting@thread.v2': 'skip',
      '19:bot@unq.gbl.spaces': 'skip',
      '19:unknown@thread.v2': 'skip',
    });
    const bodies = Object.values((await ctx.service.state()).signals).filter((s) => s.dataSourceId === ctx.ds.id).map((s) => s.body).sort();
    expect(bodies).toEqual(['本文 d1', '本文 g1']);
    // 1 対 1 の相手からのメッセージは本人へのアテンション。グループのメンションのない投稿はアテンションにならない
    const s = await summaries();
    const direct = s.find((x) => x.attention.named.length > 0);
    expect(direct?.attention.named).toMatchObject([{ userId: 'u_alice' }]);
    expect(s.filter((x) => x.attention.named.length === 0 && x.attention.list === null)).toHaveLength(1);
  });

  it('通知: そのチャットだけを読み、重なりで同じものを読んでも二重にならない。返事は同じ会話のスレッドに入り、別のチャットのスレッドには入らない', async () => {
    fake.post(DIRECT, message('d1', 2));
    fake.post(GROUP, message('g1', 3, { from: from('oid-carol') }));
    now = at(10);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    fake.post(DIRECT, message('d2', 12, { from: from('oid-alice') }));
    fake.post(DIRECT, message('d3', 14, { attachments: [{ id: 'd2', contentType: 'messageReference' }] }));
    fake.calls.length = 0;
    now = at(15);
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'chats', chatId: DIRECT });
    expect(fake.calls.filter((c) => c.startsWith('messages')).map((c) => c.split(' ')[1])).toEqual([DIRECT]);
    expect(fake.calls.some((c) => c.startsWith('chat ') || c.startsWith('members'))).toBe(false);
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'chats', chatId: DIRECT });
    const p = await ctx.service.state();
    const direct = (await threads()).filter((t) => t.signalIds.some((id) => p.signals[id]!.anchors.conversationId === DIRECT));
    expect(direct).toHaveLength(1);
    expect(direct[0]!.signalIds.map((id) => p.signals[id]!.body)).toEqual(['本文 d1', '本文 d2', '本文 d3']);
  });

  it('見回り: 10 分おきにチャットの一覧を見て、前に読んだあとに動いたチャットだけを読む。通知のない新しいチャットも拾う', async () => {
    now = at(1);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    fake.addChat({ id: '19:new@unq.gbl.spaces', chatType: 'oneOnOne', tenantId: TN }, [{ userId: 'oid-alice', tenantId: TN }, { userId: 'oid-erin', tenantId: TN }]);
    fake.post('19:new@unq.gbl.spaces', message('n1', 6, { from: from('oid-erin') }));
    fake.calls.length = 0;
    now = at(5);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(fake.calls.filter((c) => c.startsWith('chats'))).toHaveLength(0);
    now = at(12);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(fake.calls.filter((c) => c.startsWith('messages')).map((c) => c.split(' ')[1])).toEqual(['19:new@unq.gbl.spaces']);
    expect(Object.values((await ctx.service.state()).signals).map((s) => s.body)).toContain('本文 n1');
  });

  it('H5 エージェントがチャットで送って会話つきで record_sent したら、観測は記録に重なり、相手の返事はそのトピック（返事待ち）に入る', async () => {
    now = at(1);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const sent = await ctx.service.recordSent('u_alice', {
      dataSourceId: ctx.ds.id,
      to: [`${TN}/oid-carol`],
      toContactIds: [],
      body: '明日の件、確認お願いします',
      sentRef: 'd9',
      anchors: { conversationId: DIRECT, conversationGroup: false },
    });
    const t = sent.thread;
    fake.post(DIRECT, message('d9', 2, { from: from('oid-alice'), body: { contentType: 'text', content: '明日の件、確認お願いします' } }));
    fake.post(DIRECT, message('d10', 3, { body: { contentType: 'text', content: '確認しました' } }));
    now = at(4);
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'chats', chatId: DIRECT });
    const p = await ctx.service.state();
    expect(p.threads[t.id]!.signalIds.map((id) => p.signals[id]!.body)).toEqual(['明日の件、確認お願いします', '確認しました']);
    expect(p.signals[p.threads[t.id]!.signalIds[1]!]!.threadedBy).toBe('awaiting');
  });

  it('接続の問題は broken。外したら購読を消す', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(fake.subscriptions.size).toBe(1);
    fake.authBroken = true;
    now = at(20);
    await ctx.sync.handle({ kind: 'sync', dataSourceId: ctx.ds.id, folder: 'chats', chatId: DIRECT });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken' });
    fake.authBroken = false;
    await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected' });
    await ctx.sync.handle({ kind: 'disconnect', dataSourceId: ctx.ds.id });
    expect(fake.subscriptions.size).toBe(0);
  });
});
