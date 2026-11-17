import { beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_CHAT_DM_SCOPE, GOOGLE_CHAT_SCOPE } from '../../src/connectors/google-chat/scope';
import { ChatMessage } from '../../src/connectors/google-chat/message';
import { mentionedAddresses, normalizeChatMessage } from '../../src/connectors/google-chat/normalize';
import { advance, chatMembers, dmRecord, isThreaded, planDmSpaces, planPoll, MAX_SPACES_PER_RUN } from '../../src/connectors/google-chat/plan';
import { GoogleChatSync } from '../../src/connectors/google-chat/sync';
import type { SourceState } from '../../src/connectors/graph/state';
import { connectGoogleChatDms, connectGoogleChatSpace, Directory, googleAccountOf, googleChatAccount, planMasterEdit, seedProblems, type ServiceDataSource } from '../../src/domain';
import { inScope } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { bot, chatMessage, FakeGoogleChat, human } from '../helpers/fake-google-chat';
import { counterIds, makeService } from '../helpers/service';
import { answer, seed } from '../helpers/world';

// Google Chat（0045）: スペースの共有リストと、本人の DM・グループの個人リスト

const T0 = '2026-11-17T03:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const SPACE = 'spaces/AAA111';
const ALICE = '100';
const BOB = '200';
const U_ALICE = `google_${ALICE}`;
const U_BOB = `google_${BOB}`;
const msg = (raw: Record<string, unknown>) => ChatMessage.parse(raw);

describe('Google Chat のアカウントと読める口（0045 の決定 3・5）', () => {
  it('users/<ID> とゲートウェイの User ID（google_<sub>）を行き来する。形が違えば null', () => {
    expect(googleChatAccount('users/123')).toBe('123');
    expect(googleChatAccount('users/app')).toBeNull();
    expect(googleChatAccount(undefined)).toBeNull();
    expect(googleAccountOf('google_123')).toBe('123');
    expect(googleAccountOf('entra_t_o')).toBeNull();
  });

  it('スペースの口: 一覧・1 つ・メンバー・メッセージの GET だけ。DM の口は 1 つの取得を通さない。書き込みと、ほかの口は断る', () => {
    for (const path of ['/v1/spaces?filter=x', `/v1/${SPACE}`, `/v1/${SPACE}/members?pageSize=1000`, `/v1/${SPACE}/messages?filter=createTime`]) {
      expect(inScope(GOOGLE_CHAT_SCOPE, 'GET', path), path).toBe(true);
    }
    expect(inScope(GOOGLE_CHAT_DM_SCOPE, 'GET', `/v1/${SPACE}`)).toBe(false);
    expect(inScope(GOOGLE_CHAT_DM_SCOPE, 'GET', `/v1/${SPACE}/messages`)).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(inScope(GOOGLE_CHAT_SCOPE, method, `/v1/${SPACE}/messages`)).toBe(false);
      expect(inScope(GOOGLE_CHAT_DM_SCOPE, method, `/v1/${SPACE}/messages`)).toBe(false);
    }
    for (const path of [`/v1/${SPACE}/messages/m1`, `/v1/${SPACE}/messages/m1/reactions`, `/v1/${SPACE}/spaceEvents`, '/v1/users/me/spaces/x/spaceReadState', `/v1/${SPACE}/members/users%2F1`]) {
      expect(inScope(GOOGLE_CHAT_SCOPE, 'GET', path), path).toBe(false);
    }
  });
});

