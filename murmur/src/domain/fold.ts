import { deriveComm, sortLog } from './comm';
import type { DomainEvent, PayloadOf } from './events';
import { emptyProjections, indexKey, type ProjectionChanges, type Projections, type SignalRecord, type Thread } from './projections';

/**
 * 畳み込み。IO を持たない純関数で、入力の state は変更しない。
 * `fold(events)` でいつでも投影をイベントから作り直せる（H1）。
 * fold は 1 段（0014）: スレッドの投影はそのスレッドのイベントとリンクのイベントだけから決まり、
 * リンク先の状態は読まない（リンク先と合わせるのはクエリ層）。
 */
export function fold(events: readonly DomainEvent[], base?: Projections): Projections {
  return foldChanges(events, base).projections;
}

/** fold と同じ。あわせて、base から変わったスレッドとシグナルを返す（投影を差分だけ保存するため、0021） */
export function foldChanges(events: readonly DomainEvent[], base?: Projections): { projections: Projections; changes: ProjectionChanges } {
  const state: Projections = base ? structuredClone(base) : emptyProjections();
  const c: Changes = { threads: new Set(), signals: new Set(), index: false };
  for (const e of events) apply(state, e, c);
  return { projections: state, changes: { threadIds: [...c.threads].sort(), signalIds: [...c.signals].sort(), index: c.index } };
}

export class FoldError extends Error {}

/**
 * 保存された投影の形が今の fold と違うか（作り直しが要るか）。投影はいつでもイベントから作り直せる（H1）。
 * 0038 で、スレッドに名指し（attention）を足し、ボールをやめた。0039 で、本人が付ける属性（attributes）をやめた
 */
export function isStaleProjections(p: Projections): boolean {
  return Object.values(p.threads).some((t) => (t as Partial<Thread>).attention === undefined || 'attributes' in t);
}

/** fold の途中で書き換えたもの。スレッドは recompute、シグナルは addSignal・置き先・記録の統合で書き換わる */
interface Changes {
  threads: Set<string>;
  signals: Set<string>;
  index: boolean;
}

function apply(s: Projections, e: DomainEvent, c: Changes): void {
  if (e.seq <= s.lastSeq) throw new FoldError(`non-monotonic seq ${e.seq} after ${s.lastSeq}`);
  s.lastSeq = e.seq;

  switch (e.type) {
    case 'SignalObserved':
      return onSignal(s, e, c);
    case 'SignalThreaded':
      return onThreaded(s, e, e.payload, c);
    case 'ThreadDismissed':
    case 'ThreadReopened': {
      const t = mustThread(s, e.payload.threadId);
      t.log.push({
        seq: e.seq,
        at: e.at,
        kind: e.type === 'ThreadDismissed' ? 'dismissed' : 'reopened',
        reason: e.payload.reason,
        actorUserId: e.payload.actorUserId,
      });
      recompute(s, t, e.at, c);
      return;
    }
    case 'ThreadClaimed': {
      const t = mustThread(s, e.payload.threadId);
      t.log.push({ seq: e.seq, at: e.at, kind: 'claimed', userId: e.payload.userId, actorUserId: e.payload.actorUserId, reason: e.payload.reason });
      recompute(s, t, e.at, c);
      return;
    }
    case 'ThreadLinked':
      return onLinked(s, e, e.payload, c);
    case 'OutboundRecorded':
      return onRecorded(s, e, e.payload, c);
    case 'ReplyOverdue': {
      const t = mustThread(s, e.payload.threadId);
      t.log.push({ seq: e.seq, at: e.at, kind: 'overdue', signalId: e.payload.signalId, replyExpectedBy: e.payload.replyExpectedBy });
      recompute(s, t, e.at, c);
      return;
    }
    case 'ThreadMirrored': {
      const p = e.payload;
      if (p.created) {
        if (s.threads[p.threadId]) throw new FoldError(`thread ${p.threadId} already exists`);
        if (p.fields.title === undefined) throw new FoldError(`mirror creating thread ${p.threadId} has no title`);
        s.threads[p.threadId] = newThread(p.threadId, p.dataSourceId, p.fields.title, e.at);
      }
      const t = mustThread(s, p.threadId);
      if (t.dataSourceId !== p.dataSourceId) throw new FoldError(`mirror of ${p.dataSourceId} cannot go into thread ${t.id} (${t.dataSourceId})`);
      const f = p.fields;
      const src = (t.source ??= { holders: [], statusLabel: null, due: null });
      if (f.holders !== undefined) src.holders = [...f.holders];
      if (f.statusLabel !== undefined) src.statusLabel = f.statusLabel;
      if (f.due !== undefined) src.due = f.due;
      if (f.title !== undefined) t.title = f.title;
      t.sourceKey = p.threadKey;
      t.log.push({ seq: e.seq, at: e.at, kind: 'mirrored', fields: p.fields });
      recompute(s, t, e.at, c);
      return;
    }
    case 'AttentionAcknowledged': {
      const p = e.payload;
      const t = mustThread(s, p.threadId);
      // 外した位置は、外したときのシグナルの位置で固定する（あとで移し替えても、手前の名指しは外れたまま）
      const until = s.signals[p.untilSignalId];
      t.log.push({
        seq: e.seq,
        at: e.at,
        kind: 'acknowledged',
        ...(until ? { untilAt: until.at, untilSeq: until.seq } : {}),
        addresses: p.addresses,
        list: p.list,
        untilSignalId: p.untilSignalId,
        actorUserId: p.actorUserId,
        reason: p.reason,
      });
      recompute(s, t, e.at, c);
      return;
    }
    case 'ThreadNoted': {
      const p = e.payload;
      const t = mustThread(s, p.threadId);
      t.log.push({ seq: e.seq, at: e.at, kind: 'note', noteId: p.noteId, body: p.body, author: p.author, actorUserId: p.actorUserId });
      recompute(s, t, e.at, c);
      return;
    }
  }
}

