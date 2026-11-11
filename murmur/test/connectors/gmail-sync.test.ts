import { beforeEach, describe, expect, it } from 'vitest';
import { GmailError } from '../../src/connectors/gmail/api';
import { GatewayAuthError, GatewayError } from '../../src/ports/gateway';
import { LlmApiError } from '../../src/ingest/llm';
import { GoogleApiNotEnabled } from '../../src/connectors/google-error';
import { GmailMessage } from '../../src/connectors/gmail/message';
import { normalizeGmailMessage } from '../../src/connectors/gmail/normalize';
import { MAX_FETCH_PER_RUN, SAVE_EVERY } from '../../src/connectors/gmail/plan';
import { GmailSync } from '../../src/connectors/gmail/sync';
import type { SourceState } from '../../src/connectors/graph/state';
import { connectMailbox, DomainError, directionOf, Directory, planMasterEdit, type MailboxPlan, type ServiceDataSource } from '../../src/domain';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { counterIds, makeService } from '../helpers/service';
import { FakeGmail, gmailMessage } from '../helpers/fake-gmail';
import { answer, seed } from '../helpers/world';

// Gmail の個人の箱の同期（0041）。ゲートウェイと Gmail は偽物。変更の通知はなく、見回り（maintain）で履歴を読む

const T0 = '2026-11-11T00:00:00.000Z';
const mailAt = (min: number, sec = 0) => new Date(Date.parse(T0) + min * 60_000 + sec * 1000).toISOString();
const from = (name: string) => `${name}@example.com`;

