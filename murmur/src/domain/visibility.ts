import type { Directory } from './directory';
import type { DataSource } from './entities';
import type { AddressRef, Author, MirrorFields } from './events';
import { sortLog } from './comm';
import type { Projections, SignalRecord, SourceState, Thread, ThreadLink, ThreadLogEntry } from './projections';
import { commView, directionOf } from './sides';
import {
  assigneeOf,
  attentionOf,
  derivedBall,
  isAwaiting,
  isMyTurn,
  isTaskSource,
  isTriage,
  linkCandidates,
  linkedActiveSinceDismissed,
  listKindOf,
  myTurnOf,
  replyStateOf,
  type Assignee,
  type Attention,
  type DerivedBall,
  type LinkCandidate,
  type MyTurnReason,
} from './turn';
import { canReadDataSource, type Viewer } from './viewer';

// クエリ層の可視性。投影のスナップショットと Viewer から「見えるもの」だけを返す純関数。
// - リストの読者には、そのデータソースのスレッドの生の中身と、そこに書いたメモが見える（メモを書けるのは個人リストだけ。0039）
// - 持ち主はスレッドの側にあるので、スレッドが見える人に見える。リンクは両端を読める人にだけ見える（0033 の 3）
// - Contact のない User は 0 件、ゴースト Contact は Viewer になれない

/**
 * - my_turn: Viewer の番（自分が担当・自分への名指し・リスト宛ての名指しが残っている。0038）で、開いているもの
 * - mine: Viewer のタスク（個人リストのタスクのサービスのスレッド。閉じたものも。0039）
 * - open: 開いているもの（片付けていない・ソースで完了していない）
 * - awaiting: 相手待ち（読者でないアドレスへの名指しが残っている）で、開いているもの
 * - overdue: 返事期待の期限を過ぎたもの
 * - triage: 仕分け待ち（共有リストで、開いていて、担当がいない）
 * - all: 全部
 *
 * since を渡せば、それより後に動いたものだけ（スレッド自身か、見えるリンク先の updatedAt。タスクの導出したボールはリンク先で変わるため）
 */
export type ThreadFilter = 'my_turn' | 'mine' | 'open' | 'awaiting' | 'overdue' | 'triage' | 'all';

export interface ThreadSummary {
  id: string;
  dataSourceId: string;
  title: string;
  /** 担当（0038 の決定 1）。個人リストと、担当のいないスレッドは null */
  assignee: Assignee | null;
  /** 残っている名指し（0038 の決定 2〜4） */
  attention: Attention;
  /** 仕分け待ち（共有リストで、開いていて、担当がいない） */
  triage: boolean;
  /** 相手待ち（読者でないアドレスへの名指しが残っている） */
  awaiting: boolean;
  counterpartContactIds: string[];
  /** 相手のうち、Contact に解決できなかったアドレス（0030） */
  counterpartAddresses: AddressRef[];
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  dismissed: boolean;
  dismissReason: string | null;
  activeSinceDismissed: boolean;
  replyExpectedBy: string | null;
  overdue: boolean;
  closedAtSource: boolean;
  links: ThreadLink[];
  source: SourceState | null;
  signalCount: number;
  updatedAt: string;
}

/** 一覧と詳細で返すスレッド。投影の要約に、Viewer から見たもの（自分の番か・リンク先から導出したボール・結び候補）を足す */
export interface ThreadItem extends ThreadSummary {
  /** 自分か、見える結んだ先のうち一番新しい更新（一覧の並び。0031 の 5） */
  lastActivityAt: string;
  /** Viewer の番の理由（担当・名指し・リスト宛て）。空なら Viewer の番ではない */
  myTurn: MyTurnReason[];
  derivedBall: DerivedBall | null;
  /** 閉じたスレッドに結ばれた先で、閉じたあとにシグナルが来た */
  linkedActiveSinceDismissed: boolean;
  linkCandidates: LinkCandidate[];
}

export function summarizeThread(dir: Directory, p: Projections, t: Thread): ThreadSummary {
  const comm = commView(dir, t);
  return {
    id: t.id,
    dataSourceId: t.dataSourceId,
    title: t.title,
    assignee: assigneeOf(dir, t),
    attention: attentionOf(dir, t),
    triage: isTriage(dir, t),
    awaiting: isAwaiting(dir, t),
    counterpartContactIds: comm.counterpartContactIds,
    counterpartAddresses: comm.counterpartAddresses,
    lastInboundAt: comm.lastInboundAt,
    lastOutboundAt: comm.lastOutboundAt,
    dismissed: t.dismissed,
    dismissReason: t.dismissReason,
    activeSinceDismissed: t.activeSinceDismissed,
    ...replyStateOf(dir, t),
    closedAtSource: t.closedAtSource,
    links: t.links,
    source: t.source,
    signalCount: t.signalIds.length,
    updatedAt: t.updatedAt,
  };
}