describe('H8 Google Chat の正規化（0045 の決定 1〜3）', () => {
  const ctx = { dataSourceId: 'ds1', space: SPACE, threaded: true };

  it('スレッドを使うスペース: thread.name をアンカーにし、人へのメンションを宛先にする。sourceRef と messageId はメッセージの name', () => {
    const n = normalizeChatMessage(ctx, msg(chatMessage(SPACE, 'm1', at(1), ALICE, { mentions: [BOB, BOB], thread: 'T1', reply: true, text: '@Bob 見積もりお願いします', quoted: `${SPACE}/messages/m0` })));
    expect(n).toEqual({
      kind: 'signal',
      signal: {
        dataSourceId: 'ds1',
        channel: 'google-chat',
        from: { channel: 'google-chat', value: ALICE },
        to: [{ channel: 'google-chat', value: BOB }],
        body: '@Bob 見積もりお願いします',
        anchors: { messageId: `${SPACE}/messages/m1`, threadTs: `${SPACE}/threads/T1`, quotedMessageId: `${SPACE}/messages/m0` },
        sourceRef: `google-chat:${SPACE}/messages/m1`,
        occurredAt: at(1),
      },
    });
  });

  it('スレッドを使わないスペースでは threadTs にしない（メッセージごとに区切る。S0）', () => {
    const n = normalizeChatMessage({ ...ctx, threaded: false }, msg(chatMessage(SPACE, 'm1', at(1), ALICE)));
    expect(n.kind === 'signal' && n.signal.anchors).toEqual({ messageId: `${SPACE}/messages/m1` });
  });

  it('アプリの投稿・削除されたメッセージ・送り手のないものは取り込まない。アプリと @all・追加へのメンションは宛先にしない', () => {
    expect(normalizeChatMessage(ctx, msg(chatMessage(SPACE, 'm1', at(1), 'app', { bot: true })))).toMatchObject({ kind: 'skip' });
    expect(normalizeChatMessage(ctx, msg(chatMessage(SPACE, 'm2', at(1), ALICE, { deleted: true })))).toMatchObject({ kind: 'skip' });
    expect(normalizeChatMessage(ctx, msg({ name: `${SPACE}/messages/m3`, createTime: at(1) }))).toMatchObject({ kind: 'skip' });
    const m = msg({
      ...chatMessage(SPACE, 'm4', at(1), ALICE),
      annotations: [
        { type: 'USER_MENTION', userMention: { type: 'MENTION', user: { name: 'users/all', type: 'HUMAN' } } },
        { type: 'USER_MENTION', userMention: { type: 'MENTION', user: { name: 'users/9', type: 'BOT' } } },
        { type: 'USER_MENTION', userMention: { type: 'ADD', user: { name: `users/${BOB}`, type: 'HUMAN' } } },
        { type: 'RICH_LINK' },
      ],
    });
    expect(mentionedAddresses(m)).toEqual([]);
  });

  it('DM: 相手からのメッセージは本人宛て、本人のは相手宛て。会話のアンカーを付ける。グループはメンションだけ', () => {
    const direct = { record: { kind: 'direct' as const, members: [ALICE, BOB], checkedAt: T0 }, self: ALICE };
    const dm = { ...ctx, conversation: direct };
    const fromBob = normalizeChatMessage(dm, msg(chatMessage(SPACE, 'm1', at(1), BOB)));
    expect(fromBob.kind === 'signal' && fromBob.signal).toMatchObject({ to: [{ value: ALICE }], anchors: { conversationId: SPACE, conversationGroup: false } });
    const mine = normalizeChatMessage(dm, msg(chatMessage(SPACE, 'm2', at(2), ALICE)));
    expect(mine.kind === 'signal' && mine.signal.to).toEqual([{ channel: 'google-chat', value: BOB }]);
    const group = { ...ctx, conversation: { record: { kind: 'group' as const, members: [ALICE, BOB, '300'], checkedAt: T0 }, self: ALICE } };
    const g = normalizeChatMessage(group, msg(chatMessage(SPACE, 'm3', at(3), BOB)));
    expect(g.kind === 'signal' && g.signal).toMatchObject({ to: [], anchors: { conversationGroup: true } });
    expect(normalizeChatMessage({ ...ctx, conversation: { record: { kind: 'skip', members: [], checkedAt: T0 }, self: ALICE } }, msg(chatMessage(SPACE, 'm4', at(4), BOB)))).toMatchObject({ kind: 'skip' });
  });
});

