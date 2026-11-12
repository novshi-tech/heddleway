import type { CoreContext } from './context';
import type { Directory } from './directory';
import { DomainError } from './errors';
import { draft, type AddressRef, type Author, type DraftEvent, type ThreadChoice } from './events';
import type { Projections, SignalRecord, Thread } from './projections';
import { addressKey, comparePos, isPending, sameAddress } from './comm';
import { isListAddress, isStatefulSource, isTaskSource, linkCandidates, listKindOf, pendingListSignalsFor, readerOfAddress } from './turn';
import { canReadDataSource, type Viewer } from './viewer';

// スタンド（＝ユーザー）が呼ぶ操作の判断部分。状態とコマンドを受けてイベントを返すだけの純関数。
// 操作できるのは、スレッドが見えている人（そのデータソースの読者）。

export function visibleThreadOrThrow(p: Projections, viewer: Viewer, threadId: string): Thread {
  const t = p.threads[threadId];
  if (!t || !canReadDataSource(viewer, t.dataSourceId)) {
    throw new DomainError('not_found', `thread ${threadId} not found`);
  }
  return t;
}

export function visibleSignalOrThrow(p: Projections, viewer: Viewer, signalId: string): SignalRecord {
  const s = p.signals[signalId];
  if (!s || !canReadDataSource(viewer, s.dataSourceId)) {
    throw new DomainError('not_found', `signal ${signalId} not found`);
  }
  return s;
}

// ---- 片付けと開き直し ----

/**
 * タスクのサービスのスレッドは、完了も開き直しもソースで付ける（写しの closed。0039 の決定 3）。
 * 写しが 1 度も届いていないスレッド（記録だけでできて、ソースのタスクに結び付かなかったもの。区切りの取り違えの残り）は、
 * ソースで閉じる手段がないので、片付け・開き直しを許す
 */
function refuseTask(dir: Directory, t: Thread): void {
  const ds = dir.dataSource(t.dataSourceId);
  if (isTaskSource(ds) && t.sourceKey != null) throw new DomainError('invalid', `thread ${t.id} is a task in ${ds?.name ?? t.dataSourceId}; complete or reopen it at the source`);
}

export function dismissThread(p: Projections, viewer: Viewer, dir: Directory, input: { threadId: string; reason: string }): DraftEvent[] {
  const t = visibleThreadOrThrow(p, viewer, input.threadId);
  refuseTask(dir, t);
  if (!input.reason.trim()) throw new DomainError('invalid', 'reason is required');
  if (t.dismissed) return [];
  return [draft('ThreadDismissed', { threadId: t.id, actorUserId: viewer.userId, reason: input.reason })];
}

export function reopenThread(p: Projections, viewer: Viewer, dir: Directory, input: { threadId: string; reason?: string }): DraftEvent[] {
  const t = visibleThreadOrThrow(p, viewer, input.threadId);
  refuseTask(dir, t);
  if (!t.dismissed) return [];
  return [draft('ThreadReopened', { threadId: t.id, actorUserId: viewer.userId, reason: input.reason })];
}

// ---- 直す操作: シグナルの移し替え ----

export type MoveTarget = { kind: 'existing'; threadId: string } | { kind: 'new'; title: string };

/**
 * シグナルを別のスレッド（同じデータソースの既存のスレッドか、新しいスレッド）へ移す。元の判断は消さない（追記）。
 * 「返事や対応を求めているか」は 0038 でやめた（名指しは宛先で決まる）
 */
export function moveSignal(
  p: Projections,
  viewer: Viewer,
  ctx: CoreContext,
  input: { signalId: string; to: MoveTarget; reason: string },
): { events: DraftEvent[]; threadId: string } {
  const sig = visibleSignalOrThrow(p, viewer, input.signalId);
  if (!input.reason.trim()) throw new DomainError('invalid', 'reason is required');

  let choice: ThreadChoice;
  if (input.to.kind === 'existing') {
    const t = p.threads[input.to.threadId];
    if (!t || t.dataSourceId !== sig.dataSourceId) {
      throw new DomainError('invalid', `signal ${sig.signalId} cannot move to thread ${input.to.threadId} (different data source)`);
    }
    choice = { kind: 'existing', threadId: t.id };
  } else {
    if (!input.to.title.trim()) throw new DomainError('invalid', 'title is required');
    choice = { kind: 'new', threadId: ctx.newId('thr'), title: input.to.title };
  }
  if (choice.kind === 'existing' && choice.threadId === sig.threadId) {
    return { events: [], threadId: choice.threadId };
  }
  return {
    threadId: choice.threadId,
    events: [
      draft('SignalThreaded', {
        signalId: sig.signalId,
        thread: choice,
        by: 'human',
        confidence: 1,
        reason: input.reason,
        actorUserId: viewer.userId,
      }),
    ],
  };
}

