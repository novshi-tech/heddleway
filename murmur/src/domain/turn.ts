import { comparePos, isPending, sameAddress } from './comm';
import type { Directory } from './directory';
import type { DataSource } from './entities';
import type { AddressRef } from './events';
import type { LogPos, Naming, Projections, Thread } from './projections';
import { isOurs } from './sides';
import { canReadDataSource, type Viewer } from './viewer';

// クエリ層の「誰の番か」（0038）と結び（0014 の 3）。投影のスナップショットとマスタから計算する純関数で、
// fold には持ち込まない（fold は 1 段）。Murmur は候補を出すだけで、自分ではリンクを張らない。
//
// 誰の番は 2 つの軸で決まる（0038）:
// - 担当: 誰がタスクを進めるか。出所はデータソースの種類で 1 つ（状態を持つソースは写しの holders、それ以外の共有リストは担当する操作）
// - 名指し: 誰に読んでほしいか。シグナルの宛先から溜まり、明示的な操作（acknowledge）だけで外れる
// マスタで決めるのは「このリストの読者のアドレスか」「リスト宛てか」だけ。相手の Contact は名前を出すためだけに使い、番の種類は変えない

/** リストの種類。個人リストは読者が本人 1 人（個人の資格情報の箱・タスクのリスト）。ほかは共有リスト（0037・0039） */
export type ListKind = 'personal' | 'shared';

export function listKindOf(dir: Directory, dataSourceId: string): ListKind {
  const ds = dir.dataSource(dataSourceId);
  if (!ds) return 'personal';
  if (ds.shared) return 'shared';
  return dir.credentialRef(ds.credentialRefId)?.principal.kind === 'user' ? 'personal' : 'shared';
}

/** 状態を持つソース（課題のトラッカー・PR・タスクのサービス）。担当はソースの担当者で、Murmur では担当しない（0038 の決定 1・0039 の決定 3） */
export function isStatefulSource(ds: DataSource | undefined): boolean {
  return ds?.kind === 'service' && (ds.channel === 'jira' || ds.channel === 'bitbucket' || ds.channel === 'todo');
}

/** タスクのサービス（To Do・Google Tasks）。個人リストで、状態を持つソース。完了はソースで付ける（0039 の決定 3） */
export function isTaskSource(ds: DataSource | undefined): boolean {
  return ds?.kind === 'service' && ds.channel === 'todo';
}

/** そのアドレスがリストの読者のものなら、その User（読者がそのリストで名乗ったアドレス。0030 の決定 7・0038 の決定 4） */
export function readerOfAddress(dir: Directory, dataSourceId: string, ref: AddressRef, at?: string): string | null {
  const list = dir.listOfDataSource(dataSourceId);
  if (!list) return null;
  const contactId = dir.contactIdOfAddress(ref, at);
  const userId = contactId ? dir.contact(contactId)?.userId : undefined;
  return userId !== undefined && dir.readersOfList(list.id).includes(userId) ? userId : null;
}

/** リスト宛てのアドレス（データソースの窓口）。見るときに読者へ展開する（0038 の決定 2） */
export function isListAddress(ds: DataSource | undefined, ref: AddressRef): boolean {
  return ds?.kind === 'service' && ds.selfAddresses.some((a) => sameAddress(a, ref));
}

/** 担当（0038 の決定 1）。個人リストは本人が暗黙の担当なので出さない（自分の番は名指しで決まる） */
export interface Assignee {
  /** source = ソースの担当者（写しの holders）、claim = 担当する操作 */
  by: 'source' | 'claim';
  /** 読者の担当 */
  userIds: string[];
  /** 読者でない担当のうち Contact のあるもの（名前を出すため。番の種類は変えない） */
  contactIds: string[];
  /** 読者でない担当のうち Contact のないもの */
  addresses: AddressRef[];
}