describe('Google Chat の取り込みの計画（0045 の決定 4）', () => {
  const src = (over: Partial<SourceState>): SourceState => ({ kind: 'google-chat', dataSourceId: 'ds', userId: U_ALICE, gatewayCredentialId: 'gw', status: 'ok', reason: null, folders: {}, connectedAt: T0, lastSyncAt: null, lastRetryAt: null, ...over });

  it('見回り: 動いていれば毎回読む。setup は積んだ直後は待ち、broken は間隔をおいて試し直す', () => {
    expect(planPoll(src({}), null, at(5))).toEqual({ kind: 'poll' });
    expect(planPoll(src({ status: 'setup' }), at(0), at(5))).toEqual({ kind: 'idle' });
    expect(planPoll(src({ status: 'setup' }), at(0), at(15))).toEqual({ kind: 'setup' });
    expect(planPoll(src({ status: 'broken', lastRetryAt: at(0) }), null, at(1))).toEqual({ kind: 'idle' });
    expect(planPoll(src({ status: 'broken', lastRetryAt: at(0) }), null, at(120))).toEqual({ kind: 'retry' });
    expect(planPoll(src({ status: 'disconnected' }), null, at(5))).toEqual({ kind: 'idle' });
  });

  it('位置は読んだ中で一番新しい createTime（戻さない）。スレッドを使うかはスペースの設定から', () => {
    expect(advance(at(5), [msg(chatMessage(SPACE, 'a', at(3), ALICE)), msg(chatMessage(SPACE, 'b', at(7), ALICE))])).toBe(at(7));
    expect(advance(at(9), [msg(chatMessage(SPACE, 'a', at(3), ALICE))])).toBe(at(9));
    expect(isThreaded({ name: SPACE, spaceThreadingState: 'UNTHREADED_MESSAGES' })).toBe(false);
    expect(isThreaded({ name: SPACE, spaceThreadingState: 'THREADED_MESSAGES' })).toBe(true);
  });

  it('読者の候補は参加している人だけ（アプリ・招待中を外す）。User ID は google_<ID>', () => {
    expect(chatMembers([human(ALICE), bot('9'), { member: { name: `users/${BOB}`, type: 'HUMAN' }, state: 'INVITED' }])).toEqual([{ address: { channel: 'google-chat', value: ALICE }, userId: U_ALICE }]);
  });

  it('DM の種類: アプリとの DM は取り込まない。グループはグループ。メンバーが読めなければ取り込まない', () => {
    const dm = { name: 'spaces/D1', spaceType: 'DIRECT_MESSAGE' };
    expect(dmRecord(dm, [human(ALICE), human(BOB)], ALICE, T0)).toMatchObject({ kind: 'direct', members: [ALICE, BOB] });
    // 相手が抜けて本人だけが残る DM（S0）も、相手のメッセージは本人宛てとして取る
    expect(dmRecord(dm, [human(ALICE)], ALICE, T0)).toMatchObject({ kind: 'direct' });
    expect(dmRecord(dm, [human(ALICE), bot('9')], ALICE, T0)).toMatchObject({ kind: 'skip' });
    expect(dmRecord({ ...dm, singleUserBotDm: true }, [human(ALICE)], ALICE, T0)).toMatchObject({ kind: 'skip' });
    expect(dmRecord({ name: 'spaces/G1', spaceType: 'GROUP_CHAT' }, [human(ALICE), human(BOB)], ALICE, T0)).toMatchObject({ kind: 'group' });
    expect(dmRecord(dm, null, ALICE, T0)).toMatchObject({ kind: 'skip' });
  });

  it('読む DM は、位置（なければつないだ時刻）より後に動いたものだけ。新しい順に上限まで', () => {
    const spaces = [
      { name: 'spaces/D1', lastActiveTime: at(-5) },
      { name: 'spaces/D2', lastActiveTime: at(3) },
      { name: 'spaces/D3', lastActiveTime: at(8) },
      { name: 'spaces/D4' },
    ];
    expect(planDmSpaces(spaces, {}, T0, at(10)).map((s) => s.name)).toEqual(['spaces/D3', 'spaces/D2']);
    expect(planDmSpaces(spaces, { 'spaces/D3': { kind: 'direct', members: [], checkedAt: at(0), syncedUntil: at(8) } }, T0, at(10)).map((s) => s.name)).toEqual(['spaces/D2']);
    // 取り込まないものは読み直す時期まで読まない
    expect(planDmSpaces(spaces, { 'spaces/D2': { kind: 'skip', members: [], checkedAt: at(0) } }, T0, at(10)).map((s) => s.name)).toEqual(['spaces/D3']);
    const many = Array.from({ length: MAX_SPACES_PER_RUN + 5 }, (_, i) => ({ name: `spaces/X${i}`, lastActiveTime: at(i + 1) }));
    expect(planDmSpaces(many, {}, T0, at(100))).toHaveLength(MAX_SPACES_PER_RUN);
  });
});