/** 無向の辺を両端に載せる（外すときは両端から外す） */
function onLinked(s: Projections, e: DomainEvent, p: PayloadOf<'ThreadLinked'>, c: Changes): void {
  if (p.a === p.b) throw new FoldError(`thread ${p.a} cannot link to itself`);
  const ends: [Thread, string][] = [
    [mustThread(s, p.a), p.b],
    [mustThread(s, p.b), p.a],
  ];
  for (const [t, other] of ends) {
    t.links = t.links.filter((l) => l.threadId !== other);
    if (p.op === 'link') {
      t.links.push({ threadId: other, route: p.route, linkedAt: e.at, actorUserId: p.actorUserId });
      t.links.sort((x, y) => (x.threadId < y.threadId ? -1 : x.threadId > y.threadId ? 1 : 0));
    }
    t.log.push({
      seq: e.seq,
      at: e.at,
      kind: p.op === 'link' ? 'linked' : 'unlinked',
      otherThreadId: other,
      route: p.route,
      actorUserId: p.actorUserId,
      reason: p.reason,
    });
    recompute(s, t, e.at, c);
  }
}

function onSignal(s: Projections, e: Extract<DomainEvent, { type: 'SignalObserved' }>, c: Changes): void {
  addSignal(s, e, { ...e.payload, recorded: null }, c);
}

/**
 * 送信の記録。新しい送信ならシグナルを作り（置き先は続く SignalThreaded）、観測が先に届いていれば
 * そのシグナルに記録を重ねる（シグナルは 1 本のまま。返事期待だけがスレッドに載る）
 */
