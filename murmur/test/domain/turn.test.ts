import { describe, expect, it } from 'vitest';
import {
  acknowledgeAttention,
  addNote,
  assigneeOf,
  claimThread,
  derivedBall,
  dismissThread,
  draft,
  getThreadView,
  isAwaiting,
  isTriage,
  linkCandidates,
  linkThreads,
  listThreads,
  myTurnOf,
  planOverdue,
  recordSent,
} from '../../src/domain';
import { alice, answer, bob, dir, email, EventLog, ingestPure, line, makeCtx, task, updateTask, view } from '../helpers/world';

// クエリ層の「誰の番か」・リンク先から導出したボール・結び候補・タイムライン（H2・H8）

function world() {
  const log = new EventLog();
  const ctx = makeCtx();
  // support@（読者 2 人、宛先は組織）→ 仕分け待ち
  const shared = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>', jiraKeys: ['UBS-7'] } }), () => answer({ title: '雨漏り' }));
  // support@ だが Alice 宛て（CC など）→ Alice の番
  const addressed = ingestPure(log, ctx, email({ from: 'info@dave.example', to: ['support@ubs.example', 'alice@ubs.example'], sourceRef: 'r2', anchors: { threadKey: 'UBS-7' } }), () =>
    answer({ title: '見積' }),
  );
  // LINE 公式アカウント（読者は Bob だけ）→ Bob の番
  const lineThread = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l1' }), () => answer({ title: 'LINE' }));
  return { log, ctx, shared: shared.outcome!.threadId, addressed: addressed.outcome!.threadId, line: lineThread.outcome!.threadId };
}

describe('誰の番か（担当と名指し。0038）', () => {
  it('H8 構造で決まる: 窓口宛ては読者全員へのリスト宛て、CC に読者がいればその人への名指し。共有リストで担当がいなければ仕分け待ち', () => {
    const { log, shared, addressed, line: l } = world();
    const p = log.state();
    expect(myTurnOf(dir, alice, p.threads[shared]!)).toEqual(['list']);
    expect(myTurnOf(dir, bob, p.threads[shared]!)).toEqual(['list']);
    expect(myTurnOf(dir, alice, p.threads[addressed]!)).toEqual(['named', 'list']);
    expect(myTurnOf(dir, bob, p.threads[addressed]!)).toEqual(['list']);
    // LINE 公式アカウントは読者が 1 人でも共有リスト（組織の資格情報）。「読者が 1 人」で番を決めない
    expect(myTurnOf(dir, bob, p.threads[l]!)).toEqual(['list']);
    expect([shared, addressed, l].map((id) => isTriage(dir, p.threads[id]!))).toEqual([true, true, true]);
    expect(listThreads(dir, alice, p, { filter: 'my_turn' }).map((t) => t.id).sort()).toEqual([addressed, shared].sort());
    expect(listThreads(dir, bob, p, { filter: 'triage' }).map((t) => t.id).sort()).toEqual([addressed, l, shared].sort());
  });

  it('H8 名指しは本人が外すまで残る。外せばその人の番から外れ、ほかの読者には残る', () => {
    const { log, shared } = world();
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: shared }), '2026-10-16T10:00:00.000Z');
    const p = log.state();
    expect(myTurnOf(dir, alice, p.threads[shared]!)).toEqual([]);
    expect(myTurnOf(dir, bob, p.threads[shared]!)).toEqual(['list']);
    // 外すものがなければ何もしない
    expect(acknowledgeAttention(p, alice, dir, { threadId: shared })).toEqual([]);
  });

  it('H8 担当する操作が担当を決める。担当がいれば仕分け待ちでない。手放すと仕分け待ちに戻る', () => {
    const { log, shared } = world();
    log.push(claimThread(log.state(), bob, dir, { threadId: shared, userId: 'u_bob' }), '2026-10-16T10:00:00.000Z');
    let p = log.state();
    expect(assigneeOf(dir, p.threads[shared]!)).toEqual({ by: 'claim', userIds: ['u_bob'], contactIds: [], addresses: [] });
    expect(myTurnOf(dir, bob, p.threads[shared]!)).toEqual(['assignee', 'list']);
    expect(listThreads(dir, alice, p, { filter: 'triage' }).map((t) => t.id)).not.toContain(shared);
    log.push(claimThread(p, bob, dir, { threadId: shared, userId: null }), '2026-10-16T11:00:00.000Z');
    p = log.state();
    expect(listThreads(dir, alice, p, { filter: 'triage' }).map((t) => t.id)).toContain(shared);
  });

  it('H8 返信で相手が名指しされて相手待ち。片付けたスレッドはどの見え方にも出ない', () => {
    const { log, ctx, shared } = world();
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'o1', anchors: { inReplyTo: '<m1>' } }));
    const p = log.state();
    expect(isAwaiting(dir, p.threads[shared]!)).toBe(true);
    expect(listThreads(dir, alice, p, { filter: 'awaiting' }).map((t) => t.id)).toEqual([shared]);
    log.push(dismissThread(p, alice, dir, { threadId: shared, reason: 'x' }), '2026-10-16T10:00:00.000Z');
    const q = log.state();
    expect([isAwaiting(dir, q.threads[shared]!), isTriage(dir, q.threads[shared]!), myTurnOf(dir, bob, q.threads[shared]!)]).toEqual([false, false, []]);
  });

  it('H8 読者でないアドレスの名指しは読者なら誰でも外せる。読者のアドレスの名指しは本人だけ', () => {
    const { log, ctx, addressed } = world();
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['info@dave.example'], sourceRef: 'o2', anchors: { threadKey: 'UBS-7' } }));
    let p = log.state();
    expect(() => acknowledgeAttention(p, bob, dir, { threadId: addressed, addresses: [{ channel: 'email', value: 'alice@ubs.example' }] })).toThrow(/only that reader/);
    log.push(acknowledgeAttention(p, bob, dir, { threadId: addressed, addresses: [{ channel: 'email', value: 'info@dave.example' }] }), '2026-10-16T10:00:00.000Z');
    p = log.state();
    expect(isAwaiting(dir, p.threads[addressed]!)).toBe(false);
    expect(myTurnOf(dir, alice, p.threads[addressed]!)).toEqual(['named', 'list']);
  });
});