export function assigneeOf(dir: Directory, t: Thread): Assignee | null {
  if (listKindOf(dir, t.dataSourceId) === 'personal') return null;
  const ds = dir.dataSource(t.dataSourceId);
  if (isStatefulSource(ds)) {
    const holders = t.source?.holders ?? [];
    if (ds?.kind !== 'service' || holders.length === 0) return null;
    const out: Assignee = { by: 'source', userIds: [], contactIds: [], addresses: [] };
    for (const value of holders) {
      const ref = { channel: ds.channel, value };
      const user = readerOfAddress(dir, t.dataSourceId, ref);
      if (user) {
        if (!out.userIds.includes(user)) out.userIds.push(user);
        continue;
      }
      const contactId = dir.contactIdOfAddress(ref);
      if (contactId && dir.contact(contactId)) {
        if (!out.contactIds.includes(contactId)) out.contactIds.push(contactId);
      } else out.addresses.push(ref);
    }
    out.userIds.sort();
    out.contactIds.sort();
    return out;
  }
  return t.ownerUserId ? { by: 'claim', userIds: [t.ownerUserId], contactIds: [], addresses: [] } : null;
}

/** 残っている名指し 1 つ（アドレスへの名指し。リスト宛ては含めない） */
export interface AttentionItem {
  address: AddressRef;
  /** そのアドレスが読者のものなら、その User（本人だけが外せる）。null は読者でない（読者なら誰でも外せる） */
  userId: string | null;
  /** 読者でないアドレスの Contact（名前を出すため） */
  contactId: string | null;
  /** 最後に名指ししたシグナル */
  signalId: string;
  at: string;
}

/** 残っている名指し（0038 の決定 2〜4）。list はリスト宛ての名指しが残っている読者 */
export interface Attention {
  named: AttentionItem[];
  list: { userIds: string[]; signalId: string; at: string } | null;
}

/** スレッドのシグナルのうち、送り主を除いた宛先と位置（ログの順） */
function signalsOf(t: Thread): (LogPos & { from: AddressRef; to: AddressRef[] })[] {
  return t.log
    .filter((e) => e.kind === 'signal' && e.from !== undefined)
    .map((e) => ({ signalId: e.signalId!, at: e.at, seq: e.seq, from: e.from!, to: (e.to ?? []).filter((r) => !sameAddress(r, e.from!)) }));
}

/**
 * リスト宛てのシグナル（0038 の決定 2）。シグナルごとに持つ（同じ窓口への名指しが後の 1 通で上書きされない）:
 * - 窓口のアドレス（データソースの selfAddresses）が宛先にある
 * - グループのチャネル（Teams・Slack）で宛先がない。状態を持つソース（Jira など）は共有リストでも含めない
 * - 個人リストで、こちらでない送り主から、本人のアドレスが宛先にない受信（エイリアス・BCC・配布リスト宛て）
 */
export function listSignalsOf(dir: Directory, t: Thread): (LogPos & { from: AddressRef })[] {
  const ds = dir.dataSource(t.dataSourceId);
  if (ds?.kind !== 'service') return [];
  const personal = listKindOf(dir, t.dataSourceId) === 'personal';
  return signalsOf(t)
    .filter((x) => {
      if (x.to.some((r) => isListAddress(ds, r))) return true;
      // 宛先のない投稿をリスト宛てにするのは、チャットのチャネルと、個人の箱に届いた受信（BCC だけで届く通知など。届いた以上は本人宛て）。
      // 状態を持つソース（Jira のメンションのないコメント・担当者のいない起票）は名指しなし（0038 の未決 3）
      if (x.to.length === 0) return !isStatefulSource(ds) && (ds.group || (personal && !isOurs(dir, ds, x.from, x.at)));
      return personal && !isOurs(dir, ds, x.from, x.at) && !x.to.some((r) => isOurs(dir, ds, r, x.at));
    })
    .map(({ signalId, at, seq, from }) => ({ signalId, at, seq, from }));
}

/** リスト宛ての名指しが、その読者に残っているか（外した位置より後の、本人以外が送ったリスト宛てのシグナル） */
export function pendingListSignalsFor(dir: Directory, t: Thread, userId: string): (LogPos & { from: AddressRef })[] {
  const acked = t.attention.listAcks[userId];
  return listSignalsOf(dir, t).filter((x) => (!acked || comparePos(x, acked) > 0) && readerOfAddress(dir, t.dataSourceId, x.from, x.at) !== userId);
}

