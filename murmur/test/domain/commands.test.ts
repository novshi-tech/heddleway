import { describe, expect, it } from 'vitest';
import {
  addNote,
  claimThread,
  dismissThread,
  DomainError,
  getThreadView,
  linkThreads,
  moveSignal,
  reopenThread,
  unlinkThreads,
} from '../../src/domain';
import { alice, answer, bob, dir, email, eve, EventLog, ingestPure, makeCtx, task, view } from '../helpers/world';

// スタンドの操作（片付け・開き直し・シグナルの移し替え・メモ・持ち主・リンク）。操作できるのはスレッドが見えている人だけ

function world() {
  const log = new EventLog();
  const ctx = makeCtx();
  const a = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
  const b = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<m1>' }, body: '別件で照明も' }), () =>
    answer({ thread: null }),
  );
  const mine = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'info@dave.example', to: ['alice@ubs.example'], sourceRef: 'r3' }), () => answer());
  return { log, ctx, threadId: a.outcome!.threadId, signalId: b.signalId!, privateThread: mine.outcome!.threadId };
}

describe('片付けと開き直し', () => {
  it('H3 読者だけが片付けられる。理由は必須で、片付け済みなら何もしない', () => {
    const { log, threadId, privateThread } = world();
    const p = log.state();
    expect(dismissThread(p, alice, dir, { threadId, reason: '対応不要' })).toHaveLength(1);
    expect(() => dismissThread(p, alice, dir, { threadId, reason: ' ' })).toThrow(/reason/);
    // Bob は support@ の読者なので片付けられるが、Alice の個人のメールボックスは見えない
    expect(dismissThread(p, bob, dir, { threadId, reason: 'x' })).toHaveLength(1);
    expect(() => dismissThread(p, bob, dir, { threadId: privateThread, reason: 'x' })).toThrow(DomainError);
    expect(() => dismissThread(p, eve, dir, { threadId, reason: 'x' })).toThrow(/not found/);

    log.push(dismissThread(p, alice, dir, { threadId, reason: '対応不要' }), '2026-10-16T10:00:00.000Z');
    expect(dismissThread(log.state(), alice, dir, { threadId, reason: '対応不要' })).toEqual([]);
    expect(reopenThread(log.state(), bob, dir, { threadId })).toHaveLength(1);
    expect(reopenThread(p, bob, dir, { threadId })).toEqual([]);
  });
});

describe('シグナルの移し替え', () => {
  it('H6 同じデータソースの新しいスレッドへ移す（追記で、元の判断は残る）', () => {
    const { log, ctx, threadId, signalId } = world();
    const { events, threadId: to } = moveSignal(log.state(), alice, ctx, {
      signalId,
      to: { kind: 'new', title: '照明の交換' },
      reason: '1 通に 2 つの話',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type === 'SignalThreaded' && events[0]!.payload).toMatchObject({
      by: 'human',
      actorUserId: 'u_alice',
      thread: { kind: 'new', title: '照明の交換' },
      needsResponse: null,
    });
    log.push(events, '2026-10-16T10:00:00.000Z');
    const p = log.state();
    expect(p.signals[signalId]!.threadId).toBe(to);
    expect(p.threads[threadId]!.signalIds).toHaveLength(1);
    expect(log.events.filter((e) => e.type === 'SignalThreaded')).toHaveLength(4);
  });

  it('H6 同じ置き先なら何もしない', () => {
    const { log, ctx, threadId, signalId } = world();
    expect(moveSignal(log.state(), alice, ctx, { signalId, to: { kind: 'existing', threadId }, reason: 'x' }).events).toEqual([]);
  });

  it('H3 データソースをまたいでは移せない。見えないシグナルは not_found', () => {
    const { log, ctx, signalId, privateThread } = world();
    expect(() => moveSignal(log.state(), alice, ctx, { signalId, to: { kind: 'existing', threadId: privateThread }, reason: 'x' })).toThrow(
      /different data source/,
    );
    expect(() => moveSignal(log.state(), eve, ctx, { signalId, to: { kind: 'new', title: 't' }, reason: 'x' })).toThrow(/not found/);
    expect(() => moveSignal(log.state(), alice, ctx, { signalId, to: { kind: 'new', title: ' ' }, reason: 'x' })).toThrow(/title/);
    expect(() => moveSignal(log.state(), alice, ctx, { signalId, to: { kind: 'new', title: 't' }, reason: '' })).toThrow(/reason/);
  });

  it('H6 観測された送信も移せる', () => {
    const { log, ctx } = world();
    const sent = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'o1', anchors: { inReplyTo: '<m1>' } }));
    const ok = moveSignal(log.state(), alice, ctx, { signalId: sent.signalId!, to: { kind: 'new', title: 't' }, reason: 'x' });
    expect(ok.events[0]!.type === 'SignalThreaded' && ok.events[0]!.payload.needsResponse).toBeNull();
  });
});