/**
 * Viewer に見えるリンク。両端のスレッドを読めるもの（相手のデータソースのリストの読者であること）だけ（0033 の 3）。
 * 見えない辺は、あることも含めて出さない
 */
export function visibleLinks(viewer: Viewer, p: Projections, t: Thread): ThreadLink[] {
  return t.links.filter((l) => {
    const u = p.threads[l.threadId];
    return u !== undefined && canReadDataSource(viewer, u.dataSourceId);
  });
}

export function threadItem(dir: Directory, viewer: Viewer, p: Projections, t: Thread): ThreadItem {
  return {
    ...summarizeThread(dir, p, t),
    links: visibleLinks(viewer, p, t),
    lastActivityAt: lastActivityAt(viewer, p, t),
    myTurn: myTurnOf(dir, viewer, t),
    derivedBall: derivedBall(dir, viewer, p, t),
    linkedActiveSinceDismissed: linkedActiveSinceDismissed(viewer, p, t),
    linkCandidates: linkCandidates(viewer, p, t),
  };
}

/** Viewer に見えるスレッド（読者になっているデータソースのもの） */
export function listThreads(
  dir: Directory,
  viewer: Viewer,
  p: Projections,
  opts: { filter?: ThreadFilter; dataSourceId?: string; since?: string } = {},
): ThreadItem[] {
  const filter = opts.filter ?? 'open';
  const out: ThreadItem[] = [];
  for (const t of Object.values(p.threads)) {
    if (!canReadDataSource(viewer, t.dataSourceId)) continue;
    if (opts.dataSourceId && t.dataSourceId !== opts.dataSourceId) continue;
    if (filter === 'open' && (t.dismissed || t.closedAtSource)) continue;
    if (filter === 'triage' && !isTriage(dir, t)) continue;
    if (filter === 'awaiting' && !isAwaiting(dir, t)) continue;
    if (filter === 'overdue' && !replyStateOf(dir, t).overdue) continue;
    if (filter === 'my_turn' && !isMyTurn(dir, viewer, t)) continue;
    if (filter === 'mine' && !(isTaskSource(dir.dataSource(t.dataSourceId)) && listKindOf(dir, t.dataSourceId) === 'personal')) continue;
    if (opts.since !== undefined && !movedSince(viewer, p, t, opts.since)) continue;
    out.push(threadItem(dir, viewer, p, t));
  }
  return out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : a.id < b.id ? -1 : 1));
}

/**
 * 自分か、見える結んだ先のうち一番新しい更新（0031 の 5）。結んだ PR にレビューが返れば、メモにだれも書く前でもタスクが上に来る。
 * fold は 1 段のまま（0014）、クエリ層で合わせる
 */
export function lastActivityAt(viewer: Viewer, p: Projections, t: Thread): string {
  let at = t.updatedAt;
  for (const l of t.links) {
    const u = p.threads[l.threadId];
    if (u && canReadDataSource(viewer, u.dataSourceId) && u.updatedAt > at) at = u.updatedAt;
  }
  return at;
}

function movedSince(viewer: Viewer, p: Projections, t: Thread, since: string): boolean {
  return lastActivityAt(viewer, p, t) > since;
}

export type SignalView = { direction: 'inbound' | 'outbound' } & Pick<
  SignalRecord,
  'signalId' | 'channel' | 'from' | 'to' | 'subject' | 'body' | 'attachments' | 'anchors' | 'at' | 'threadedBy' | 'recorded'
>;

function signalView(dir: Directory, s: SignalRecord): SignalView {
  return {
    signalId: s.signalId,
    direction: directionOf(dir, s),
    channel: s.channel,
    from: s.from,
    to: s.to,
    subject: s.subject,
    body: s.body,
    attachments: s.attachments,
    anchors: s.anchors,
    at: s.at,
    threadedBy: s.threadedBy,
    recorded: s.recorded,
  };
}

export interface TimelineEntry {
  at: string;
  /** どのスレッドに綴じたものか（このスレッドか、結んだ先のスレッド） */
  threadId: string;
  kind: ThreadLogEntry['kind'];
  signal?: SignalView;
  /** note: メモ（0039 の決定 2） */
  note?: { noteId: string; body: string; author: Author };
  reason?: string;
  actorUserId?: string;
  userId?: string | null;
  otherThreadId?: string;
  route?: ThreadLogEntry['route'];
  fields?: MirrorFields;
  replyExpectedBy?: string | null;
  /** acknowledged: 外したアドレス・リスト宛てか・どのシグナルまでか */
  addresses?: AddressRef[];
  list?: boolean;
  untilSignalId?: string;
}

/** 結んだ先。両端を読めるものだけ返す（0033 の 3）。visible は互換のために残し、いつも true */
export interface LinkView extends ThreadLink {
  visible: true;
  title: string;
  dataSourceId: string;
  /** Viewer の番の理由（空なら Viewer の番ではない） */
  myTurn: MyTurnReason[];
  awaiting: boolean;
  dismissed: boolean;
}