export function attentionOf(dir: Directory, t: Thread): Attention {
  const ds = dir.dataSource(t.dataSourceId);
  const named: AttentionItem[] = [];
  for (const n of t.attention.named) {
    if (isListAddress(ds, n.address) || !isPending(n)) continue;
    const userId = readerOfAddress(dir, t.dataSourceId, n.address, n.last.at);
    const contactId = userId ? null : dir.contactIdOfAddress(n.address, n.last.at);
    named.push({ address: n.address, userId, contactId: contactId && dir.contact(contactId) ? contactId : null, signalId: n.last.signalId, at: n.last.at });
  }
  let list: Attention['list'] = null;
  const lst = dir.listOfDataSource(t.dataSourceId);
  if (lst) {
    const users: string[] = [];
    let latest: LogPos | null = null;
    for (const u of dir.readersOfList(lst.id)) {
      const pending = pendingListSignalsFor(dir, t, u);
      if (pending.length === 0) continue;
      users.push(u);
      for (const x of pending) if (!latest || comparePos(x, latest) > 0) latest = x;
    }
    if (latest) list = { userIds: users.sort(), signalId: latest.signalId, at: latest.at };
  }
  return { named, list };
}

/**
 * 待っている相手（相手待ち）: 読者でないアドレスへの名指しのうち、こちらから送ったシグナルでの名指しが外れていないもの。
 * 受信の CC に入っていただけの相手は、こちらが待っている相手ではない
 */
export function awaitingNamesOf(dir: Directory, t: Thread): Naming[] {
  const ds = dir.dataSource(t.dataSourceId);
  if (ds?.kind !== 'service') return [];
  const sent = signalsOf(t).filter((x) => isOurs(dir, ds, x.from, x.at));
  return t.attention.named.filter(
    (n) =>
      !isListAddress(ds, n.address) &&
      readerOfAddress(dir, t.dataSourceId, n.address, n.last.at) === null &&
      sent.some((x) => x.to.some((r) => sameAddress(r, n.address)) && (!n.ackedThrough || comparePos(x, n.ackedThrough) > 0)),
  );
}

/**
 * 返事期待が続いているか（0038 の決定 6）。記録した送信の宛先のうち、読者でない相手（いなければ読者）の名指しが、
 * その送信の分まで 1 つでも外れていなければ続く。社内の読者を CC に入れても、相手の名指しを外せば消える
 */
export function replyStateOf(dir: Directory, t: Thread): { replyExpectedBy: string | null; overdue: boolean } {
  if (!t.replyExpectedSignalId || !t.replyExpectedBy) return { replyExpectedBy: null, overdue: false };
  const ds = dir.dataSource(t.dataSourceId);
  const sent = signalsOf(t).find((x) => x.signalId === t.replyExpectedSignalId);
  if (!sent) return { replyExpectedBy: null, overdue: false };
  const to = sent.to.filter((r) => !isListAddress(ds, r));
  const outsiders = to.filter((r) => readerOfAddress(dir, t.dataSourceId, r, sent.at) === null);
  const watch = outsiders.length > 0 ? outsiders : to;
  const waiting =
    watch.length === 0 ||
    watch.some((r) => {
      const n = t.attention.named.find((x) => sameAddress(x.address, r));
      return !n?.ackedThrough || comparePos(n.ackedThrough, sent) < 0;
    });
  return waiting ? { replyExpectedBy: t.replyExpectedBy, overdue: t.overdue } : { replyExpectedBy: null, overdue: false };
}

/** どの見え方にも数えるか（片付けていない・ソースで完了していない） */
export function isOpen(t: Thread): boolean {
  return !t.dismissed && !t.closedAtSource;
}

/** 自分の番の理由（0038 の決定 6）。空なら自分の番ではない */
export type MyTurnReason = 'assignee' | 'named' | 'list';

export function myTurnOf(dir: Directory, viewer: Viewer, t: Thread): MyTurnReason[] {
  if (!isOpen(t)) return [];
  const out: MyTurnReason[] = [];
  if (assigneeOf(dir, t)?.userIds.includes(viewer.userId)) out.push('assignee');
  const a = attentionOf(dir, t);
  if (a.named.some((n) => n.userId === viewer.userId)) out.push('named');
  if (a.list?.userIds.includes(viewer.userId)) out.push('list');
  return out;
}

export function isMyTurn(dir: Directory, viewer: Viewer, t: Thread): boolean {
  return myTurnOf(dir, viewer, t).length > 0;
}

/** 仕分け待ち: 共有リストで、開いていて、担当がいない（0038 の決定 6） */
export function isTriage(dir: Directory, t: Thread): boolean {
  return isOpen(t) && listKindOf(dir, t.dataSourceId) === 'shared' && assigneeOf(dir, t) === null;
}