// ---- メモ（ThreadNoted。0039 の決定 2） ----

/**
 * スレッドにメモ（経過の記録）を書く。メモは人とスタンドがスレッドにする操作の 1 つで、中身を持つので、
 * 個人リスト（読者が本人 1 人）のスレッドにだけ書ける。共有リストのスレッドには書かない（事実と構造の操作だけ。0031 の決定 2）。
 * 共有の件を自分の側で追うなら、タスクのサービスのタスクを作って結び、そのスレッドに書く
 */
export function addNote(
  p: Projections,
  viewer: Viewer,
  ctx: CoreContext,
  input: { threadId: string; body: string; author?: Author },
): { events: DraftEvent[]; noteId: string } {
  if (!input.body.trim()) throw new DomainError('invalid', 'body is required');
  const t = visibleThreadOrThrow(p, viewer, input.threadId);
  if (listKindOf(ctx.dir, t.dataSourceId) !== 'personal') {
    throw new DomainError('invalid', `thread ${t.id} is in a shared list; write notes on a thread in your personal list (e.g. a task linked to it)`);
  }
  const noteId = ctx.newId('note');
  return {
    noteId,
    events: [draft('ThreadNoted', { noteId, threadId: t.id, body: input.body, author: input.author ?? { kind: 'user' }, actorUserId: viewer.userId })],
  };
}

// ---- 持ち主（ThreadClaimed） ----

/**
 * 担当する・手放す（userId: null）・引き継ぐ（0038 の決定 1）。担当できるのはそのデータソースの読者だけ。
 * 状態を持つソース（Jira・PR・タスクのサービス）の担当はソースの担当者なので断る（担当はソースで移す）。
 * 個人リスト（個人の箱・タスクのリスト）は本人が暗黙の担当なので断る
 */
export function claimThread(
  p: Projections,
  viewer: Viewer,
  dir: Directory,
  input: { threadId: string; userId: string | null; reason?: string },
): DraftEvent[] {
  const t = visibleThreadOrThrow(p, viewer, input.threadId);
  const ds = dir.dataSource(t.dataSourceId);
  if (isStatefulSource(ds)) throw new DomainError('invalid', `the assignee of thread ${t.id} is mirrored from ${ds?.name ?? t.dataSourceId}; change it at the source`);
  if (listKindOf(dir, t.dataSourceId) === 'personal') throw new DomainError('invalid', `thread ${t.id} is in a personal list; its reader is the assignee`);
  if (input.userId !== null) {
    const list = dir.listOfDataSource(t.dataSourceId);
    const readers = list ? dir.readersOfList(list.id) : [];
    if (!readers.includes(input.userId)) {
      throw new DomainError('invalid', `user ${input.userId} is not a reader of data source ${t.dataSourceId}`);
    }
  }
  if (t.ownerUserId === input.userId) return [];
  return [draft('ThreadClaimed', { threadId: t.id, userId: input.userId, actorUserId: viewer.userId, reason: input.reason })];
}

// ---- 名指しを外す（AttentionAcknowledged。0038 の決定 3・4） ----

/**
 * 名指しを外す。untilSignalId（省けばスレッドの最新のシグナル）までの名指しを外す。
 * - addresses を省けば、自分への名指し（自分のアドレスと、リスト宛て）を外す
 * - addresses を渡せば、そのアドレスの名指しを外す。自分のアドレスか、このリストの読者でないアドレスだけ。
 *   リスト宛てのアドレス（窓口）は、自分についてのリスト宛てとして外す
 * 外すものがなければ何もしない
 */