describe('一覧の並び（lastActivityAt）', () => {
  it('H2 一覧は自分か見える結んだ先の最新の更新の降順。結んだ先が動けば、メモにだれも書く前でもタスクが上に来る（0031 の 5）', () => {
    const { log, ctx, shared } = world();
    ctx.setNow('2026-10-16T10:00:00.000Z');
    const t = task(log, ctx, '雨漏りの対応');
    log.push(linkThreads(log.state(), alice, { threadId: t, otherThreadId: shared }), '2026-10-16T10:01:00.000Z');
    ctx.setNow('2026-10-16T11:00:00.000Z');
    const other = task(log, ctx, '別の件');
    const mine = () => listThreads(dir, alice, log.state(), { filter: 'mine' });
    expect(mine().map((x) => x.id)).toEqual([other, t]);
    // 結んだ先（support@ のスレッド）に返事が来る
    ctx.setNow('2026-10-16T12:00:00.000Z');
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r9', anchors: { inReplyTo: '<m1>' } }), () => answer({}));
    expect(mine().map((x) => x.id)).toEqual([t, other]);
    expect(mine()[0]).toMatchObject({ updatedAt: '2026-10-16T10:01:00.000Z', lastActivityAt: '2026-10-16T12:00:00.000Z' });
    // mine はタスクだけ（support@ のスレッドや本人の箱のメールは入らない）。Bob のタスクは Bob にだけ
    ctx.setNow('2026-10-16T13:00:00.000Z');
    const bobs = task(log, ctx, 'Bob の件', { dataSourceId: 'ds_tasks_bob' });
    expect(listThreads(dir, bob, log.state(), { filter: 'mine' }).map((x) => x.id)).toEqual([bobs]);
    expect(mine().map((x) => x.id)).not.toContain(bobs);
  });
});