function onRecorded(s: Projections, e: DomainEvent, p: PayloadOf<'OutboundRecorded'>, c: Changes): void {
  const recorded = { actorUserId: p.actorUserId, at: e.at, replyExpectedBy: p.replyExpectedBy, sourceThreadId: p.sourceThreadId };
  if (!p.merged) {
    addSignal(s, e, {
      ...p,
      attachments: [],
      anchors: { ...p.anchors, messageId: p.sentRef },
      sourceRef: `sent:${p.sentRef}`,
      recorded,
    }, c);
    return;
  }
  const sig = s.signals[p.signalId];
  if (!sig || sig.recorded) throw new FoldError(`cannot merge record into signal ${p.signalId}`);
  sig.recorded = recorded;
  c.signals.add(sig.signalId);
  const t = sig.threadId ? s.threads[sig.threadId] : undefined;
  const entry = t?.log.find((l) => l.signalId === sig.signalId && l.kind === 'signal');
  if (t && entry) {
    entry.replyExpectedBy = p.replyExpectedBy;
    recompute(s, t, e.at, c);
  }
}

type NewSignal = Omit<SignalRecord, 'at' | 'seq' | 'threadId' | 'threadedBy'>;

function addSignal(s: Projections, e: DomainEvent, p: NewSignal, c: Changes): void {
  const record: SignalRecord = {
    signalId: p.signalId,
    dataSourceId: p.dataSourceId,
    channel: p.channel,
    from: p.from,
    to: p.to,
    subject: p.subject,
    body: p.body,
    anchors: p.anchors,
    attachments: p.attachments,
    sourceRef: p.sourceRef,
    recorded: p.recorded,
    at: e.at,
    seq: e.seq,
    threadId: null,
    threadedBy: null,
  };
  s.signals[p.signalId] = record;
  s.index.sourceRefs[indexKey(p.dataSourceId, p.sourceRef)] = p.signalId;
  if (p.anchors.messageId) s.index.messageIds[indexKey(p.dataSourceId, p.anchors.messageId)] = p.signalId;
  c.signals.add(p.signalId);
  c.index = true;
}

function onThreaded(s: Projections, e: DomainEvent, p: PayloadOf<'SignalThreaded'>, c: Changes): void {
  const sig = s.signals[p.signalId];
  if (!sig) throw new FoldError(`unknown signal ${p.signalId}`);

  // 移し替え: 以前のスレッドから外す（元の判断イベントは残る）
  if (sig.threadId) {
    const prev = mustThread(s, sig.threadId);
    prev.signalIds = prev.signalIds.filter((id) => id !== sig.signalId);
    prev.log = prev.log.filter((l) => l.signalId !== sig.signalId);
    recompute(s, prev, e.at, c);
  }

  const choice = p.thread;
  if (choice.kind === 'new') {
    if (s.threads[choice.threadId]) throw new FoldError(`thread ${choice.threadId} already exists`);
    s.threads[choice.threadId] = newThread(choice.threadId, sig.dataSourceId, choice.title, sig.at);
  }
  const t = mustThread(s, choice.threadId);
  if (t.dataSourceId !== sig.dataSourceId) {
    throw new FoldError(`signal ${sig.signalId} (${sig.dataSourceId}) cannot go into thread ${t.id} (${t.dataSourceId})`);
  }
  sig.threadId = t.id;
  sig.threadedBy = p.by;
  c.signals.add(sig.signalId);
  t.log.push({
    seq: sig.seq,
    at: sig.at,
    kind: 'signal',
    signalId: sig.signalId,
    from: sig.from,
    to: sig.to,
    replyExpectedBy: sig.recorded?.replyExpectedBy ?? undefined,
  });
  recompute(s, t, e.at, c);
}

function recompute(s: Projections, t: Thread, at: string, c: Changes): void {
  c.threads.add(t.id);
  t.log = sortLog(t.log);
  t.signalIds = t.log.filter((l) => l.kind === 'signal').map((l) => l.signalId!);
  Object.assign(t, deriveComm(t.log));
  if (at > t.updatedAt) t.updatedAt = at;
}

function newThread(id: string, dataSourceId: string, title: string, at: string): Thread {
  return {
    id,
    dataSourceId,
    title,
    signalIds: [],
    log: [],
    links: [],
    source: null,
    sourceKey: null,
    createdAt: at,
    updatedAt: at,
    ...deriveComm([]),
  };
}

function mustThread(s: Projections, id: string): Thread {
  const t = s.threads[id];
  if (!t) throw new FoldError(`unknown thread ${id}`);
  return t;
}