describe('H3 H8 Google Chat のスペースの同期（偽の Chat）', () => {
  let now: string;
  let chat: FakeGoogleChat;
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;
  const world = { ...seed, users: [...seed.users, { id: U_ALICE, name: 'Alice' }, { id: U_BOB, name: 'Bob' }] };

  async function setup() {
    let ds!: ServiceDataSource;
    const { after } = planMasterEdit(world, (d) => {
      ds = connectGoogleChatSpace(d, { dir: new Directory(d), now: T0, newId: counterIds() }, { userId: U_ALICE, gatewayCredentialId: 'gw_chat', space: SPACE, spaceName: '開発', threaded: true, account: ALICE }).dataSource;
    });
    expect(seedProblems(after)).toEqual([]);
    const made = await makeService(after, { decide: () => answer({ needs_response: true }) });
    made.clock.set(T0);
    await state.putSource({ kind: 'google-chat', dataSourceId: ds.id, userId: U_ALICE, gatewayCredentialId: 'gw_chat', status: 'setup', reason: null, folders: {}, googleChat: { syncedUntil: T0, setupAt: T0 }, connectedAt: T0, lastSyncAt: null, lastRetryAt: null });
    const sync = new GoogleChatSync({ service: made.service, state, chatFor: async () => chat, now: () => now });
    return { ...made, sync, ds };
  }

  const readers = async () => {
    const dir = await ctx.service.directory();
    return dir.readersOfList(dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id)!.id).sort();
  };
  const signals = async () => Object.values((await ctx.service.state()).signals).filter((s) => s.dataSourceId === ctx.ds.id);
  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);

  beforeEach(async () => {
    now = T0;
    chat = new FakeGoogleChat();
    chat.addSpace({ name: SPACE, displayName: '開発', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' }, [human(ALICE), human(BOB), human('999'), bot('9')]);
    state = new MemoryConnectorState();
    ctx = await setup();
  });

  it('setup: 読者をメンバーから写し（User のある人だけ）、つないだあとのメッセージを取り込んで ok。スレッドの返信は同じトピックに入る', async () => {
    chat.post(SPACE, chatMessage(SPACE, 'm0', at(-30), BOB));
    chat.post(SPACE, chatMessage(SPACE, 'm1', at(2), BOB, { thread: 'T1', mentions: [ALICE] }));
    chat.post(SPACE, chatMessage(SPACE, 'm2', at(4), ALICE, { thread: 'T1', reply: true }));
    chat.post(SPACE, chatMessage(SPACE, 'm3', at(5), 'app', { bot: true }));
    now = at(10);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await readers()).toEqual([U_ALICE, U_BOB].sort());
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: at(10), googleChat: { syncedUntil: at(5), readersSyncedAt: at(10) } });
    expect((await signals()).map((s) => s.body).sort()).toEqual(['本文 m1', '本文 m2']);
    expect(await threads()).toHaveLength(1);
  });

  it('見回り: 位置から重なりを引いて読み、同じものは二重にならない。新しいメッセージだけ増える。60 分ごとに読者を写し直す', async () => {
    chat.post(SPACE, chatMessage(SPACE, 'm1', at(2), BOB));
    now = at(3);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    chat.post(SPACE, chatMessage(SPACE, 'm2', at(6), BOB, { thread: 't-m1', reply: true }));
    now = at(8);
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await signals()).map((s) => s.body).sort()).toEqual(['本文 m1', '本文 m2']);
    expect(chat.calls.filter((c) => c.startsWith('messages')).at(-1)).toBe(`messages ${SPACE} ${at(-8)}`);
    chat.membersOf.set(SPACE, [human(ALICE)]);
    now = at(20);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual([U_BOB, U_ALICE].sort());
    now = at(70);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await readers()).toEqual([U_ALICE]);
  });

  it('ページの上限で止めても、読んだところまで位置が進み、次の見回りで続く', async () => {
    chat.pageSize = 2;
    for (let i = 0; i < 12; i++) chat.post(SPACE, chatMessage(SPACE, `m${i}`, at(1 + i), BOB));
    now = at(20);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await signals()).toHaveLength(10);
    expect((await state.source(ctx.ds.id))?.googleChat?.syncedUntil).toBe(at(10));
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await signals()).toHaveLength(12);
  });

  it('つないだ人がメンバーでなくなった・スペースが読めない・接続が切れたら broken（読んだものは残る）', async () => {
    chat.membersOf.set(SPACE, [human(BOB)]);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/メンバーでなくなった/) });

    ctx = await setup();
    chat.unreadable.set(SPACE, 404);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/読めない/) });

    ctx = await setup();
    chat.unreadable.clear();
    chat.authBroken = true;
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken' });
  });

  it('外したもの・読んでいる間につなぎ直されたものには書かない', async () => {
    await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected' });
    await ctx.sync.handle({ kind: 'maintain' });
    expect(chat.calls).toEqual([]);
    await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'ok' });
    chat.post(SPACE, chatMessage(SPACE, 'm1', at(2), BOB));
    const realMessages = chat.messages.bind(chat);
    chat.messages = async (space, opts) => {
      await state.putSource({ ...(await state.source(ctx.ds.id))!, gatewayCredentialId: 'gw_other' });
      return realMessages(space, opts);
    };
    now = at(5);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(await state.source(ctx.ds.id)).toMatchObject({ gatewayCredentialId: 'gw_other', lastSyncAt: null });
  });
});