describe('リンク先から導出したボール（derivedBall）', () => {
  it('H2 タスクのボールは、見えるリンク先から決まる（どれかが自分の番 → my_turn、全部相手待ち → waiting）', () => {
    const { log, ctx, shared, addressed } = world();
    const n = { threadId: task(log, ctx, '雨漏りの件') };
    expect(derivedBall(dir, alice, log.state(), log.state().threads[n.threadId]!)).toBeNull();

    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: shared }), '2026-10-16T10:00:30.000Z');
    log.push(linkThreads(log.state(), alice, { threadId: n.threadId, otherThreadId: shared }), '2026-10-16T10:01:00.000Z');
    expect(derivedBall(dir, alice, log.state(), log.state().threads[n.threadId]!)).toEqual({ kind: 'none' });
    log.push(linkThreads(log.state(), alice, { threadId: n.threadId, otherThreadId: addressed }), '2026-10-16T10:02:00.000Z');
    expect(derivedBall(dir, alice, log.state(), log.state().threads[n.threadId]!)).toEqual({ kind: 'my_turn', threadIds: [addressed] });

    // 両方に返事を送り、自分への名指しを外すと相手待ち
    ctx.setNow('2026-10-16T11:00:00.000Z');
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'o1', anchors: { inReplyTo: '<m1>' } }));
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['info@dave.example'], sourceRef: 'o2', anchors: { threadKey: 'UBS-7' } }));
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: addressed }), '2026-10-16T11:01:00.000Z');
    const p = log.state();
    expect(derivedBall(dir, alice, p, p.threads[n.threadId]!)).toEqual({ kind: 'waiting', threadIds: [addressed, shared].sort() });
    // タスク自身の名指しは動かない（本人の側の状態を Murmur は変えない）
    expect(p.threads[n.threadId]!.attention.named).toEqual([]);
  });

  it('H2 ソースで完了したタスクに結ばれた先が動いても開き直さず、linkedActiveSinceDismissed で知らせるだけ（0039）', () => {
    const { log, ctx, shared } = world();
    const n = { threadId: task(log, ctx, '件') };
    log.push(linkThreads(log.state(), alice, { threadId: n.threadId, otherThreadId: shared }), '2026-10-16T10:01:00.000Z');
    ctx.setNow('2026-10-16T10:02:00.000Z');
    updateTask(log, ctx, 'task:件', { closed: true });
    let view = getThreadView(dir, alice, log.state(), n.threadId)!;
    expect(view.thread).toMatchObject({ closedAtSource: true, linkedActiveSinceDismissed: false });
    ctx.setNow('2026-10-16T12:00:00.000Z');
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r9', anchors: { inReplyTo: '<m1>' } }), () => answer({ thread: null }));
    view = getThreadView(dir, alice, log.state(), n.threadId)!;
    expect(view.thread).toMatchObject({ closedAtSource: true, linkedActiveSinceDismissed: true });
    expect(log.events.filter((e) => e.type === 'ThreadMirrored' && e.payload.fields.closed === false)).toEqual([]);
    // ソースで開き直せば消える
    updateTask(log, ctx, 'task:件', { closed: false });
    expect(getThreadView(dir, alice, log.state(), n.threadId)!.thread).toMatchObject({ closedAtSource: false, linkedActiveSinceDismissed: false });
  });
});

describe('結び候補（linkCandidates）', () => {
  it('H8 アンカーのキー（ソースの区切り・Jira キー・PR）が一致する見えるスレッドを候補に出す。結べば候補から消える。自分では張らない', () => {
    const { log, shared, addressed, line: l } = world();
    let p = log.state();
    expect(linkCandidates(alice, p, p.threads[shared]!)).toEqual([{ threadId: addressed, dataSourceId: 'ds_support', title: '見積', keys: ['UBS-7'] }]);
    expect(linkCandidates(bob, p, p.threads[l]!)).toEqual([]);
    expect(log.events.filter((e) => e.type === 'ThreadLinked')).toEqual([]);
    log.push(linkThreads(p, alice, { threadId: shared, otherThreadId: addressed }), '2026-10-16T10:00:00.000Z');
    p = log.state();
    expect(linkCandidates(alice, p, p.threads[shared]!)).toEqual([]);
    expect(p.threads[shared]!.links[0]!.route).toBe('anchor');
  });

  it('H3 見えないスレッドは候補に出ない', () => {
    const { log, ctx, shared } = world();
    const priv = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'info@dave.example', to: ['alice@ubs.example'], sourceRef: 'p1', anchors: { jiraKeys: ['UBS-7'] } }), () =>
      answer(),
    );
    const p = log.state();
    expect(linkCandidates(alice, p, p.threads[shared]!).map((c) => c.threadId)).toContain(priv.outcome!.threadId);
    expect(linkCandidates(bob, p, p.threads[shared]!).map((c) => c.threadId)).not.toContain(priv.outcome!.threadId);
  });
});