describe('メモ（add_note。0039 の決定 2）', () => {
  it('H3 個人リストのスレッド（タスク・本人の箱のメール）に書ける。共有リストのスレッドには書けない', () => {
    const { log, ctx, threadId: support, privateThread } = world();
    const t = task(log, ctx, 'Carol さんの雨漏り');
    const first = addNote(log.state(), alice, ctx, { threadId: t, body: '電話で状況を聞いた' });
    log.push(first.events, '2026-10-16T10:00:00.000Z');
    expect(first.events[0]!.type === 'ThreadNoted' && first.events[0]!.payload).toMatchObject({ noteId: first.noteId, threadId: t, author: { kind: 'user' }, actorUserId: 'u_alice' });
    expect(log.state().threads[t]).toMatchObject({ dataSourceId: 'ds_tasks_alice', signalIds: [], attention: { named: [], broadcasts: [] } });

    // 本人の箱のメールのスレッドにも直接書ける
    const onMail = addNote(log.state(), alice, ctx, { threadId: privateThread, body: '見積を頼む' });
    log.push(onMail.events, '2026-10-16T11:00:00.000Z');
    expect(log.state().threads[privateThread]!.log.filter((l) => l.kind === 'note').map((l) => l.body)).toEqual(['見積を頼む']);

    // 共有リスト（support@）のスレッドには書けない。他人の個人リストは見えない
    expect(() => addNote(log.state(), alice, ctx, { threadId: support, body: 'x' })).toThrow(/shared list/);
    expect(() => addNote(log.state(), bob, ctx, { threadId: t, body: 'x' })).toThrow(/not found/);
    expect(() => addNote(log.state(), alice, ctx, { threadId: t, body: ' ' })).toThrow(/body/);
  });

  it('H3 メモに書き手の印を付けられる。省略は本人。タイムラインに出るが、誰の番は変えない（0031 の 3・0032）', () => {
    const { log, ctx } = world();
    const t = task(log, ctx, 'PR のレビュー対応');
    const a = addNote(log.state(), alice, ctx, { threadId: t, body: '着手する' });
    log.push(a.events, '2026-10-16T10:00:00.000Z');
    const before = log.state().threads[t]!;
    const b = addNote(log.state(), alice, ctx, { threadId: t, body: '指摘 3 件を直した。次はテスト', author: { kind: 'agent', name: 'orchestrator' } });
    log.push(b.events, '2026-10-16T10:30:00.000Z');
    const p = log.state();
    expect(p.threads[t]).toMatchObject({ attention: before.attention, ownerUserId: before.ownerUserId });
    const timeline = getThreadView(dir, alice, p, t)!.timeline.filter((e) => e.kind === 'note');
    expect(timeline.map((e) => e.note)).toEqual([
      { noteId: a.noteId, body: '着手する', author: { kind: 'user' } },
      { noteId: b.noteId, body: '指摘 3 件を直した。次はテスト', author: { kind: 'agent', name: 'orchestrator' } },
    ]);
  });
});

