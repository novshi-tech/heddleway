import { describe, expect, it } from 'vitest';
import { canonicalJson, directionOf, draft, fold, FoldError, isStaleProjections, parseEvent, summarizeThread, type DomainEvent, type MirrorFields, type Projections } from '../../src/domain';
import { dir, EventLog } from '../helpers/world';

/** 投影のスレッドに、クエリ層で解決したもの（担当・名指し・相手。0030・0038）を重ねたもの */
const view = (p: Projections, id: string) => ({ ...p.threads[id]!, ...summarizeThread(dir, p, p.threads[id]!) });

// fold の純関数テスト（イベント型を変えたらここも更新する）

const T0 = '2026-10-16T09:00:00.000Z';
const T1 = '2026-10-16T10:00:00.000Z';
const T2 = '2026-10-16T11:00:00.000Z';

function observed(signalId: string, extra: Record<string, unknown> = {}) {
  return draft('SignalObserved', {
    signalId,
    dataSourceId: 'ds_support',
    channel: 'email',
    from: { channel: 'email', value: 'carol@example.com' },
    to: [{ channel: 'email', value: 'support@ubs.example' }],
    body: '雨漏りしています',
    subject: '修繕のお願い',
    sourceRef: `src-${signalId}`,
    anchors: { messageId: `<${signalId}@x>` },
    ...extra,
  });
}

const sent = (signalId: string, to = ['carol@example.com']) =>
  observed(signalId, {
    from: { channel: 'email', value: 'support@ubs.example' },
    to: to.map((value) => ({ channel: 'email', value })),
  });

const intoNew = (signalId: string, threadId: string, needsResponse: boolean | null = null) =>
  draft('SignalThreaded', {
    signalId,
    thread: { kind: 'new', threadId, title: '雨漏り' },
    by: 'no_match',
    confidence: 1,
    reason: 'r',
    needsResponse,
  });

const into = (signalId: string, threadId: string, needsResponse: boolean | null = null, by: 'anchor' | 'human' = 'anchor') =>
  draft('SignalThreaded', { signalId, thread: { kind: 'existing', threadId }, by, confidence: 1, reason: 'r', needsResponse });