describe('リンクの可視性（0033）', () => {
  it('H3 共有リスト同士のリンクは、両方のリストの読者にだけ見える', () => {
    const { log, shared, line: lineThread } = world();
    // Bob は support@ と LINE の両方の読者、Alice は support@ だけ
    log.push(linkThreads(log.state(), bob, { threadId: shared, otherThreadId: lineThread }), '2026-10-16T10:01:00.000Z');
    const p = log.state();
    const bobView = getThreadView(dir, bob, p, shared)!;
    expect(bobView.linked.map((l) => l.threadId)).toEqual([lineThread]);
    expect(bobView.thread.links.map((l) => l.threadId)).toEqual([lineThread]);
    const aliceView = getThreadView(dir, alice, p, shared)!;
    expect(aliceView.linked).toEqual([]);
    expect(aliceView.thread.links).toEqual([]);
    expect(aliceView.thread.derivedBall).toBeNull();
    expect(aliceView.timeline.map((e) => e.kind)).not.toContain('linked');
    expect(JSON.stringify(aliceView)).not.toContain(lineThread);
    expect(derivedBall(dir, alice, p, p.threads[shared]!)).toBeNull();
  });
});

describe('タイムライン（getThreadView）', () => {
  it('H2 自分のスレッドの綴じたものと、見えるリンク先のシグナルを時刻順に並べる。since で差分に絞る。見えない先へのリンクは、あることも出さない（0033）', () => {
    const { log, ctx, shared } = world();
    ctx.setNow('2026-10-16T09:30:00.000Z');
    const n = { threadId: task(log, ctx, '雨漏り') };
    log.push(addNote(log.state(), alice, ctx, { threadId: n.threadId, body: '電話で聞いた' }).events, '2026-10-16T10:00:00.000Z');
    log.push(linkThreads(log.state(), alice, { threadId: n.threadId, otherThreadId: shared }), '2026-10-16T10:01:00.000Z');
    ctx.setNow('2026-10-16T10:02:00.000Z');
    updateTask(log, ctx, 'task:雨漏り', { due: '2026-10-20' });
    const view = getThreadView(dir, alice, log.state(), n.threadId)!;
    expect(view.timeline.map((e) => [e.kind, e.threadId])).toEqual([
      ['signal', shared],
      ['mirrored', n.threadId],
      ['note', n.threadId],
      ['linked', n.threadId],
      ['mirrored', n.threadId],
    ]);
    expect(getThreadView(dir, alice, log.state(), n.threadId, { since: '2026-10-16T10:00:30.000Z' })!.timeline.map((e) => e.kind)).toEqual(['linked', 'mirrored']);

    const bobView = getThreadView(dir, bob, log.state(), shared)!;
    expect(bobView.linked).toEqual([]);
    expect(bobView.thread.links).toEqual([]);
    expect(bobView.thread.derivedBall).toBeNull();
    expect(bobView.timeline.map((e) => e.kind)).not.toContain('linked');
    expect(JSON.stringify(bobView)).not.toContain(n.threadId);
    expect(JSON.stringify(bobView)).not.toContain('電話で聞いた');
    // Alice には両端が見える
    const aliceView = getThreadView(dir, alice, log.state(), shared)!;
    expect(aliceView.linked).toEqual([expect.objectContaining({ threadId: n.threadId, visible: true, dataSourceId: 'ds_tasks_alice' })]);
    expect(aliceView.timeline.map((e) => e.kind)).toContain('linked');
    expect(getThreadView(dir, bob, log.state(), n.threadId)).toBeNull();
  });
});