describe('H3 H8 Google Chat の DM・グループの同期（偽の Chat）', () => {
  let now: string;
  let chat: FakeGoogleChat;
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;
  const world = { ...seed, users: [...seed.users, { id: U_ALICE, name: 'Alice' }] };
  const D1 = 'spaces/DM1';
  const D2 = 'spaces/DMBOT';
  const G1 = 'spaces/GRP1';

  async function setup() {
    let ds!: ServiceDataSource;
    const { after } = planMasterEdit(world, (d) => {
      ds = connectGoogleChatDms(d, { dir: new Directory(d), now: T0, newId: counterIds() }, { userId: U_ALICE, gatewayCredentialId: 'gw_chat', displayName: 'Alice', account: ALICE }).dataSource;
    });
    expect(seedProblems(after)).toEqual([]);
    const made = await makeService(after, { decide: () => answer({ needs_response: true }) });
    made.clock.set(T0);
    await state.putSource({ kind: 'google-chat-dm', dataSourceId: ds.id, userId: U_ALICE, gatewayCredentialId: 'gw_chat', status: 'setup', reason: null, folders: {}, googleChatDm: { spaces: {}, setupAt: T0 }, connectedAt: T0, lastSyncAt: null, lastRetryAt: null });
    const sync = new GoogleChatSync({ service: made.service, state, chatFor: async () => chat, now: () => now });
    return { ...made, sync, ds };
  }

  const signals = async () => Object.values((await ctx.service.state()).signals).filter((s) => s.dataSourceId === ctx.ds.id);

  beforeEach(async () => {
    now = T0;
    chat = new FakeGoogleChat();
    chat.addSpace({ name: D1, spaceType: 'DIRECT_MESSAGE', lastActiveTime: at(-60) }, [human(ALICE), human(BOB)]);
    chat.addSpace({ name: D2, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true, lastActiveTime: at(-60) }, [human(ALICE), bot('9')]);
    chat.addSpace({ name: G1, spaceType: 'GROUP_CHAT', lastActiveTime: at(-60) }, [human(ALICE), human(BOB), human('300')]);
    chat.addSpace({ name: SPACE, spaceType: 'SPACE', lastActiveTime: at(-60) }, [human(ALICE)]);
    state = new MemoryConnectorState();
    ctx = await setup();
  });

  it('つないだあとに動いた DM・グループだけを読む。アプリとの DM とスペースは読まない。DM は本人宛て、グループはメンションだけ', async () => {
    chat.post(D1, chatMessage(D1, 'a', at(2), BOB));
    chat.post(D2, chatMessage(D2, 'b', at(2), 'app', { bot: true }));
    chat.post(G1, chatMessage(G1, 'c', at(3), BOB));
    chat.post(G1, chatMessage(G1, 'd', at(4), '300', { mentions: [ALICE] }));
    chat.post(SPACE, chatMessage(SPACE, 'e', at(4), BOB));
    now = at(10);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    const sigs = await signals();
    expect(sigs.map((s) => s.body).sort()).toEqual(['本文 a', '本文 c', '本文 d']);
    expect(sigs.find((s) => s.body === '本文 a')).toMatchObject({ to: [{ value: ALICE }], anchors: { conversationId: D1, conversationGroup: false } });
    expect(sigs.find((s) => s.body === '本文 c')?.to).toEqual([]);
    expect(sigs.find((s) => s.body === '本文 d')?.to).toEqual([{ channel: 'google-chat', value: ALICE }]);
    expect(chat.calls.some((c) => c.startsWith(`messages ${D2}`) || c.startsWith(`messages ${SPACE}`))).toBe(false);
    const source = await state.source(ctx.ds.id);
    expect(source).toMatchObject({ status: 'ok', lastSyncAt: at(10) });
    expect(source?.googleChatDm?.spaces).toMatchObject({ [D1]: { kind: 'direct', syncedUntil: at(2) }, [D2]: { kind: 'skip' }, [G1]: { kind: 'group', syncedUntil: at(4) } });

    // 動いていない DM は読み直さない
    const before = chat.calls.filter((c) => c.startsWith('messages')).length;
    now = at(15);
    await ctx.sync.handle({ kind: 'maintain' });
    expect(chat.calls.filter((c) => c.startsWith('messages')).length).toBe(before);
    chat.post(D1, chatMessage(D1, 'f', at(16), ALICE));
    now = at(20);
    await ctx.sync.handle({ kind: 'maintain' });
    expect((await signals()).find((s) => s.body === '本文 f')?.to).toEqual([{ channel: 'google-chat', value: BOB }]);
  });

  it('読めなくなった DM は、接続を止めずにその DM だけ取り込まない', async () => {
    chat.post(D1, chatMessage(D1, 'a', at(2), BOB));
    chat.post(G1, chatMessage(G1, 'c', at(3), BOB, { mentions: [ALICE] }));
    chat.unreadable.set(D1, 403);
    now = at(10);
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect((await signals()).map((s) => s.body)).toEqual(['本文 c']);
    const source = await state.source(ctx.ds.id);
    expect(source?.status).toBe('ok');
    expect(source?.googleChatDm?.spaces[D1]).toMatchObject({ kind: 'skip' });
  });
});