describe('fold', () => {
  const listOf = (p: Projections, id: string) => view(p, id).attention.list?.userIds ?? [];
  const namedOf = (p: Projections, id: string) => view(p, id).attention.named.map((n) => n.address.value);

  it('H1 SignalObserved + SignalThreaded(new) でスレッドができ、窓口宛て（リスト宛て）の名指しが読者に残る。担当はいないので仕分け待ち', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    const p = log.state();
    expect(view(p, 't1')).toMatchObject({
      dataSourceId: 'ds_support',
      title: '雨漏り',
      assignee: null,
      triage: true,
      awaiting: false,
      counterpartContactIds: ['p_carol'],
      signalIds: ['s1'],
      lastInboundAt: T0,
      dismissed: false,
    });
    expect(view(p, 't1').attention).toEqual({ named: [], list: { userIds: ['u_alice', 'u_bob'], signalId: 's1', at: T0 } });
    expect(p.signals.s1).toMatchObject({ threadId: 't1', threadedBy: 'no_match' });
    expect(directionOf(dir, p.signals.s1!)).toBe('inbound');
    expect(p.index).toEqual({ sourceRefs: { 'ds_support|src-s1': 's1' }, messageIds: { 'ds_support|<s1@x>': 's1' } });
    expect(p.lastSeq).toBe(2);
  });

  it('H1 送信で相手が名指しされて相手待ち。返事が来ても、外すまで相手の名指しは残る。外すと消える', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([sent('o1'), into('o1', 't1')], T1);
    expect(view(log.state(), 't1')).toMatchObject({ awaiting: true, lastOutboundAt: T1 });
    expect(view(log.state(), 't1').attention.named).toEqual([{ address: { channel: 'email', value: 'carol@example.com' }, userId: null, contactId: 'p_carol', signalId: 'o1', at: T1 }]);

    log.push([observed('s2'), into('s2', 't1')], T2);
    expect(namedOf(log.state(), 't1')).toEqual(['carol@example.com']);
    log.push(
      [draft('AttentionAcknowledged', { threadId: 't1', untilSignalId: 's2', addresses: [{ channel: 'email', value: 'carol@example.com' }], actorUserId: 'u_alice' })],
      '2026-10-16T12:00:00.000Z',
    );
    expect(view(log.state(), 't1')).toMatchObject({ awaiting: false });
    expect(namedOf(log.state(), 't1')).toEqual([]);
    expect(view(log.state(), 't1').log.at(-1)).toMatchObject({ kind: 'acknowledged', untilSignalId: 's2', list: false, actorUserId: 'u_alice' });
  });

  it('H1 古いイベントの needsResponse は読まない（0038）', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1', false)], T0);
    expect(listOf(log.state(), 't1')).toEqual(['u_alice', 'u_bob']);
    expect(log.state().signals.s1).not.toHaveProperty('needsResponse');
  });

  it('H1 片付けると見え方から外れ、その後のシグナルは綴じるが片付けたまま（開き直しで戻る）', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([draft('ThreadDismissed', { threadId: 't1', actorUserId: 'u_alice', reason: '対応不要' })], T1);
    expect(view(log.state(), 't1')).toMatchObject({ triage: false, dismissed: true, dismissReason: '対応不要', dismissedAt: T1 });

    log.push([observed('s2'), into('s2', 't1')], T2);
    expect(view(log.state(), 't1')).toMatchObject({ triage: false, dismissed: true, activeSinceDismissed: true, signalIds: ['s1', 's2'] });

    log.push([draft('ThreadReopened', { threadId: 't1', actorUserId: 'u_alice' })], '2026-10-16T12:00:00.000Z');
    expect(view(log.state(), 't1')).toMatchObject({ triage: true, dismissed: false, activeSinceDismissed: false, dismissReason: null });
    expect(view(log.state(), 't1').log.map((l) => l.kind)).toEqual(['signal', 'dismissed', 'signal', 'reopened']);
  });

  it('H1 移し替え: 元のスレッドから外れて通信状態が計算し直され、移し先に時刻順で入る', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([sent('o1'), into('o1', 't1')], T1);
    expect(view(log.state(), 't1').awaiting).toBe(true);
    log.push([draft('SignalThreaded', { signalId: 'o1', thread: { kind: 'new', threadId: 't2', title: '別件' }, by: 'human', confidence: 1, reason: '別の話題', actorUserId: 'u_alice' })], T2);
    const p = log.state();
    expect(view(p, 't1')).toMatchObject({ signalIds: ['s1'], awaiting: false });
    // 新しいスレッドの作成時刻はシグナルの時刻
    expect(view(p, 't2')).toMatchObject({ signalIds: ['o1'], awaiting: true, createdAt: T1, title: '別件' });
    expect(p.signals.o1).toMatchObject({ threadId: 't2', threadedBy: 'human' });

    // 戻すと元の順番に戻る
    log.push([into('o1', 't1', null, 'human')], '2026-10-16T12:00:00.000Z');
    expect(view(log.state(), 't1').signalIds).toEqual(['s1', 'o1']);
    expect(view(log.state(), 't2').signalIds).toEqual([]);
  });

  it('H1 入力のイベント列も base の投影も変更しない（純関数）', () => {
    const log = new EventLog();
    log.push([observed('s1')], T0);
    const snapshot = structuredClone(log.events);
    const base = log.state();
    const baseSnapshot = structuredClone(base);
    log.push([intoNew('s1', 't1')], T1);
    fold(log.events.slice(1), base);
    expect(log.events.slice(0, 1)).toEqual(snapshot);
    expect(base).toEqual(baseSnapshot);
  });

  it('H1 一括で畳んでも 1 件ずつ畳んでも同じ投影になる', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([sent('o1'), into('o1', 't1', null)], T1);
    log.push([draft('ThreadDismissed', { threadId: 't1', actorUserId: 'u_alice', reason: 'x' })], T2);
    const whole = fold(log.events);
    const stepwise = log.events.reduce((p, e) => fold([e], p), fold([]));
    expect(canonicalJson(stepwise)).toBe(canonicalJson(whole));
  });

  it('H1 不正な列は FoldError（seq の逆行・未知のシグナルやスレッド・データソースをまたぐ置き先）', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    const [a, b] = log.events as [DomainEvent, DomainEvent];
    expect(() => fold([b, a])).toThrow(FoldError);
    expect(() => fold([{ ...b, seq: 1 }])).toThrow(/unknown signal/);
    expect(() => fold([a, { ...into('s1', 'nope'), seq: 2, at: T0 } as DomainEvent])).toThrow(/unknown thread/);
    expect(() => fold([...log.events, { ...intoNew('s1', 't1'), seq: 3, at: T0 } as DomainEvent])).toThrow(/already exists/);
    const other = { ...observed('s9', { dataSourceId: 'ds_alice', sourceRef: 'x' }), seq: 3, at: T0 } as DomainEvent;
    expect(() => fold([...log.events, other, { ...into('s9', 't1'), seq: 4, at: T0 } as DomainEvent])).toThrow(/cannot go into/);
  });

  it('H1 メモ（ThreadNoted。0039）: スレッドのログに本文と書き手で載る。シグナルにはならず、名指しを作らない', () => {
    const log = new EventLog();
    log.push([taskThread('m1', '雨漏りの件'), note('n1', 'm1')], T0);
    log.push([note('n2', 'm1', { kind: 'agent', name: 'orchestrator' })], T1);
    const t = view(log.state(), 'm1');
    expect(t).toMatchObject({ dataSourceId: 'ds_tasks_alice', assignee: null, triage: false, attention: { named: [], list: null }, signalIds: [], counterpartContactIds: [], lastOutboundAt: null, updatedAt: T1 });
    expect(t.log.map((l) => [l.kind, l.noteId, l.author])).toEqual([
      ['mirrored', undefined, undefined],
      ['note', 'n1', { kind: 'user' }],
      ['note', 'n2', { kind: 'agent', name: 'orchestrator' }],
    ]);
    expect(Object.keys(log.state().signals)).toEqual([]);
    expect(() => fold([...log.events, { ...note('n3', 'nope'), seq: 99, at: T2 } as DomainEvent])).toThrow(/unknown thread/);
  });

  it('H1 写しの closed で閉じた時刻が残り、開き直せば消える（closedAtSourceAt。0039）', () => {
    const log = new EventLog();
    log.push([taskThread('m1', '件')], T0);
    log.push([draft('ThreadMirrored', { threadId: 'm1', dataSourceId: 'ds_tasks_alice', threadKey: 'task-m1', fields: { closed: true }, sourceRef: 'c' })], T1);
    expect(view(log.state(), 'm1')).toMatchObject({ closedAtSource: true, closedAtSourceAt: T1 });
    log.push([draft('ThreadMirrored', { threadId: 'm1', dataSourceId: 'ds_tasks_alice', threadKey: 'task-m1', fields: { closed: false }, sourceRef: 'o' })], T2);
    expect(view(log.state(), 'm1')).toMatchObject({ closedAtSource: false, closedAtSourceAt: null });
  });

  it('H4 ThreadClaimed: 担当する・手放すで担当が変わり、ログに残る。名指しは変えない', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([draft('ThreadClaimed', { threadId: 't1', userId: 'u_alice', actorUserId: 'u_alice', reason: '持つ' })], T1);
    expect(view(log.state(), 't1')).toMatchObject({ ownerUserId: 'u_alice', assignee: { by: 'claim', userIds: ['u_alice'] }, triage: false });
    expect(listOf(log.state(), 't1')).toEqual(['u_alice', 'u_bob']);
    log.push([draft('ThreadClaimed', { threadId: 't1', userId: null, actorUserId: 'u_alice' })], T2);
    expect(view(log.state(), 't1')).toMatchObject({ ownerUserId: null, assignee: null, triage: true });
    expect(view(log.state(), 't1').log.map((l) => [l.kind, l.userId])).toEqual([['signal', undefined], ['claimed', 'u_alice'], ['claimed', null]]);
  });

  it('H1 ThreadLinked は無向: 1 つのイベントが両端に同じ辺を載せ、unlink で両端から外れる。リンク先の状態は読まない', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([taskThread('m1', '件'), note('n1', 'm1')], T0);
    log.push([draft('ThreadLinked', { a: 'm1', b: 't1', route: 'manual', actorUserId: 'u_alice', reason: 'この件' })], T1);
    let p = log.state();
    const edge = { route: 'manual', linkedAt: T1, actorUserId: 'u_alice' };
    expect(view(p, 'm1').links).toEqual([{ threadId: 't1', ...edge }]);
    expect(view(p, 't1').links).toEqual([{ threadId: 'm1', ...edge }]);
    // リンクしても名指しはそれぞれのまま
    expect(view(p, 'm1').attention).toEqual({ named: [], list: null });
    expect(listOf(p, 't1')).toEqual(['u_alice', 'u_bob']);
    log.push([draft('ThreadLinked', { a: 't1', b: 'm1', op: 'unlink', route: 'manual', actorUserId: 'u_alice' })], T2);
    p = log.state();
    expect(view(p, 'm1').links).toEqual([]);
    expect(view(p, 't1').links).toEqual([]);
    expect(view(p, 't1').log.map((l) => l.kind)).toEqual(['signal', 'linked', 'unlinked']);
    expect(() => fold([...log.events, { ...draft('ThreadLinked', { a: 't1', b: 't1', route: 'manual', actorUserId: 'u' }), seq: 99, at: T2 } as DomainEvent])).toThrow(/itself/);
    expect(() => fold([...log.events, { ...draft('ThreadLinked', { a: 't1', b: 'nope', route: 'manual', actorUserId: 'u' }), seq: 99, at: T2 } as DomainEvent])).toThrow(/unknown thread/);
  });

  it('H4 OutboundRecorded（新しい送信）でシグナルができ、SignalThreaded で置かれる。返事期待が載り、ReplyOverdue で超過、相手の名指しを外して解消', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([recorded('o1', false, T2), into('o1', 't1', null, 'human')], T1);
    let p = log.state();
    expect(directionOf(dir, p.signals.o1!)).toBe('outbound');
    expect(p.signals.o1).toMatchObject({ sourceRef: 'sent:<o1@x>', anchors: { messageId: '<o1@x>' }, recorded: { actorUserId: 'u_alice', replyExpectedBy: T2 } });
    expect(p.index.messageIds['ds_support|<o1@x>']).toBe('o1');
    expect(view(p, 't1')).toMatchObject({ awaiting: true, replyExpectedBy: T2, replyExpectedSignalId: 'o1', overdue: false });
    log.push([draft('ReplyOverdue', { threadId: 't1', signalId: 'o1', replyExpectedBy: T2 })], '2026-10-16T12:00:00.000Z');
    expect(view(log.state(), 't1').overdue).toBe(true);
    // 返事が来ただけでは解消しない
    log.push([observed('s2'), into('s2', 't1')], '2026-10-16T13:00:00.000Z');
    expect(view(log.state(), 't1')).toMatchObject({ overdue: true, awaiting: true });
    log.push(
      [draft('AttentionAcknowledged', { threadId: 't1', untilSignalId: 's2', addresses: [{ channel: 'email', value: 'carol@example.com' }], actorUserId: 'u_alice' })],
      '2026-10-16T13:10:00.000Z',
    );
    p = log.state();
    expect(view(p, 't1')).toMatchObject({ overdue: false, replyExpectedBy: null, awaiting: false });
  });

  it('H5 OutboundRecorded（merged）は観測された送信のシグナルに記録を重ねるだけで、シグナルも名指しも増えない', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    log.push([sent('o1'), into('o1', 't1', null)], T1);
    const before = view(log.state(), 't1');
    log.push([recorded('o1', true, T2)], '2026-10-16T10:30:00.000Z');
    const p = log.state();
    expect(view(p, 't1')).toMatchObject({ signalIds: before.signalIds, attention: before.attention, lastOutboundAt: T1, replyExpectedBy: T2 });
    expect(p.signals.o1!.recorded).toMatchObject({ replyExpectedBy: T2 });
    // 記録を重ねられるのは、まだ記録のないシグナルだけ
    expect(() => fold([...log.events, { ...recorded('o1', true, T2), seq: 99, at: T2 } as DomainEvent])).toThrow(/cannot merge/);
  });

  it('H9 ThreadMirrored: 決まった形の写しを source と件名に入れ（null は空）、closed でどの見え方にも数えず・返事期待の超過も消える。closed が外れたら綴じた分から戻る。属性には入れない（0031）', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    const mirrored = (fields: MirrorFields) =>
      draft('ThreadMirrored', { threadId: 't1', dataSourceId: 'ds_support', threadKey: 'UBS-1', fields, sourceRef: 'jira:UBS-1:x' });
    expect(view(log.state(), 't1').source).toBeNull();
    log.push([mirrored({ statusLabel: '進行中', holders: ['jira:alice'], closed: false, title: '雨漏りの修繕' })], T1);
    let t = view(log.state(), 't1');
    expect(t).toMatchObject({ title: '雨漏りの修繕', source: { holders: ['jira:alice'], statusLabel: '進行中', due: null }, closedAtSource: false });
    expect('attributes' in t).toBe(false);
    expect(t.log.at(-1)).toMatchObject({ kind: 'mirrored', fields: { statusLabel: '進行中', holders: ['jira:alice'], closed: false } });
    log.push([recorded('o1', false, T2), into('o1', 't1', null, 'human')], T1);
    log.push([draft('ReplyOverdue', { threadId: 't1', signalId: 'o1', replyExpectedBy: T2 })], '2026-10-16T12:00:00.000Z');
    expect(view(log.state(), 't1').overdue).toBe(true);
    log.push([mirrored({ statusLabel: '完了', holders: [], due: '2026-10-20', closed: true })], '2026-10-16T13:00:00.000Z');
    t = view(log.state(), 't1');
    expect(t).toMatchObject({ source: { holders: [], statusLabel: '完了', due: '2026-10-20' }, triage: false, awaiting: false, closedAtSource: true, overdue: false, dismissed: false });
    log.push([mirrored({ closed: false, statusLabel: null, due: null })], '2026-10-16T14:00:00.000Z');
    expect(view(log.state(), 't1')).toMatchObject({ source: { statusLabel: null, due: null }, closedAtSource: false, awaiting: true, overdue: true });
    expect(() => fold([...log.events, { ...mirrored({ closed: true }), payload: { ...mirrored({}).payload, dataSourceId: 'ds_line' }, seq: 99, at: T2 } as DomainEvent])).toThrow(
      /mirror of ds_line/,
    );
  });

  it('H1 名指しを持たない（0038 より前の）投影は古いとみなし、作り直しが要る', () => {
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    const p = log.state();
    expect(isStaleProjections(p)).toBe(false);
    const old = structuredClone(p) as Projections;
    delete (old.threads.t1 as Partial<(typeof old.threads)['t1']>).attention;
    expect(isStaleProjections(old)).toBe(true);
    // 0039 より前の投影（本人が付ける属性を持つ）も作り直す
    const withAttributes = structuredClone(p) as Projections;
    (withAttributes.threads.t1 as unknown as Record<string, unknown>).attributes = {};
    expect(isStaleProjections(withAttributes)).toBe(true);
  });

  it('H1 古い形のイベント（channel note のシグナル・ThreadAttributeSet）は読まない（0039。マイグレーション 0003 で消す）', () => {
    const old = { ...observed('s1'), payload: { ...observed('s1').payload, channel: 'note' } };
    expect(() => parseEvent({ seq: 1, at: T0, type: old.type, payload: old.payload })).toThrow();
    expect(() => parseEvent({ seq: 1, at: T0, type: 'ThreadAttributeSet', payload: { threadId: 't1', name: 'due', value: null, actorUserId: 'u' } })).toThrow();
  });

  it('H9 ThreadMirrored（created）: 写しでスレッドを作る。件名が要り、既にあるスレッドは作れない（0031 の 8）', () => {
    const create = (threadId: string, fields: MirrorFields) =>
      ({ ...draft('ThreadMirrored', { threadId, created: true, dataSourceId: 'ds_support', threadKey: 'UBS-7', fields, sourceRef: 'jira:UBS-7:c' }), seq: 1, at: T0 }) as DomainEvent;
    const p = fold([create('t7', { title: '鍵の交換', holders: ['jira:alice'], closed: true })]);
    expect(p.threads.t7).toMatchObject({ title: '鍵の交換', dataSourceId: 'ds_support', sourceKey: 'UBS-7', signalIds: [], closedAtSource: true, source: { holders: ['jira:alice'] } });
    expect(() => fold([create('t7', { holders: [] })])).toThrow(/has no title/);
    const log = new EventLog();
    log.push([observed('s1'), intoNew('s1', 't1')], T0);
    expect(() => fold([...log.events, { ...create('t1', { title: 'x' }), seq: 99 }])).toThrow(/already exists/);
  });
});

function recorded(signalId: string, merged: boolean, replyExpectedBy: string | null) {
  return draft('OutboundRecorded', {
    signalId,
    merged,
    dataSourceId: 'ds_support',
    channel: 'email',
    from: { channel: 'email', value: 'support@ubs.example' },
    to: [{ channel: 'email', value: 'carol@example.com' }],
    body: '調査します',
    sentRef: `<${signalId}@x>`,
    replyExpectedBy,
    actorUserId: 'u_alice',
  });
}


/** Alice のタスクのリストに、写しでタスクのスレッドを作る */
function taskThread(threadId: string, title: string) {
  return draft('ThreadMirrored', {
    threadId,
    created: true,
    dataSourceId: 'ds_tasks_alice',
    threadKey: `task-${threadId}`,
    fields: { title, holders: ['alice@ubs.example'] },
    sourceRef: `todo:${threadId}`,
  });
}

function note(noteId: string, threadId: string, author?: { kind: 'user' } | { kind: 'agent'; name: string }) {
  return draft('ThreadNoted', { noteId, threadId, body: '電話で聞いた', ...(author ? { author } : {}), actorUserId: 'u_alice' });
}