export function acknowledgeAttention(
  p: Projections,
  viewer: Viewer,
  dir: Directory,
  input: { threadId: string; untilSignalId?: string; addresses?: AddressRef[]; reason?: string },
): DraftEvent[] {
  const t = visibleThreadOrThrow(p, viewer, input.threadId);
  const ds = dir.dataSource(t.dataSourceId);
  const signals = t.log.filter((l) => l.kind === 'signal');
  const until = input.untilSignalId ? signals.find((l) => l.signalId === input.untilSignalId) : signals[signals.length - 1];
  if (input.untilSignalId && !until) throw new DomainError('invalid', `signal ${input.untilSignalId} is not in thread ${t.id}`);
  if (!until) return [];
  const upTo = (pos: { at: string; seq: number }) => comparePos(pos, until) <= 0;

  const addresses: AddressRef[] = [];
  let list = false;
  const pendingNamed = t.attention.named.filter((n) => isPending(n) && upTo(n.last));
  if (input.addresses === undefined) {
    for (const n of pendingNamed) {
      if (!isListAddress(ds, n.address) && readerOfAddress(dir, t.dataSourceId, n.address, n.last.at) === viewer.userId) addresses.push(n.address);
    }
    // リスト宛て: 外した位置より後の、自分以外が送ったリスト宛てのシグナルがあるときだけ
    list = pendingListSignalsFor(dir, t, viewer.userId).some((x) => upTo(x));
  } else {
    for (const r of input.addresses) {
      if (isListAddress(ds, r)) {
        list = true;
        continue;
      }
      const n = t.attention.named.find((x) => addressKey(x.address) === addressKey(r));
      if (!n) throw new DomainError('invalid', `${r.channel}:${r.value} is not named in thread ${t.id}`);
      const owner = readerOfAddress(dir, t.dataSourceId, r, n.last.at);
      if (owner !== null && owner !== viewer.userId) {
        throw new DomainError('forbidden', `${r.channel}:${r.value} belongs to reader ${owner}; only that reader can acknowledge it`);
      }
      if (isPending(n) && upTo(n.last) && !addresses.some((a) => sameAddress(a, r))) addresses.push(n.address);
    }
  }
  if (list) {
    const acked = t.attention.listAcks[viewer.userId];
    if (acked && comparePos(acked, until) >= 0) list = false;
  }
  if (addresses.length === 0 && !list) return [];
  return [
    draft('AttentionAcknowledged', {
      threadId: t.id,
      untilSignalId: until.signalId!,
      addresses,
      list,
      actorUserId: viewer.userId,
      reason: input.reason,
    }),
  ];
}

// ---- リンク（ThreadLinked） ----

/**
 * スレッドを結ぶ。両端とも見えている必要がある。経路は、結び候補（アンカーの一致）から張れば anchor、
 * そうでなければ manual（sent は record_sent の副作用だけ）。結び済みなら何もしない
 */
export function linkThreads(
  p: Projections,
  viewer: Viewer,
  input: { threadId: string; otherThreadId: string; reason?: string },
): DraftEvent[] {
  const a = visibleThreadOrThrow(p, viewer, input.threadId);
  const b = visibleThreadOrThrow(p, viewer, input.otherThreadId);
  if (a.id === b.id) throw new DomainError('invalid', 'cannot link a thread to itself');
  if (a.links.some((l) => l.threadId === b.id)) return [];
  const route = linkCandidates(viewer, p, a).some((c) => c.threadId === b.id) ? 'anchor' : 'manual';
  return [draft('ThreadLinked', { a: a.id, b: b.id, op: 'link', route, actorUserId: viewer.userId, reason: input.reason })];
}

/** リンクを外す。両端とも読める必要がある（見えない辺は結んでいないのと同じ扱い。0033 の 3） */
export function unlinkThreads(
  p: Projections,
  viewer: Viewer,
  input: { threadId: string; otherThreadId: string; reason?: string },
): DraftEvent[] {
  const a = visibleThreadOrThrow(p, viewer, input.threadId);
  const link = a.links.find((l) => l.threadId === input.otherThreadId);
  const other = link ? p.threads[link.threadId] : undefined;
  if (!link || !other || !canReadDataSource(viewer, other.dataSourceId)) return [];
  return [draft('ThreadLinked', { a: a.id, b: link.threadId, op: 'unlink', route: link.route, actorUserId: viewer.userId, reason: input.reason })];
}