describe('名指しの細部（0038 のレビューで見つけたもの）', () => {
  const T = (h: number, m = 0) => `2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

  it('H6 H8 受信の CC に入っていただけの相手は「こちらが待っている相手」ではない。その人の別件は古いスレッドに入らない', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const first = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'carol@example.com', to: ['alice@ubs.example', 'info@dave.example'], sourceRef: 'p1' }), () =>
      answer({ title: '雨漏り' }),
    );
    expect(isAwaiting(dir, log.state().threads[first.outcome!.threadId]!)).toBe(false);
    ctx.setNow(T(10));
    const other = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'info@dave.example', to: ['alice@ubs.example'], sourceRef: 'p2' }), () =>
      answer({ title: '別件' }),
    );
    expect(other.outcome).toMatchObject({ newThread: true, by: 'no_match' });
  });

  it('H8 外したあとでシグナルを移し替えても、手前の名指しは外れたまま', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const a = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'carol@example.com', to: ['alice@ubs.example'], sourceRef: 'p1', anchors: { messageId: '<a>' } }), () =>
      answer({ title: '件' }),
    );
    ctx.setNow(T(10));
    const b = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'carol@example.com', to: ['alice@ubs.example'], sourceRef: 'p2', anchors: { inReplyTo: '<a>' } }));
    const id = a.outcome!.threadId;
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: id }), T(11));
    expect(myTurnOf(dir, alice, log.state().threads[id]!)).toEqual([]);
    log.push(
      [draft('SignalThreaded', { signalId: b.signalId!, thread: { kind: 'new', threadId: 'thr_moved', title: '別件' }, by: 'human', confidence: 1, reason: '別の話', actorUserId: 'u_alice' })],
      T(12),
    );
    expect(myTurnOf(dir, alice, log.state().threads[id]!)).toEqual([]);
    expect(myTurnOf(dir, alice, log.state().threads.thr_moved!)).toEqual(['named']);
  });

  it('H8 リスト宛ての名指しはシグナルごと。本人が窓口を CC に入れて返信しても、本人のリスト宛ては外れない（発言では外れない）', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
    const id = r.outcome!.threadId;
    ctx.setNow(T(10));
    ingestPure(log, ctx, email({ from: 'alice@ubs.example', to: ['carol@example.com', 'support@ubs.example'], sourceRef: 'o1', anchors: { inReplyTo: '<m1>' } }));
    const t = log.state().threads[id]!;
    expect(myTurnOf(dir, alice, t)).toEqual(['list']);
    expect(myTurnOf(dir, bob, t)).toEqual(['list']);
  });

  it('H4 返事期待は読者でない相手の名指しで決まる。社内の読者を CC に入れても、相手の名指しを外せば消える', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
    const id = r.outcome!.threadId;
    const sent = recordSent(log.state(), bob, ctx, {
      dataSourceId: 'ds_support',
      to: ['carol@example.com', 'alice@ubs.example'],
      toContactIds: [],
      body: '調査します',
      sentRef: '<u1@ubs.example>',
      replyToThreadId: id,
      replyExpectedBy: T(12),
    });
    log.push(sent.events, T(9, 30));
    log.push(planOverdue(dir, log.state(), T(13)), T(13));
    expect(view(log.state(), id)).toMatchObject({ overdue: true, replyExpectedBy: T(12) });
    log.push(acknowledgeAttention(log.state(), bob, dir, { threadId: id, addresses: [{ channel: 'email', value: 'carol@example.com' }] }), T(14));
    expect(view(log.state(), id)).toMatchObject({ overdue: false, replyExpectedBy: null });
    // Alice（読者）への名指しは Alice のもの
    expect(myTurnOf(dir, alice, log.state().threads[id]!)).toContain('named');
  });

  it('H8 個人リストにエイリアスや配布リスト宛てで届いた受信は、本人へのリスト宛て。相手待ちにはならない', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'carol@example.com', to: ['all@ubs.example'], sourceRef: 'p1' }), () => answer({ title: 'お知らせ' }));
    const t = log.state().threads[r.outcome!.threadId]!;
    expect(myTurnOf(dir, alice, t)).toEqual(['list']);
    expect(isAwaiting(dir, t)).toBe(false);
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: t.id }), T(10));
    expect(myTurnOf(dir, alice, log.state().threads[t.id]!)).toEqual([]);
  });

  it('H8 個人リストに宛先なし（BCC だけ）で届いた受信も、本人へのリスト宛て。本人が宛先なしで送ったものは違う', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'no-reply@notify.example', to: [], sourceRef: 'b1' }), () => answer({ title: '通知' }));
    const t = log.state().threads[r.outcome!.threadId]!;
    expect(myTurnOf(dir, alice, t)).toEqual(['list']);
    expect(isAwaiting(dir, t)).toBe(false);
    log.push(acknowledgeAttention(log.state(), alice, dir, { threadId: t.id }), T(10));
    expect(myTurnOf(dir, alice, log.state().threads[t.id]!)).toEqual([]);

    const own = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'alice@ubs.example', to: [], sourceRef: 'b2' }), () => answer({ title: '自分の BCC' }));
    expect(myTurnOf(dir, alice, log.state().threads[own.outcome!.threadId]!)).toEqual([]);
  });
});
