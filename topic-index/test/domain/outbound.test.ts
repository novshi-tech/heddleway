import { describe, expect, it } from 'vitest';
import { acknowledgeAttention, commView, directionOf, getThreadView, listThreads, myTurnOf, planMirror, planOverdue, recordSent, type RecordSentInput } from '../../src/domain';
import { alice, answer, bob, dir, view, email, eve, EventLog, ingestPure, line, makeCtx, task } from '../helpers/world';

// 送信の記録（record_sent）・期限の見回り・観測された送信の統合（H4・H5）

const T = (h: number, m = 0) => `2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

function world() {
  const log = new EventLog();
  const ctx = makeCtx(T(9));
  const cust = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' }, subject: '雨漏り' }), () => answer({ title: '雨漏り' }));
  return { log, ctx, cust: cust.outcome!.threadId };
}

const sent = (over: Partial<RecordSentInput> = {}): RecordSentInput => ({
  dataSourceId: 'ds_support',
  to: ['carol@example.com'],
  toContactIds: [],
  body: 'ご連絡ありがとうございます。調査します。',
  sentRef: '<u1@ubs.example>',
  ...over,
});

function push(log: EventLog, ctx: ReturnType<typeof makeCtx>, at: string, r: { events: Parameters<EventLog['push']>[0] }) {
  ctx.setNow(at);
  log.push(r.events, at);
}

describe('record_sent', () => {
  it('H4 返事をしているスレッドに入れ、相手が名指しされる。acknowledge なら自分への名指しも外す。返事期待は相手の名指しを外せば消える', () => {
    const { log, ctx, cust } = world();
    ctx.setNow(T(9, 10));
    const r = recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust, replyExpectedBy: T(12), acknowledge: true }));
    expect(r.threadId).toBe(cust);
    expect(r.events.map((e) => e.type)).toEqual(['OutboundRecorded', 'SignalThreaded', 'AttentionAcknowledged']);
    push(log, ctx, T(9, 10), r);
    let t = view(log.state(), cust);
    expect(t).toMatchObject({ awaiting: true, replyExpectedBy: T(12), replyExpectedSignalId: r.signalId, overdue: false });
    expect(myTurnOf(dir, alice, log.state().threads[cust]!)).toEqual([]);
    expect(myTurnOf(dir, bob, log.state().threads[cust]!)).toEqual(['list']);
    expect(directionOf(dir, log.state().signals[r.signalId]!)).toBe('outbound');
    expect(log.state().signals[r.signalId]).toMatchObject({
      threadedBy: 'self',
      anchors: { messageId: '<u1@ubs.example>' },
      recorded: { actorUserId: 'u_alice', replyExpectedBy: T(12), sourceThreadId: null },
    });
    ctx.setNow(T(10));
    const reply = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<u1@ubs.example>' } }));
    expect(view(log.state(), cust)).toMatchObject({ awaiting: true, replyExpectedBy: T(12) });
    expect(myTurnOf(dir, alice, log.state().threads[cust]!)).toEqual(['list']);
    ctx.setNow(T(10, 5));
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: cust, untilSignalId: reply.signalId, addresses: [{ channel: 'email', value: 'carol@example.com' }] }), T(10, 5));
    t = view(log.state(), cust);
    expect(t).toMatchObject({ awaiting: false, replyExpectedBy: null, overdue: false });
  });

  it('H4 元のスレッドが別のデータソース（タスク）なら、新しいスレッドに入れて経路 sent で結ぶ', () => {
    const { log, ctx, cust } = world();
    ctx.setNow(T(9, 5));
    const note = { threadId: task(log, ctx, '雨漏りの件') };
    const r = recordSent(log.state(), alice, ctx, sent({ to: ['info@dave.example'], subject: '見積依頼', sentRef: '<u2@ubs.example>', sourceThreadId: note.threadId }));
    expect(r.events.map((e) => e.type)).toEqual(['OutboundRecorded', 'SignalThreaded', 'ThreadLinked']);
    push(log, ctx, T(9, 10), r);
    const p = log.state();
    expect(r.threadId).not.toBe(cust);
    expect(view(p, r.threadId)).toMatchObject({ title: '見積依頼', awaiting: true, links: [{ threadId: note.threadId, route: 'sent' }] });
    expect(view(p, r.threadId).attention.named).toMatchObject([{ contactId: 'p_dave', userId: null }]);
    expect(p.threads[note.threadId]!.links).toMatchObject([{ threadId: r.threadId, route: 'sent' }]);
    // 返事は送信元（support@）に戻り、送ったスレッドに入る
    ingestPure(log, ctx, email({ from: 'info@dave.example', sourceRef: 'r3', anchors: { inReplyTo: '<u2@ubs.example>' } }), () => answer({ thread: null }));
    expect(log.state().threads[r.threadId]!.signalIds).toHaveLength(2);
  });

  it('H4 同じデータソースの元のスレッド（返事ではない）なら、新しいスレッドに入れて結ぶ。アンカーがあればそのスレッド', () => {
    const { log, ctx, cust } = world();
    const r = recordSent(log.state(), alice, ctx, sent({ to: ['info@dave.example'], sentRef: '<u3@ubs.example>', sourceThreadId: cust }));
    push(log, ctx, T(9, 10), r);
    expect(log.state().threads[cust]!.links).toMatchObject([{ threadId: r.threadId, route: 'sent' }]);
    const viaAnchor = recordSent(log.state(), alice, ctx, sent({ sentRef: '<u4@ubs.example>', anchors: { inReplyTo: '<m1>' } }));
    expect(viaAnchor.threadId).toBe(cust);
  });

  it('H4 宛先は Contact でも渡せる。宛先なし・見えないデータソース・別データソースの reply_to は不可。同じ sent_ref は冪等', () => {
    const { log, ctx, cust } = world();
    const byContact = recordSent(log.state(), alice, ctx, sent({ to: [], toContactIds: ['p_dave'] }));
    expect(byContact.events[0]!.type === 'OutboundRecorded' && byContact.events[0]!.payload.to).toEqual([{ channel: 'email', value: 'info@dave.example' }]);
    expect(() => recordSent(log.state(), alice, ctx, sent({ to: [] }))).toThrow(/to/);
    expect(() => recordSent(log.state(), alice, ctx, sent({ toContactIds: ['p_eve'] }))).toThrow(/address/);
    expect(() => recordSent(log.state(), eve, ctx, sent())).toThrow(/not found/);
    expect(() => recordSent(log.state(), bob, ctx, sent({ dataSourceId: 'ds_alice' }))).toThrow(/not found/);
    expect(() => recordSent(log.state(), alice, ctx, sent({ dataSourceId: 'ds_alice', replyToThreadId: cust }))).toThrow(/another data source/);
    push(log, ctx, T(9, 10), recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust })));
    expect(recordSent(log.state(), bob, ctx, sent({ replyToThreadId: cust })).events).toEqual([]);
    expect(() => recordSent(log.state(), alice, ctx, sent({ sentRef: '<m1>' }))).toThrow(/received/);
  });
});

describe('タスクを作った記録（0039 の決定 3）', () => {
  it('H4 H9 タスクのサービスへの record_sent は宛先が要らない。タスクの ID が区切りになり、元のスレッドと経路 sent で結ぶ。あとから届く写しは同じスレッドに入る', () => {
    const { log, ctx, cust } = world();
    const r = recordSent(log.state(), alice, ctx, sent({ dataSourceId: 'ds_tasks_alice', to: [], subject: '雨漏りの見積を取る', body: '期限 10/20', sentRef: 'AAMk-task-1', sourceThreadId: cust }));
    push(log, ctx, T(9, 10), r);
    let p = log.state();
    expect(p.threads[r.threadId]).toMatchObject({ dataSourceId: 'ds_tasks_alice', title: '雨漏りの見積を取る', links: [{ threadId: cust, route: 'sent' }] });
    expect(p.signals[r.signalId]).toMatchObject({ from: { channel: 'todo', value: 'alice@ubs.example' }, to: [], anchors: { threadKey: 'AAMk-task-1', messageId: 'AAMk-task-1' } });
    expect(view(p, r.threadId)).toMatchObject({ assignee: null, attention: { named: [], list: null }, awaiting: false });
    // 写しが届く（件名が直り、期限が付く）。同じスレッドに入る
    const m = planMirror(p, ctx, { kind: 'mirror', dataSourceId: 'ds_tasks_alice', channel: 'todo', threadKey: 'AAMk-task-1', fields: { title: '雨漏りの見積', due: '2026-10-20', closed: false }, sourceRef: 'todo:1' });
    expect(m).toMatchObject({ kind: 'mirrored', threadId: r.threadId, newThread: false });
    if (m.kind === 'mirrored') log.push(m.events, T(9, 20));
    p = log.state();
    expect(p.threads[r.threadId]).toMatchObject({ title: '雨漏りの見積', source: { due: '2026-10-20' } });
    // 宛先がないのはタスクのサービスだけ
    expect(() => recordSent(log.state(), alice, ctx, sent({ to: [] }))).toThrow(/to/);
  });
});

describe('観測された送信の統合（H5）', () => {
  it('H5 記録 → 観測の順: 観測は統合され、シグナルは 1 本のまま、イベントも出ない', () => {
    const { log, ctx, cust } = world();
    push(log, ctx, T(9, 10), recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust, replyExpectedBy: T(12) })));
    const before = log.state();
    const echo = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'email:<u1@ubs.example>', anchors: { messageId: '<u1@ubs.example>', inReplyTo: '<m1>' } }));
    expect(echo).toMatchObject({ duplicate: true, events: [] });
    expect(log.state()).toEqual(before);
  });

  it('H5 観測 → 記録の順: 記録は観測のシグナルに重なり、名指しは二重にならず、返事期待だけが載る', () => {
    const { log, ctx, cust } = world();
    ctx.setNow(T(9, 10));
    const obs = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'email:<u1@ubs.example>', anchors: { messageId: '<u1@ubs.example>', inReplyTo: '<m1>' } }));
    const before = log.state().threads[cust]!;
    const r = recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust, replyExpectedBy: T(12) }));
    expect(r.signalId).toBe(obs.signalId);
    expect(r.events.map((e) => e.type)).toEqual(['OutboundRecorded']);
    expect(r.events[0]!.type === 'OutboundRecorded' && r.events[0]!.payload.merged).toBe(true);
    push(log, ctx, T(9, 15), r);
    const t = log.state().threads[cust]!;
    expect(t.signalIds).toEqual(before.signalIds);
    expect(t).toMatchObject({ attention: { named: before.attention.named }, replyExpectedBy: T(12) });
    expect(commView(dir, t).lastOutboundAt).toBe(commView(dir, before).lastOutboundAt);
    expect(Object.keys(log.state().signals)).toHaveLength(2);
  });

  it('H5 観測 → 記録の順で、Ingest の置き先と reply_to が違えば本人の指定に移す', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const a = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l1', body: '鍵をなくしました' }), () => answer({ title: '鍵' }));
    const other = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l2', body: '別件です' }), () => answer({ thread: 'new', title: '別件' }));
    // LINE の観測された送信はアンカーがないので、AI が鍵のスレッドに入れた（とする）
    const obs = ingestPure(log, ctx, line({ from: '@ubs', to: 'U_carol', sourceRef: 'line:s1', anchors: { messageId: 'line:s1' } }), () =>
      answer({ thread: 'existing', thread_id: a.outcome!.threadId }),
    );
    expect(obs.outcome!.threadId).toBe(a.outcome!.threadId);
    expect(other.outcome!.threadId).not.toBe(a.outcome!.threadId);
    const r = recordSent(log.state(), bob, ctx, {
      dataSourceId: 'ds_line',
      to: ['U_carol'],
      toContactIds: [],
      body: '本文',
      sentRef: 'line:s1',
      replyToThreadId: other.outcome!.threadId,
    });
    expect(r.events.map((e) => e.type)).toEqual(['OutboundRecorded', 'SignalThreaded']);
    push(log, ctx, T(9, 30), r);
    expect(log.state().signals[obs.signalId!]!.threadId).toBe(other.outcome!.threadId);
  });
});

describe('期限の見回り', () => {
  it('H4 期限を過ぎたら ReplyOverdue を 1 回だけ出す。遅れて相手の名指しを外せば解消する。片付けたものは出さない', () => {
    const { log, ctx, cust } = world();
    push(log, ctx, T(9, 10), recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust, replyExpectedBy: T(12) })));
    expect(planOverdue(dir, log.state(), T(11))).toEqual([]);
    const due = planOverdue(dir, log.state(), T(13));
    expect(due).toHaveLength(1);
    log.push(due, T(13));
    expect(view(log.state(), cust)).toMatchObject({ overdue: true });
    expect(planOverdue(dir, log.state(), T(14))).toEqual([]);
    expect(listThreads(dir, alice, log.state(), { filter: 'overdue' }).map((t) => t.id)).toEqual([cust]);
    expect(getThreadView(dir, alice, log.state(), cust)!.timeline.at(-1)).toMatchObject({ kind: 'overdue', replyExpectedBy: T(12) });

    ctx.setNow(T(15));
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<u1@ubs.example>' } }));
    expect(view(log.state(), cust)).toMatchObject({ overdue: true });
    log.push(acknowledgeAttention(log.state(), bob, dir, { threadId: cust, addresses: [{ channel: 'email', value: 'carol@example.com' }] }), T(15, 5));
    expect(view(log.state(), cust)).toMatchObject({ overdue: false, replyExpectedBy: null });
    // 外したあとは期限超過を出さない
    expect(planOverdue(dir, log.state(), T(23))).toEqual([]);
    expect(listThreads(dir, alice, log.state(), { filter: 'overdue' })).toEqual([]);
  });

  it('H4 返事期待のない送信・片付けたスレッドは期限超過にならない', () => {
    const { log, ctx, cust } = world();
    push(log, ctx, T(9, 10), recordSent(log.state(), alice, ctx, sent({ replyToThreadId: cust })));
    expect(planOverdue(dir, log.state(), T(23))).toEqual([]);
    push(log, ctx, T(9, 20), recordSent(log.state(), alice, ctx, sent({ sentRef: '<u9@ubs.example>', replyToThreadId: cust, replyExpectedBy: T(12) })));
    log.push([{ type: 'ThreadDismissed', payload: { threadId: cust, actorUserId: 'u_alice', reason: '済み' } }], T(10));
    expect(planOverdue(dir, log.state(), T(23))).toEqual([]);
  });
});