export interface ThreadView {
  thread: ThreadItem;
  dataSource: { id: string; name: string; kind: DataSource['kind']; channel: string };
  linked: LinkView[];
  /**
   * 時刻順のタイムライン: このスレッドに綴じたもの（シグナル・メモ・操作）と、結んだ先のうち見えるスレッドのシグナル。
   * since を渡せば、それより後のものだけ
   */
  timeline: TimelineEntry[];
}

export function getThreadView(
  dir: Directory,
  viewer: Viewer,
  p: Projections,
  threadId: string,
  opts: { since?: string } = {},
): ThreadView | null {
  const t = p.threads[threadId];
  if (!t || !canReadDataSource(viewer, t.dataSourceId)) return null;
  const ds = dir.dataSource(t.dataSourceId);
  const linked: LinkView[] = visibleLinks(viewer, p, t).map((l) => {
    const u = p.threads[l.threadId]!;
    return {
      ...l,
      visible: true,
      title: u.title,
      dataSourceId: u.dataSourceId,
      myTurn: myTurnOf(dir, viewer, u),
      awaiting: isAwaiting(dir, u),
      dismissed: u.dismissed,
    };
  });
  // 見えないスレッドとの「結んだ・外した」は出さない（0033 の 3）
  const readable = (id: string) => {
    const u = p.threads[id];
    return u !== undefined && canReadDataSource(viewer, u.dataSourceId);
  };
  const entries: (ThreadLogEntry & { threadId: string })[] = t.log
    .filter((l) => (l.kind !== 'linked' && l.kind !== 'unlinked') || l.otherThreadId === undefined || readable(l.otherThreadId))
    .map((l) => ({ ...l, threadId: t.id }));
  for (const l of linked) {
    for (const e of p.threads[l.threadId]!.log) if (e.kind === 'signal' || e.kind === 'note') entries.push({ ...e, threadId: l.threadId });
  }
  const timeline = sortLog(entries)
    .filter((e) => opts.since === undefined || e.at > opts.since)
    .map((e) => {
      const entry: TimelineEntry = { at: e.at, threadId: e.threadId, kind: e.kind };
      if (e.signalId) entry.signal = signalView(dir, p.signals[e.signalId]!);
      if (e.reason !== undefined) entry.reason = e.reason;
      if (e.actorUserId !== undefined) entry.actorUserId = e.actorUserId;
      if (e.userId !== undefined) entry.userId = e.userId;
      if (e.otherThreadId !== undefined) entry.otherThreadId = e.otherThreadId;
      if (e.route !== undefined) entry.route = e.route;
      if (e.kind === 'note') entry.note = { noteId: e.noteId!, body: e.body!, author: e.author ?? { kind: 'user' } };
      if (e.fields !== undefined) entry.fields = e.fields;
      if (e.kind === 'overdue' && e.replyExpectedBy !== undefined) entry.replyExpectedBy = e.replyExpectedBy;
      if (e.kind === 'acknowledged') {
        entry.addresses = e.addresses ?? [];
        entry.list = e.list ?? false;
        if (e.untilSignalId !== undefined) entry.untilSignalId = e.untilSignalId;
      }
      return entry;
    });
  return {
    thread: threadItem(dir, viewer, p, t),
    dataSource: { id: t.dataSourceId, name: ds?.name ?? t.dataSourceId, kind: ds?.kind ?? 'service', channel: ds?.channel ?? '' },
    linked,
    timeline,
  };
}

/** Viewer が生ペイロードを読めるシグナル（読者になっているデータソースのものだけ） */
export function visibleSignals(viewer: Viewer, p: Projections): SignalRecord[] {
  return Object.values(p.signals).filter((s) => canReadDataSource(viewer, s.dataSourceId));
}

export interface ListView {
  id: string;
  dataSource: { id: string; kind: DataSource['kind']; name: string; description: string; channel: string };
  /** 読者（User）と、その Contact（あれば） */
  readers: { userId: string; name: string; contactId: string | null }[];
}

/** 見えるリストの一覧（list_lists） */
export function listLists(dir: Directory, viewer: Viewer): ListView[] {
  return viewer.listIds.map((id) => getListView(dir, viewer, id)).filter((v): v is ListView => v !== null);
}

export function getListView(dir: Directory, viewer: Viewer, listId: string): ListView | null {
  const list = dir.list(listId);
  const ds = list ? dir.dataSource(list.dataSourceId) : undefined;
  if (!list || !ds || !canReadDataSource(viewer, ds.id)) return null;
  return {
    id: list.id,
    dataSource: { id: ds.id, kind: ds.kind, name: ds.name, description: ds.description, channel: ds.channel },
    readers: dir.readersOfList(list.id).map((u) => {
      const c = dir.contactOfUser(u);
      return { userId: u, name: c?.name ?? dir.user(u)?.name ?? u, contactId: c?.id ?? null };
    }),
  };
}