describe('H5 H6 Gmail の個人の箱の同期（偽の Gmail）', () => {
  let gmail: FakeGmail;
  let state: MemoryConnectorState;
  let ctx: Awaited<ReturnType<typeof setup>>;
  let logs: Record<string, unknown>[];

  async function setup() {
    let plan!: MailboxPlan;
    const newId = counterIds();
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectMailbox(d, { dir: new Directory(d), now: T0, newId }, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', addresses: ['bob@gws.example'], service: 'gmail' });
    });
    const ds = plan.dataSource as ServiceDataSource;
    const made = await makeService(after, {
      decide: (req) => answer({ thread: req.candidates.length > 0 ? 'existing' : 'new', thread_id: req.candidates[0]?.threadId ?? null, needs_response: true }),
    });
    made.clock.set(T0);
    const sync = new GmailSync({ service: made.service, state, gmailFor: async () => gmail, now: () => made.clock.now(), log: (e) => logs.push(e) });
    const source: SourceState = {
      kind: 'gmail',
      dataSourceId: ds.id,
      userId: 'u_bob',
      gatewayCredentialId: 'gw_bob',
      status: 'setup',
      reason: null,
      folders: {},
      gmail: { historyId: null, recovery: null },
      connectedAt: T0,
      lastSyncAt: null,
      lastRetryAt: null,
    };
    await state.putSource(source);
    return { ...made, ds, sync };
  }

  const threads = async () => Object.values((await ctx.service.state()).threads).filter((t) => t.dataSourceId === ctx.ds.id);
  const signals = async () => Object.values((await ctx.service.state()).signals).filter((s) => s.dataSourceId === ctx.ds.id);
  const cursor = async () => (await state.source(ctx.ds.id))!.gmail;
  const maintain = (at?: string) => {
    if (at) ctx.clock.set(at);
    return ctx.sync.handle({ kind: 'maintain' });
  };

  beforeEach(async () => {
    gmail = new FakeGmail();
    state = new MemoryConnectorState();
    logs = [];
    ctx = await setup();
  });

  it('つないだあと（setup）: profile.historyId を位置にして ok になる。つなぐ前のメールは取り込まない（取りにも行かない）', async () => {
    gmail.deliver(gmailMessage({ from: from('carol'), at: mailAt(-60), subject: 'つなぐ前' }));
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
    expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', reason: null, lastSyncAt: T0 });
    expect(gmail.calls).toEqual(['profile']);
    expect(await signals()).toEqual([]);
    // 次の見回りでも、つなぐ前のメールは出てこない
    await maintain(mailAt(5));
    expect(await signals()).toEqual([]);
    expect(gmail.fetched).toEqual([]);
  });

  it('見回り: 増えたメール（受信と送信）を取り込み、同じスレッドに入れる。位置は履歴の最新に進む。変化がなくても進む', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    gmail.deliver(gmailMessage({ from: from('carol'), at: mailAt(1), subject: '見積のお願い', mid: '<c1@example.com>', id: 'in1' }));
    gmail.deliver(gmailMessage({ from: 'Bob Tanaka <bob@gws.example>', to: from('carol'), at: mailAt(2), subject: 'Re: 見積のお願い', mid: '<b1@gws.example>', inReplyTo: '<c1@example.com>', labels: ['SENT'], id: 'out1' }));
    await maintain(mailAt(5));
    const [thread] = await threads();
    expect(await threads()).toHaveLength(1);
    const p = await ctx.service.state();
    const dir = await ctx.service.directory();
    expect(thread!.signalIds.map((id) => directionOf(dir, p.signals[id]!))).toEqual(['inbound', 'outbound']);
    expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
    expect(await state.source(ctx.ds.id)).toMatchObject({ lastSyncAt: mailAt(5) });
    // 何も増えていなくても位置は箱の最新になる
    gmail.head += 7;
    await maintain(mailAt(10));
    expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
    expect(gmail.fetched).toEqual(['in1', 'out1']);
  });

  it('履歴が複数ページでも全部読む。同じメッセージが履歴に何度出ても 1 回しか取らない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    for (let i = 0; i < 5; i++) gmail.deliver(gmailMessage({ from: from(`x${i}`), at: mailAt(i + 1), subject: `件 ${i}`, id: `m${i}` }));
    gmail.deliver(gmail.messages.get('m0')!);
    await maintain(mailAt(10));
    expect(gmail.calls.filter((c) => c.startsWith('history'))).toHaveLength(3);
    expect(gmail.calls.filter((c) => c.startsWith('history')).at(-1)).toMatch(/ h:4$/);
    expect(gmail.fetched).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(await signals()).toHaveLength(5);
    expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
  });

  it('取り込まないもの: ラベル（下書き・迷惑メール・ゴミ箱・チャット）は履歴の時点で取りにも行かない。取ってから分かったもの・消えたもの（404）・読めない形は飛ばす', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'draft', labels: ['DRAFT'] }));
    gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(1), id: 'spam', labels: ['SPAM'] }));
    gmail.deliver(gmailMessage({ from: from('c'), at: mailAt(1), id: 'chat', labels: ['CHAT'] }));
    gmail.deliver(gmailMessage({ from: from('d'), at: mailAt(1), id: 'gone', subject: '消えた' }));
    gmail.vanished.add('gone');
    // 取ったときにはゴミ箱に入っていた（履歴の時点ではまだ受信トレイ）
    gmail.deliver(gmailMessage({ from: from('e'), at: mailAt(1), id: 'late' }));
    gmail.messages.get('late')!.labelIds = ['TRASH'];
    gmail.deliver({ id: 'weird', payload: 'これは message ではない' });
    gmail.deliver(gmailMessage({ from: from('f'), at: mailAt(2), id: 'ok', subject: '取り込む' }));
    await maintain(mailAt(5));
    expect(gmail.fetched).toEqual(['gone', 'late', 'weird', 'ok']);
    expect((await threads()).map((t) => t.title)).toEqual(['取り込む']);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_message_unreadable', id: 'weird' }));
    // 位置は進む（飛ばしたものを何度も取りに行かない）
    expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
  });

  it('1 回の上限（50 通）を超えたら、処理し終えた履歴のレコードの id で止まり、次の見回りが続きから読む（飛ばさない）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    gmail.historyPageSize = 500;
    const first = gmail.head + 1;
    for (let i = 0; i < MAX_FETCH_PER_RUN + 5; i++) gmail.deliver(gmailMessage({ from: from(`s${i}`), at: mailAt(1, i % 60), id: `n${i}` }));
    await maintain(mailAt(5));
    expect(await signals()).toHaveLength(MAX_FETCH_PER_RUN);
    expect(await cursor()).toEqual({ historyId: String(first + MAX_FETCH_PER_RUN - 1), recovery: null });
    // 打ち切ったので、読み終えた時刻は進めない（拾い直しの起点を新しくしない）
    expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(T0);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_sync_paged_out' }));
    await maintain(mailAt(10));
    expect(await signals()).toHaveLength(MAX_FETCH_PER_RUN + 5);
    expect(gmail.fetched.slice(MAX_FETCH_PER_RUN)).toEqual(Array.from({ length: 5 }, (_, i) => `n${MAX_FETCH_PER_RUN + i}`));
    expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
    expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(mailAt(10));
  }, 120_000);

  it('履歴が startHistoryId を含めて返しても（inclusive）、同じメールで止まり続けない', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    gmail.inclusive = true;
    gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'a1' }));
    await maintain(mailAt(5));
    gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(6), id: 'b1' }));
    await maintain(mailAt(10));
    expect(await signals()).toHaveLength(2);
    expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
  });

  it('H5 記録した送信（Message-ID）があとで履歴に現れても 1 本のまま', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    await ctx.service.recordSent('u_bob', {
      dataSourceId: ctx.ds.id,
      to: [from('carol')],
      toContactIds: [],
      subject: 'ご案内',
      body: 'ご案内です',
      sentRef: '<sent1@gws.example>',
      anchors: {},
    });
    gmail.deliver(gmailMessage({ from: 'bob@gws.example', to: from('carol'), at: mailAt(1), subject: 'ご案内', mid: '<sent1@gws.example>', labels: ['SENT'] }));
    await maintain(mailAt(5));
    const ts = await threads();
    expect(ts).toHaveLength(1);
    expect(ts[0]!.signalIds).toHaveLength(1);
  });

  describe('位置が切れたとき（startHistoryId が古すぎて 404）', () => {
    it('profile.historyId を先に読み、最後に読めた時刻の 10 分前から検索して拾い直す。ほかの履歴にないメールも取り、取り込み済みは二重にならない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'seen', subject: '取り込み済み', mid: '<seen@example.com>' }));
      await maintain(mailAt(5));
      expect(await signals()).toHaveLength(1);
      // 履歴が切れ、そのあいだに届いたメールは履歴に残らない。取り込み済みのメールは検索の重なりに入る
      gmail.expireHistory();
      gmail.place(gmailMessage({ from: from('b'), at: mailAt(20), id: 'gap1', subject: '切れている間 1', mid: '<gap1@example.com>' }));
      gmail.place(gmailMessage({ from: from('c'), at: mailAt(21), id: 'gap2', subject: '切れている間 2', mid: '<gap2@example.com>' }));
      gmail.place(gmailMessage({ from: from('old'), at: mailAt(-120), id: 'ancient', subject: '範囲より前' }));
      gmail.calls.length = 0;
      await maintain(mailAt(30));
      const after = Math.floor(Date.parse(mailAt(5)) / 1000) - 600;
      expect(gmail.calls[0]).toMatch(/^history /);
      expect(gmail.calls[1]).toBe('profile');
      expect(gmail.calls[2]).toBe(`list ${after}`);
      // 検索の重なりで取り込み済みのメールも取るが、signal は二重にならない
      expect(gmail.fetched.sort()).toEqual(['gap1', 'gap2', 'seen']);
      expect((await signals()).map((s) => s.sourceRef).sort()).toEqual(['email:<gap1@example.com>', 'email:<gap2@example.com>', 'email:<seen@example.com>']);
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: mailAt(30) });
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_history_expired' }));
      // 新しい位置から続く
      gmail.deliver(gmailMessage({ from: from('d'), at: mailAt(31), id: 'next', subject: 'そのあと' }));
      await maintain(mailAt(35));
      expect(await signals()).toHaveLength(4);
    });

    it('取り込み済みのメールを重ねて取り込んでも signal は増えない（sourceRef の重複排除）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const m = gmailMessage({ from: from('a'), at: mailAt(1), id: 'dup', mid: '<dup@example.com>' });
      const n = normalizeGmailMessage(ctx.ds.id, GmailMessage.parse(m));
      if (n.kind !== 'signal') throw new Error('skipped');
      const first = await ctx.service.ingestItem(n.signal);
      const second = await ctx.service.ingestItem(n.signal);
      expect(second).toMatchObject({ status: 'duplicate', signalId: (first as { signalId: string }).signalId });
      expect(first).not.toMatchObject({ status: 'duplicate' });
      expect(await signals()).toHaveLength(1);
    });

    it('拾い直しが 1 回で終わらなければ、検索の ID と位置を残して次の見回りが続ける。ID を全部集めてから、古い方から取り込む。読み切るまで位置は進めない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const oldCursor = (await cursor())!.historyId;
      gmail.expireHistory();
      for (let i = 0; i < 6; i++) gmail.place(gmailMessage({ from: from(`r${i}`), at: mailAt(10 + i), id: `r${i}`, subject: `件 ${i}` }));
      await maintain(mailAt(30));
      // 1 回に 2 ページ（4 通）集めただけで、まだ取り込まない（新しい順に取り込むと、スレッドの順が逆になる）
      expect(gmail.fetched).toEqual([]);
      expect(await cursor()).toMatchObject({ historyId: oldCursor, recovery: { nextHistoryId: String(gmail.head), pageToken: 'l:4', listed: false, ids: ['r5', 'r4', 'r3', 'r2'] } });
      expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(T0);
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_recovery_paged_out' }));
      // 次の見回りは history を呼ばずに続きを集め、集め終えたので古い方から取り込む
      gmail.calls.length = 0;
      await maintain(mailAt(35));
      expect(gmail.calls.some((c) => c.startsWith('history') || c === 'profile')).toBe(false);
      expect(gmail.fetched).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
      expect(await signals()).toHaveLength(6);
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
    });

    it('1 回の取り込みの上限より多くても、古い方から（検索は新しい順）。回をまたいでも順は時系列で、同じスレッドの順が逆にならない。位置は全部終えるまで進めない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const oldCursor = (await cursor())!.historyId;
      gmail.listPageSize = 100;
      const total = MAX_FETCH_PER_RUN + 12;
      gmail.expireHistory();
      for (let i = 0; i < total; i++) {
        gmail.place(gmailMessage({ from: from(`c${i % 3}`), at: mailAt(10, i), id: `x${i}`, subject: '連絡', mid: `<x${i}@example.com>`, ...(i > 0 ? { inReplyTo: `<x${i - 1}@example.com>` } : {}) }));
      }
      await maintain(mailAt(30));
      const oldestFirst = Array.from({ length: total }, (_, i) => `x${i}`);
      expect(gmail.fetched).toEqual(oldestFirst.slice(0, MAX_FETCH_PER_RUN));
      expect(await cursor()).toMatchObject({ historyId: oldCursor, recovery: { listed: true, ids: oldestFirst.slice(MAX_FETCH_PER_RUN).reverse() } });
      await maintain(mailAt(35));
      expect(gmail.fetched).toEqual(oldestFirst);
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
      // スレッドの順（取り込んだ順）が時系列
      const [thread] = await threads();
      expect(await threads()).toHaveLength(1);
      const p = await ctx.service.state();
      expect(thread!.signalIds.map((id) => p.signals[id]!.sourceRef)).toEqual(oldestFirst.map((id) => `email:<${id}@example.com>`));
    }, 60_000);

    it('取り込みの途中で失敗しても、次は取り込み済みの ID をやり直さず、失敗した ID から続ける', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.listPageSize = 100;
      gmail.expireHistory();
      for (let i = 0; i < 5; i++) gmail.place(gmailMessage({ from: from(`m${i}`), at: mailAt(10 + i), id: `m${i}`, subject: `件 ${i}` }));
      gmail.failNext = { fn: 'message m2', error: new GmailError(503, 'UNAVAILABLE') };
      await maintain(mailAt(30));
      expect(gmail.fetched).toEqual(['m0', 'm1', 'm2']);
      // 取り込んだ m0・m1 は外れ、m2 から残る（位置はまだ進まない）
      expect(await cursor()).toMatchObject({ recovery: { listed: true, ids: ['m4', 'm3', 'm2'] } });
      expect((await cursor())!.blocked ?? null).toBeNull();
      await maintain(mailAt(35));
      expect(gmail.fetched).toEqual(['m0', 'm1', 'm2', 'm2', 'm3', 'm4']);
      expect(await signals()).toHaveLength(5);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head), recovery: null });
      expect((await cursor())!.blocked ?? null).toBeNull();
    });

    it('集める ID が上限（MAX_RECOVERY_IDS）を超えたら、新しい方だけにして読み終える（古い方は諦め、記録に残す）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.listPageSize = 1500;
      gmail.expireHistory();
      for (let i = 0; i < 2100; i++) gmail.place(gmailMessage({ from: from(`t${i}`), at: mailAt(10, 0), id: `t${i}`, subject: `件` }));
      // 同時刻の並びは安定しないので、一覧の順（新しい順）をそのまま使うよう、日時を 1 通ずつずらす
      for (let i = 0; i < 2100; i++) gmail.messages.get(`t${i}`)!.internalDate = String(Date.parse(mailAt(10)) + i * 1000);
      await maintain(mailAt(30));
      const rec = (await cursor())!.recovery!;
      expect(rec.listed).toBe(true);
      // 集めたのは新しい 2000 通（t2099 から t100）。同じ見回りで古い方の 50 通（t100〜t149）を取り込み済み
      expect(rec.ids).toHaveLength(2000 - MAX_FETCH_PER_RUN);
      expect(rec.ids![0]).toBe('t2099');
      expect(rec.ids!.at(-1)).toBe('t150');
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_recovery_truncated', kept: 2000 }));
      // 取り込みは古い方（t100）から
      expect(gmail.fetched[0]).toBe('t100');
    }, 60_000);

    it('残した検索の位置が使えなくなったら（400）、集めた ID を捨てて最初から読み直す。起点と新しい位置はそのまま。上限・5xx では読み直さない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.expireHistory();
      for (let i = 0; i < 6; i++) gmail.place(gmailMessage({ from: from(`s${i}`), at: mailAt(10 + i), id: `s${i}`, subject: `件 ${i}` }));
      await maintain(mailAt(30));
      const first = (await cursor())!.recovery!;
      expect(first).toMatchObject({ pageToken: 'l:4', ids: ['s5', 's4', 's3', 's2'] });
      // 上限・5xx は読み直さない（残した位置のまま）
      gmail.failNext = { fn: 'list', error: new GmailError(429, 'RESOURCE_EXHAUSTED') };
      await maintain(mailAt(32));
      gmail.failNext = { fn: 'list', error: new GmailError(500, 'INTERNAL') };
      await maintain(mailAt(33));
      expect((await cursor())!.recovery).toEqual(first);
      expect(logs.some((l) => l.msg === 'gmail_recovery_restarted')).toBe(false);
      // 位置が古くなった: 最初から読み直す
      gmail.failNext = { fn: 'list', error: new GmailError(400, 'INVALID_ARGUMENT') };
      gmail.calls.length = 0;
      await maintain(mailAt(35));
      expect(gmail.calls.filter((c) => c.startsWith('list'))).toEqual([`list ${first.after} l:4`, `list ${first.after}`, `list ${first.after} l:2`]);
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_recovery_restarted', status: 400 }));
      expect((await cursor())!.recovery).toMatchObject({ nextHistoryId: first.nextHistoryId, after: first.after, listed: false, pageToken: 'l:4', ids: ['s5', 's4', 's3', 's2'] });
      await maintain(mailAt(40));
      expect(await signals()).toHaveLength(6);
      expect(gmail.fetched).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
    });

    it('拾い直しを終えたときの lastSyncAt は、拾い直しを始めた時刻（profile.historyId を読んだとき）。終えた時刻にしない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.expireHistory();
      for (let i = 0; i < 6; i++) gmail.place(gmailMessage({ from: from(`l${i}`), at: mailAt(10 + i), id: `l${i}` }));
      await maintain(mailAt(30));
      expect((await cursor())!.recovery).toMatchObject({ startedAt: mailAt(30) });
      await maintain(mailAt(40));
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
      expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(mailAt(30));
      // 2 回目の期限切れの検索の起点も、そこから（10 分前）
      gmail.expireHistory();
      gmail.calls.length = 0;
      await maintain(mailAt(60));
      expect(gmail.calls).toContain(`list ${Math.floor(Date.parse(mailAt(30)) / 1000) - 600}`);
    });

    it('拾い直しの途中で失敗しても、同じ起点・同じ新しい位置で続ける（位置は先に残す）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.expireHistory();
      gmail.place(gmailMessage({ from: from('a'), at: mailAt(10), id: 'p1' }));
      const headAtStart = gmail.head;
      gmail.failNext = { fn: 'list', error: new GmailError(500, 'INTERNAL') };
      await expect(ctx.sync.handle({ kind: 'maintain' })).resolves.toBeUndefined();
      expect(await cursor()).toMatchObject({ recovery: { nextHistoryId: String(headAtStart), pageToken: null } });
      // 失敗のあいだに届いたメール（p2）は、続きの検索にも、新しい位置からの履歴にも現れるが、1 通になる
      gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(12), id: 'p2' }));
      await maintain(mailAt(10));
      expect(await cursor()).toEqual({ historyId: String(headAtStart), recovery: null });
      expect(await signals()).toHaveLength(2);
      await maintain(mailAt(15));
      expect(await signals()).toHaveLength(2);
      expect(gmail.fetched.filter((id) => id === 'p2')).toHaveLength(2);
      expect(await cursor()).toEqual({ historyId: String(gmail.head), recovery: null });
    });
  });

  describe('失敗', () => {
    it('上限（429・クォータの 403）は broken にしない。位置は進まず、次の見回りで取れる', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'q1' }));
      const before = await state.source(ctx.ds.id);
      gmail.failNext = { fn: 'history', error: new GmailError(429, 'RESOURCE_EXHAUSTED') };
      await maintain(mailAt(5));
      expect(await state.source(ctx.ds.id)).toEqual(before);
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_maintain_failed' }));
      // メッセージの取得で上限に当たっても同じ
      gmail.failNext = { fn: 'message', error: new GmailError(429, 'RESOURCE_EXHAUSTED') };
      await maintain(mailAt(10));
      // 位置は進まない。上限は失敗として数えない（回数も残さない）
      expect(await state.source(ctx.ds.id)).toEqual(before);
      await maintain(mailAt(15));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', reason: null });
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
      expect((await cursor())!.blocked ?? null).toBeNull();
      expect(await signals()).toHaveLength(1);
    });

    it('同意の問題なら broken にして止まり、1 時間後の見回りで試し直して戻る。止まっている間のメールも位置が残っているので取れる', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const kept = await cursor();
      gmail.authBroken = true;
      await maintain(mailAt(5));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken', reason: 'credential must be reconnected', gmail: kept });
      gmail.authBroken = false;
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(10), id: 'during', subject: '止まっている間' }));
      await maintain(mailAt(30));
      expect((await state.source(ctx.ds.id))!.status).toBe('broken');
      await maintain(mailAt(66));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', reason: null });
      expect((await threads()).map((t) => t.title)).toEqual(['止まっている間']);
    });

    it('Gmail API がゲートウェイのプロジェクトで有効でないときは broken にして理由を残す（同意の問題と書かない）。1 時間おきにしか試さない。位置は残る', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const kept = await cursor();
      gmail.failNext = { fn: 'history', error: new GoogleApiNotEnabled('Gmail API') };
      await maintain(mailAt(5));
      const s = (await state.source(ctx.ds.id))!;
      expect(s).toMatchObject({ status: 'broken', lastRetryAt: mailAt(5), gmail: kept });
      expect(s.reason).toMatch(/Gmail API がゲートウェイの Google Cloud プロジェクトで有効になっていない/);
      expect(s.reason).not.toMatch(/同意/);
      const calls = gmail.calls.length;
      await maintain(mailAt(30));
      expect(gmail.calls.length).toBe(calls);
      await maintain(mailAt(66));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', reason: null });
    });

    it('読んでいる間に外されたら外したままにする（位置・状態を書き戻さない）。つなぎ直されたら、つなぎ直した状態を上書きしない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      const before = (await cursor())!;
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'd1' }), gmailMessage({ from: from('b'), at: mailAt(2), id: 'd2' }));
      gmail.beforeCall = async (fn) => {
        if (fn === 'message') await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected', reason: '本人が外した' });
      };
      await maintain(mailAt(5));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'disconnected', reason: '本人が外した', gmail: before });
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_sync_superseded' }));

      // 別の接続につなぎ直された（状態は setup、位置は新しい接続のもの）
      const reconnected = { ...(await state.source(ctx.ds.id))!, status: 'setup' as const, reason: null, gatewayCredentialId: 'gw_new', gmail: { historyId: null, recovery: null } };
      await state.putSource({ ...reconnected, status: 'ok', gatewayCredentialId: 'gw_bob', gmail: before });
      gmail.beforeCall = async (fn) => {
        if (fn === 'message') await state.putSource(reconnected);
      };
      await maintain(mailAt(10));
      expect(await state.source(ctx.ds.id)).toEqual(reconnected);
    });

    it('同意の問題でない失敗は、次の見回りが試し直す（setup の仕事は投げてキューに試し直させる）', async () => {
      gmail.failNext = { fn: 'profile', error: new Error('boom') };
      await expect(ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id })).rejects.toThrow('boom');
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'setup', gmail: { historyId: null } });
      await maintain(mailAt(5));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', gmail: { historyId: String(gmail.head) } });
    });

    it('外したら何もしない（見回りも setup も上流を呼ばない。上流に消すものはない）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      await state.putSource({ ...(await state.source(ctx.ds.id))!, status: 'disconnected', folders: {} });
      const calls = gmail.calls.length;
      await ctx.sync.handle({ kind: 'disconnect', dataSourceId: ctx.ds.id });
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      await maintain(mailAt(5));
      expect(gmail.calls.length).toBe(calls);
    });
  });

  describe('途中の保存と、1 通で止まらないこと', () => {
    it('取り込みの途中でも、履歴のレコードの切れ目で SAVE_EVERY 通ごとに位置を書く。失敗しても、書いたところまでは取り込み直さない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.historyPageSize = 500;
      const first = gmail.head + 1;
      for (let i = 0; i < 25; i++) gmail.deliver(gmailMessage({ from: from(`p${i}`), at: mailAt(1, i), id: `p${i}`, subject: `件 ${i}` }));
      gmail.failNext = { fn: 'message p12', error: new GmailError(503, 'UNAVAILABLE') };
      await maintain(mailAt(5));
      expect(gmail.fetched).toHaveLength(13);
      expect(await signals()).toHaveLength(12);
      // p0〜p9 のレコードまで書いてある（p10 以降のレコードは飛ばしていない）
      expect(SAVE_EVERY).toBe(10);
      expect((await cursor())!.historyId).toBe(String(first + 9));
      expect((await state.source(ctx.ds.id))!.lastSyncAt).toBe(T0);
      gmail.calls.length = 0;
      await maintain(mailAt(10));
      expect(gmail.fetched).toEqual(Array.from({ length: 15 }, (_, i) => `p${10 + i}`));
      expect(await signals()).toHaveLength(25);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
      expect((await cursor())!.blocked ?? null).toBeNull();
    });

    it('履歴のレコードの途中までは進めない（1 つのレコードに SAVE_EVERY 通以上あっても、レコードの終わりでだけ書く）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.historyPageSize = 500;
      const before = (await cursor())!.historyId;
      gmail.deliver(...Array.from({ length: 15 }, (_, i) => gmailMessage({ from: from(`b${i}`), at: mailAt(1, i), id: `b${i}` })));
      gmail.failNext = { fn: 'message b13', error: new GmailError(503, 'UNAVAILABLE') };
      await maintain(mailAt(5));
      expect(await signals()).toHaveLength(13);
      expect((await cursor())!.historyId).toBe(before);
      await maintain(mailAt(10));
      expect(await signals()).toHaveLength(15);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
    });

    it('取り込めない 1 通（4xx など、やり直しても直らない失敗）は ID だけ記録して飛ばし、あとのメールを取り込んで位置を進める', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'good1', subject: '前' }));
      gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(2), id: 'bad', subject: '壊れた' }));
      gmail.deliver(gmailMessage({ from: from('c'), at: mailAt(3), id: 'good2', subject: '後' }));
      gmail.failNext = { fn: 'message bad', error: new GmailError(400, 'FAILED_PRECONDITION') };
      await maintain(mailAt(5));
      expect((await threads()).map((t) => t.title).sort()).toEqual(['前', '後']);
      expect(logs).toContainEqual({ msg: 'gmail_message_skipped', dataSourceId: ctx.ds.id, id: 'bad', permanent: true, count: 1 });
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok', lastSyncAt: mailAt(5) });
      // 取り込みを本体が断った（DomainError）も同じ
      gmail.deliver(gmailMessage({ from: from('d'), at: mailAt(6), id: 'rejected' }), gmailMessage({ from: from('e'), at: mailAt(7), id: 'good3', subject: '次' }));
      const ingest = ctx.service.ingestItem.bind(ctx.service);
      ctx.service.ingestItem = async (item) => {
        if (item.sourceRef.includes('rejected')) throw new DomainError('invalid', 'rejected');
        return ingest(item);
      };
      await maintain(mailAt(10));
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_message_skipped', id: 'rejected', permanent: true }));
      expect((await threads()).map((t) => t.title).sort()).toEqual(['前', '後', '次']);
    });

    it('種類の分からない失敗は、同じ ID が見回りごとに 2 回続けて失敗するまでは run を止めて試し直す。3 回目の失敗で飛ばす。取れれば回数は消える', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'ok1', subject: '前' }));
      gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(2), id: 'flaky', subject: '不安定' }));
      gmail.deliver(gmailMessage({ from: from('c'), at: mailAt(3), id: 'ok2', subject: '後' }));
      let failing = true;
      gmail.beforeCall = (fn) => {
        if (failing && fn === 'message' && gmail.calls.at(-1) === 'message flaky') throw new Error('boom');
      };
      const before = (await cursor())!.historyId;
      await maintain(mailAt(5));
      expect(await cursor()).toMatchObject({ historyId: before, blocked: { id: 'flaky', count: 1, at: mailAt(5) } });
      expect((await threads()).map((t) => t.title)).toEqual(['前']);
      await maintain(mailAt(10));
      expect(await cursor()).toMatchObject({ historyId: before, blocked: { id: 'flaky', count: 2 } });
      expect((await threads()).map((t) => t.title)).toEqual(['前']);
      expect(logs.some((l) => l.msg === 'gmail_message_skipped')).toBe(false);
      // 3 回目: 飛ばして先へ（ID だけ記録）。回数は消え、位置は進む
      await maintain(mailAt(15));
      expect(logs).toContainEqual({ msg: 'gmail_message_skipped', dataSourceId: ctx.ds.id, id: 'flaky', permanent: false, count: 3 });
      expect((await threads()).map((t) => t.title).sort()).toEqual(['前', '後']);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head), blocked: null });
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'ok' });

      // 2 回失敗してから取れれば、回数は消える
      gmail.deliver(gmailMessage({ from: from('d'), at: mailAt(20), id: 'late', subject: '遅れ' }));
      gmail.beforeCall = (fn) => {
        if (failing && fn === 'message' && gmail.calls.at(-1) === 'message late') throw new Error('boom');
      };
      await maintain(mailAt(21));
      await maintain(mailAt(26));
      expect(await cursor()).toMatchObject({ blocked: { id: 'late', count: 2 } });
      failing = false;
      await maintain(mailAt(31));
      expect((await threads()).map((t) => t.title)).toContain('遅れ');
      expect(await cursor()).toMatchObject({ blocked: null });
    });

    it('別の ID が失敗しても、止まっているメッセージの回数は引き継がない。成功した別のメッセージが回数を消さない（3 回に届く）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'pre', subject: '前' }));
      gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(2), id: 'flaky', subject: '不安定' }));
      gmail.beforeCall = (fn) => {
        if (fn === 'message' && gmail.calls.at(-1) === 'message flaky') throw new Error('boom');
      };
      // pre は毎回取り込み直し（位置がレコードの切れ目まで進まないため）、そのたびに成功する。回数は 3 まで届く
      await maintain(mailAt(5));
      await maintain(mailAt(10));
      expect(await cursor()).toMatchObject({ blocked: { id: 'flaky', count: 2 } });
      await maintain(mailAt(15));
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_message_skipped', id: 'flaky' }));
    });

    describe('D1 一時的な失敗は、どれだけ続いても何も失わない（数えない）', () => {
      let llmError: Error | null;
      beforeEach(async () => {
        llmError = null;
        // LLM が落ちる世界を、setup で作った service の判断者に重ねる
        const decider = ctx.decider as unknown as { answer: (req: unknown) => unknown };
        const inner = decider.answer;
        decider.answer = (req) => {
          if (llmError) throw llmError;
          return inner(req);
        };
      });

      it('LLM の障害が 5 回の見回りにまたがっても、何も失わず、回復したら取り込む', async () => {
        await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
        gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'm1', subject: '一通目' }));
        gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(2), id: 'm2', subject: '二通目' }));
        const before = (await cursor())!.historyId;
        llmError = new LlmApiError(529, 'overloaded_error', 'Overloaded');
        for (let i = 1; i <= 5; i++) await maintain(mailAt(5 * i));
        expect(await signals()).toHaveLength(0);
        expect(await cursor()).toMatchObject({ historyId: before });
        expect((await cursor())!.blocked ?? null).toBeNull();
        expect(logs.some((l) => l.msg === 'gmail_message_skipped')).toBe(false);
        // 残高切れ（400）も同じ
        llmError = new LlmApiError(400, 'invalid_request_error', 'credit balance is too low');
        for (let i = 6; i <= 8; i++) await maintain(mailAt(5 * i));
        expect(await signals()).toHaveLength(0);
        llmError = null;
        await maintain(mailAt(45));
        expect((await threads()).map((t) => t.title).sort()).toEqual(['一通目', '二通目']);
        expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
      });

      it('ゲートウェイの 502 が 5 回の見回りにまたがっても、何も失わない', async () => {
        await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
        gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'g1', subject: '件' }));
        gmail.beforeCall = (fn) => {
          if (gmailDown && fn === 'message') throw new GatewayError('could not refresh the upstream access token', 502);
        };
        let gmailDown = true;
        for (let i = 1; i <= 5; i++) await maintain(mailAt(5 * i));
        expect(await signals()).toHaveLength(0);
        expect(logs.some((l) => l.msg === 'gmail_message_skipped')).toBe(false);
        gmailDown = false;
        await maintain(mailAt(30));
        expect((await threads()).map((t) => t.title)).toEqual(['件']);
      });

      it('Gmail の 5xx・429 も、5 回の見回りで失わない', async () => {
        await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
        gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'r1', subject: '件' }));
        let n = 0;
        gmail.beforeCall = (fn) => {
          if (n++ < 10 && fn === 'message') throw new GmailError(n % 2 ? 503 : 429, 'X');
        };
        for (let i = 1; i <= 5; i++) await maintain(mailAt(5 * i));
        expect(await signals()).toHaveLength(0);
        await maintain(mailAt(30));
        expect(await signals()).toHaveLength(1);
      });

      it('キューが再試行する setup が数秒のうちに 3 回失敗しても飛ばさない（回数は見回り 1 回に 1 つ）', async () => {
        await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
        gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'q1', subject: '件' }));
        gmail.expireHistory();
        gmail.beforeCall = (fn) => {
          if (fn === 'message') throw new Error('boom');
        };
        // 位置が残っている setup は poll を回す（キューが数秒おきに再試行する）
        for (let i = 0; i < 4; i++) {
          ctx.clock.set(mailAt(5, i * 5));
          await expect(ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id })).rejects.toThrow('boom');
        }
        expect(logs.some((l) => l.msg === 'gmail_message_skipped')).toBe(false);
        expect(await cursor()).toMatchObject({ blocked: { id: 'q1', count: 1 } });
      });
    });

    it('本当に毒のある 1 通（種類の分からない失敗が毎回）は 3 回目の見回りで飛ばし、あとのメールは流れる', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'poison', subject: '毒' }));
      gmail.beforeCall = (fn) => {
        if (fn === 'message' && gmail.calls.at(-1) === 'message poison') throw new Error('weird');
      };
      await maintain(mailAt(5));
      await maintain(mailAt(10));
      expect(logs.some((l) => l.msg === 'gmail_message_skipped')).toBe(false);
      gmail.deliver(gmailMessage({ from: from('b'), at: mailAt(11), id: 'after', subject: '後続' }));
      await maintain(mailAt(15));
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'gmail_message_skipped', id: 'poison', count: 3 }));
      expect((await threads()).map((t) => t.title)).toEqual(['後続']);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head), blocked: null });
    });

    it('同意の問題は飛ばさずに broken（メッセージの失敗として数えない）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'auth1' }));
      gmail.failNext = { fn: 'message', error: new GatewayAuthError('credential must be reconnected') };
      await maintain(mailAt(5));
      expect(await state.source(ctx.ds.id)).toMatchObject({ status: 'broken' });
      expect((await cursor())!.blocked ?? null).toBeNull();
    });
  });

  describe('取り込むのは受信トレイか送信済みのメールだけ', () => {
    it('フィルタでアーカイブされたメール（どちらのラベルにも INBOX がない）は飛ばし、送信済みと、カテゴリのラベルがついた受信トレイのメールは取る', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('a'), at: mailAt(1), id: 'archived', subject: 'アーカイブ', labels: ['CATEGORY_UPDATES'] }));
      gmail.deliver(gmailMessage({ from: 'bob@gws.example', to: from('c'), at: mailAt(2), id: 'sent', subject: '送信', labels: ['SENT'] }));
      gmail.deliver(gmailMessage({ from: from('d'), at: mailAt(3), id: 'cat', subject: 'カテゴリ', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
      await maintain(mailAt(5));
      expect(gmail.fetched).toEqual(['archived', 'sent', 'cat']);
      expect((await threads()).map((t) => t.title).sort()).toEqual(['カテゴリ', '送信']);
      expect(await cursor()).toMatchObject({ historyId: String(gmail.head) });
    });

    it('D3 届いてから取るまでのあいだにアーカイブされたメール（履歴は INBOX、取ったときは INBOX がない）と、送信してアーカイブしたメール（履歴は SENT、取ったときは何もない）は取り込む。返信だけが残らない', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('e'), at: mailAt(1), id: 'moved', subject: '見積', mid: '<moved@example.com>' }));
      gmail.messages.get('moved')!.labelIds = ['CATEGORY_SOCIAL'];
      gmail.deliver(gmailMessage({ from: 'bob@gws.example', to: from('e'), at: mailAt(2), id: 'sa', subject: 'Re: 見積', mid: '<sa@gws.example>', inReplyTo: '<moved@example.com>', labels: ['SENT'] }));
      gmail.messages.get('sa')!.labelIds = [];
      await maintain(mailAt(5));
      expect(await threads()).toHaveLength(1);
      expect(await signals()).toHaveLength(2);
    });

    it('D3 ゴミ箱・迷惑メールに移されたものは、履歴が INBOX でも取り込まない（除外は取ったときのラベルで決める）', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.deliver(gmailMessage({ from: from('e'), at: mailAt(1), id: 'late' }));
      gmail.messages.get('late')!.labelIds = ['TRASH'];
      gmail.deliver(gmailMessage({ from: from('f'), at: mailAt(2), id: 'late2' }));
      gmail.messages.get('late2')!.labelIds = ['SPAM', 'INBOX'];
      await maintain(mailAt(5));
      expect(gmail.fetched).toEqual(['late', 'late2']);
      expect(await signals()).toHaveLength(0);
    });

    it('D3 拾い直し（履歴のラベルがない）は、取ったメールの今のラベルだけで決める', async () => {
      await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
      gmail.expireHistory();
      gmail.place(gmailMessage({ from: from('a'), at: mailAt(10), id: 'r_in', subject: '受信' }));
      gmail.place(gmailMessage({ from: from('b'), at: mailAt(11), id: 'r_arch', subject: 'アーカイブ済み', labels: [] }));
      await maintain(mailAt(30));
      expect((await threads()).map((t) => t.title)).toEqual(['受信']);
    });
  });

  it('見回りのマスタの読み込みは 1 回（ほかのコネクタと共有する directory を使う）', async () => {
    await ctx.sync.handle({ kind: 'setup', dataSourceId: ctx.ds.id });
    let loads = 0;
    await ctx.sync.handle({ kind: 'maintain' }, async () => {
      loads++;
      return ctx.service.directory();
    });
    expect(loads).toBe(1);
  });
});