describe('担当する（claim_thread）', () => {
  it('H4 読者が担当する・引き継ぐ・手放す。読者でない人には担当させられない。同じ担当なら何もしない。個人リストでは断る', () => {
    const { log, threadId, privateThread } = world();
    const claim = claimThread(log.state(), alice, dir, { threadId, userId: 'u_alice', reason: '持つ' });
    expect(claim).toHaveLength(1);
    log.push(claim, '2026-10-16T10:00:00.000Z');
    expect(view(log.state(), threadId).assignee).toEqual({ by: 'claim', userIds: ['u_alice'], contactIds: [], addresses: [] });
    expect(claimThread(log.state(), alice, dir, { threadId, userId: 'u_alice' })).toEqual([]);
    expect(claimThread(log.state(), alice, dir, { threadId, userId: 'u_bob' })).toHaveLength(1);
    expect(claimThread(log.state(), bob, dir, { threadId, userId: null })).toHaveLength(1);
    expect(() => claimThread(log.state(), alice, dir, { threadId, userId: 'u_eve' })).toThrow(/not a reader/);
    expect(() => claimThread(log.state(), alice, dir, { threadId: privateThread, userId: 'u_alice' })).toThrow(/personal list/);
    expect(() => claimThread(log.state(), bob, dir, { threadId: privateThread, userId: 'u_bob' })).toThrow(/not found/);
  });

  it('H2 タスクのスレッドは担当を持たない（担当はソースの写し）。片付け・開き直しもソースで付ける', () => {
    const { log, ctx } = world();
    const t = task(log, ctx, 'メモ');
    expect(() => claimThread(log.state(), alice, dir, { threadId: t, userId: 'u_alice' })).toThrow(/mirrored/);
    expect(() => dismissThread(log.state(), alice, dir, { threadId: t, reason: '済んだ' })).toThrow(/at the source/);
    expect(() => reopenThread(log.state(), alice, dir, { threadId: t })).toThrow(/at the source/);
  });
});

describe('リンク（link_threads / unlink_threads）', () => {
  it('H3 両端が見えていれば結べる。自分自身・見えない先は不可。結び済みなら何もしない。外すのも両端が見える人だけ（0033）', () => {
    const { log, ctx, threadId, privateThread } = world();
    const n = { threadId: task(log, ctx, '件') };
    const link = linkThreads(log.state(), alice, { threadId: n.threadId, otherThreadId: threadId, reason: 'この件' });
    expect(link[0]!.type === 'ThreadLinked' && link[0]!.payload).toMatchObject({ a: n.threadId, b: threadId, op: 'link', route: 'manual' });
    log.push(link, '2026-10-16T10:01:00.000Z');
    expect(linkThreads(log.state(), alice, { threadId, otherThreadId: n.threadId })).toEqual([]);
    expect(() => linkThreads(log.state(), alice, { threadId, otherThreadId: threadId })).toThrow(/itself/);
    expect(() => linkThreads(log.state(), bob, { threadId, otherThreadId: privateThread })).toThrow(/not found/);

    // Bob には Alice のタスクが読めないので、辺も見えず外せない（結んでいないのと同じ。0033 の 3）
    expect(unlinkThreads(log.state(), bob, { threadId, otherThreadId: n.threadId })).toEqual([]);
    const off = unlinkThreads(log.state(), alice, { threadId, otherThreadId: n.threadId });
    expect(off[0]!.type === 'ThreadLinked' && off[0]!.payload).toMatchObject({ op: 'unlink', route: 'manual', actorUserId: 'u_alice' });
    log.push(off, '2026-10-16T10:02:00.000Z');
    expect(unlinkThreads(log.state(), alice, { threadId, otherThreadId: n.threadId })).toEqual([]);
  });

  it('H8 結び候補（アンカーの一致）から張ると経路は anchor', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    const a = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { jiraKeys: ['UBS-7'] } }), () => answer());
    const b = ingestPure(log, ctx, email({ from: 'info@dave.example', sourceRef: 'r2', anchors: { jiraKeys: ['UBS-7'] } }), () => answer({ thread: 'new' }));
    const link = linkThreads(log.state(), alice, { threadId: a.outcome!.threadId, otherThreadId: b.outcome!.threadId });
    expect(link[0]!.type === 'ThreadLinked' && link[0]!.payload.route).toBe('anchor');
  });
});