/** 相手待ち: 開いていて、こちらから送ったシグナルで名指しした読者でない相手の名指しが残っている */
export function isAwaiting(dir: Directory, t: Thread): boolean {
  return isOpen(t) && awaitingNamesOf(dir, t).length > 0;
}

/**
 * リンク先のスレッドから導出したボール（主にタスクのスレッドから見る。どのスレッドからでも同じ計算）。
 * 見えるリンク先だけを見る。片付けたリンク先は数えない
 * - my_turn: どれかが Viewer の番
 * - waiting: 全部が相手待ち
 * - none: それ以外
 * 見えるリンクがなければ null（見えないリンクは、あることも出さない。0033 の 3）
 */
export type DerivedBall =
  | { kind: 'my_turn'; threadIds: string[] }
  | { kind: 'waiting'; threadIds: string[] }
  | { kind: 'none' };

export function derivedBall(dir: Directory, viewer: Viewer, p: Projections, t: Thread): DerivedBall | null {
  // 見えないリンクは「リンクなし」と同じ（0033 の 3）
  const visible = visibleLinked(viewer, p, t);
  if (visible.length === 0) return null;
  const linked = visible.filter((x) => !x.dismissed);
  if (linked.length === 0) return { kind: 'none' };
  const mine = linked.filter((x) => isMyTurn(dir, viewer, x)).map((x) => x.id);
  if (mine.length > 0) return { kind: 'my_turn', threadIds: mine };
  if (linked.every((x) => isAwaiting(dir, x))) return { kind: 'waiting', threadIds: linked.map((x) => x.id) };
  return { kind: 'none' };
}

/**
 * 閉じた（片付けた・ソースで完了した）スレッドに結ばれた先で、閉じたあとにシグナルが来た（0014 の 4）。
 * Murmur は開き直さない。事実だけ返し、開き直すかはスタンドが本人と決める（タスクならソースで開き直す。0039）
 */
export function linkedActiveSinceDismissed(viewer: Viewer, p: Projections, t: Thread): boolean {
  const since = (t.dismissed ? t.dismissedAt : null) ?? (t.closedAtSource ? t.closedAtSourceAt : null);
  if (!since) return false;
  return visibleLinked(viewer, p, t).some((x) => x.signalIds.some((id) => p.signals[id]!.at > since));
}

function visibleLinked(viewer: Viewer, p: Projections, t: Thread): Thread[] {
  return t.links
    .map((l) => p.threads[l.threadId])
    .filter((x): x is Thread => x !== undefined && canReadDataSource(viewer, x.dataSourceId));
}

// ---- 結び候補 ----

/**
 * スレッドのアンカーのうち、データソースをまたいで同じ件を指すキー（ソースの区切り・Jira キー・PR・メッセージ ID）。
 * メッセージ ID は sent_ref（`msg:` を付ける）。同じメールや DM を 2 人がそれぞれのデータソースで見ていれば一致する
 */
export function crossKeys(p: Projections, t: Thread): string[] {
  const keys = new Set<string>();
  for (const id of t.signalIds) {
    const a = p.signals[id]!.anchors;
    if (a.threadKey) keys.add(a.threadKey);
    if (a.messageId) keys.add(`msg:${a.messageId}`);
    for (const k of a.jiraKeys ?? []) keys.add(k);
    for (const k of a.prRefs ?? []) keys.add(k);
  }
  return [...keys].sort();
}

export interface LinkCandidate {
  threadId: string;
  dataSourceId: string;
  title: string;
  /** 一致したキー */
  keys: string[];
}

/**
 * 結び候補: Viewer に見えるスレッドのうち、アンカーのキーが t と一致して、まだ結ばれていないもの（0014 の未決 3: 見えるものに限る）
 */
export function linkCandidates(viewer: Viewer, p: Projections, t: Thread): LinkCandidate[] {
  const mine = new Set(crossKeys(p, t));
  if (mine.size === 0) return [];
  const linked = new Set(t.links.map((l) => l.threadId));
  const out: LinkCandidate[] = [];
  for (const u of Object.values(p.threads)) {
    if (u.id === t.id || linked.has(u.id) || !canReadDataSource(viewer, u.dataSourceId)) continue;
    const keys = crossKeys(p, u).filter((k) => mine.has(k));
    if (keys.length > 0) out.push({ threadId: u.id, dataSourceId: u.dataSourceId, title: u.title, keys });
  }
  return out.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
}
