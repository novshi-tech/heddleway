import { addressKey, comparePos } from './comm';
import type { AddressRef } from './entities';
import type { InboundSignal, IngestPolicy } from './ingest';
import type { InboundMirror } from './mirror';
import { indexKey, type Projections, type SignalRecord, type Thread } from './projections';

// 取り込みの作業範囲（0046）。投影の全件ではなく、区切りに要る行だけを読むための純関数。
// 索引・列はどれも投影（シグナルとスレッドの記録）だけから決まる。保存先はこれを行に写し、いつでも作り直せる

/** シグナルの索引の種類（0046 の決定 2）。値ごとに、その値を持つ最新のシグナル（seq の大きいもの）を指す */
export const SIGNAL_KEY_KINDS = ['sourceRef', 'messageId', 'threadKey', 'threadTs', 'sourceThread'] as const;
export type SignalKeyKind = (typeof SIGNAL_KEY_KINDS)[number];

export interface SignalKey {
  kind: SignalKeyKind;
  value: string;
}

/** シグナルが索引に載せる値 */
export function signalKeysOf(s: SignalRecord): SignalKey[] {
  const out: SignalKey[] = [{ kind: 'sourceRef', value: s.sourceRef }];
  if (s.anchors.messageId) out.push({ kind: 'messageId', value: s.anchors.messageId });
  if (s.anchors.threadKey) out.push({ kind: 'threadKey', value: s.anchors.threadKey });
  if (s.anchors.threadTs) out.push({ kind: 'threadTs', value: s.anchors.threadTs });
  if (s.anchors.sourceThread) out.push({ kind: 'sourceThread', value: s.anchors.sourceThread });
  return out;
}

/**
 * シグナルから重複排除とアンカー解決の索引（`Projections.index`）を作り直す。fold が addSignal で積むのと同じ結果
 * （seq の順に上書きするので、同じ値は最新のシグナルを指す）
 */
export function indexOfSignals(signals: Iterable<SignalRecord>): Projections['index'] {
  const index: Projections['index'] = { sourceRefs: {}, messageIds: {} };
  for (const s of [...signals].sort((a, b) => a.seq - b.seq)) {
    index.sourceRefs[indexKey(s.dataSourceId, s.sourceRef)] = s.signalId;
    if (s.anchors.messageId) index.messageIds[indexKey(s.dataSourceId, s.anchors.messageId)] = s.signalId;
  }
  return index;
}

/** 外していない名指しのアドレスのキー（`addressKey`。返事待ちの候補を送り主で引く索引。0046 の決定 3） */
export function pendingNamedKeys(t: Thread): string[] {
  // 形が古い投影（0038 より前。isStaleProjections）にも書けるように、名指しがなければ空
  const keys = (t.attention?.named ?? []).filter((n) => !n.ackedThrough || comparePos(n.last, n.ackedThrough) > 0).map((n) => addressKey(n.address));
  return [...new Set(keys)].sort();
}

/** 外していない名指しが 1 つでも残っているか（返事待ちの上位集合。向きと読者はクエリ層が決める。0046 の決定 3） */
export function hasPendingNaming(t: Thread): boolean {
  return pendingNamedKeys(t).length > 0;
}

/** 最後のシグナルの時刻（向きは問わない）。シグナルがなければ null */
export function lastSignalAt(t: Thread): string | null {
  let last: string | null = null;
  for (const l of t.log ?? []) if (l.kind === 'signal' && (last === null || l.at > last)) last = l.at;
  return last;
}

/** 期限の見回り（planOverdue）の候補になる返事期待の期限。候補でなければ null（0046 の未決 3） */
export function replyDue(t: Thread): string | null {
  if (t.dismissed || t.closedAtSource || t.overdue || t.replyExpectedSignalId == null) return null;
  return t.replyExpectedBy ?? null;
}

/** スレッドの行に持つ列（0046 の決定 2） */
export function threadColumns(t: Thread): { sourceKey: string | null; lastSignalAt: string | null; namedPending: boolean; replyDue: string | null; isOpen: boolean } {
  return { sourceKey: t.sourceKey ?? null, lastSignalAt: lastSignalAt(t), namedPending: hasPendingNaming(t), replyDue: replyDue(t), isOpen: !t.dismissed && !t.closedAtSource };
}

/** 期限の見回りの作業範囲の意味: 返事期待の期限が before より前のスレッドとそのシグナル（畳んで保存し直すとき、キーの行をシグナルから作る）。D1 は reply_due の索引で引く */
export function selectOverdueSet(full: Projections, before: string): Projections {
  const out: Projections = { lastSeq: full.lastSeq, threads: {}, signals: {}, index: { sourceRefs: {}, messageIds: {} } };
  for (const t of Object.values(full.threads)) {
    const due = replyDue(t);
    if (due !== null && due < before) {
      out.threads[t.id] = t;
      for (const id of t.signalIds) if (full.signals[id]) out.signals[id] = full.signals[id]!;
    }
  }
  return out;
}

// ---- 作業範囲の依頼と、その意味（0046 の決定 1） ----

/**
 * 取り込みの作業範囲の依頼。保存先は、保存済みの投影から次のものを返す（`selectWorkingSet` がその意味。D1 は SQL で同じものを引く）:
 * - keys: データソースの中で、その値を持つ最新のシグナルと、そのスレッド（の全シグナル）。種類が sourceRef・messageId なら索引にも載せる
 * - sourceKeys: 写しの区切り（`Thread.sourceKey`）がその値のスレッド
 * - awaiting: 返事待ちの上位集合（決定 3）。`all` は外していない名指しが残っているスレッドの全部（グループの会話）、
 *   `{ address }` はそのアドレスへの外していない名指しが残っているスレッド（1 対 1 の会話の受信の送り主）
 * - window: 最後のシグナルが since 以降のスレッドを、新しい順に limit 本まで（決定 4）
 * 返すスレッドは、そのシグナルを全部含む。lastSeq は保存済みの投影のもの
 */
export interface WorkingSetRequest {
  dataSourceId: string;
  keys: SignalKey[];
  sourceKeys: string[];
  awaiting: false | 'all' | { address: AddressRef };
  window: { since: string; limit: number } | null;
}

function uniqueKeys(keys: SignalKey[]): SignalKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = `${k.kind}\n${k.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 重複排除と記録との統合（`prepareInbound`）に要るものだけ。重複なら、ここで取り込みを終えられる */
export function dedupeRequest(inbound: Pick<InboundSignal, 'dataSourceId' | 'sourceRef' | 'anchors'>): WorkingSetRequest {
  const keys: SignalKey[] = [{ kind: 'sourceRef', value: inbound.sourceRef }];
  if (inbound.anchors?.messageId) keys.push({ kind: 'messageId', value: inbound.anchors.messageId });
  return { dataSourceId: inbound.dataSourceId, keys, sourceKeys: [], awaiting: false, window: null };
}

/**
 * 区切り（`planThreading`）まで含めた作業範囲。重複排除の分も入れる（間に別の書き手が同じものを取り込んでいても、ここで重複と分かる）。
 * アンカーの照合（`resolveAnchors`・`threadOfSourceKey`）はどの値も messageId の索引でも引くので、両方の種類で引く
 */
export function threadingRequest(
  inbound: Pick<InboundSignal, 'dataSourceId' | 'sourceRef' | 'anchors' | 'from'>,
  now: string,
  policy: IngestPolicy,
  /** 返事待ち（awaitingThread）の見方: こちらからの送信なら読まない、グループの会話なら全部、ほかは送り主で引く */
  conversation: { ours: boolean; group: boolean },
): WorkingSetRequest {
  const a = inbound.anchors ?? {};
  const keys = dedupeRequest(inbound).keys;
  if (a.threadKey) keys.push({ kind: 'threadKey', value: a.threadKey }, { kind: 'messageId', value: a.threadKey });
  if (a.inReplyTo) keys.push({ kind: 'messageId', value: a.inReplyTo });
  if (a.quotedMessageId) keys.push({ kind: 'messageId', value: a.quotedMessageId });
  if (a.threadTs) keys.push({ kind: 'threadTs', value: a.threadTs }, { kind: 'messageId', value: a.threadTs });
  // ソースのスレッド（0050）。AI を使わない区切りでだけ使うが、引くのは安い
  if (a.sourceThread) keys.push({ kind: 'sourceThread', value: a.sourceThread });
  return {
    dataSourceId: inbound.dataSourceId,
    keys: uniqueKeys(keys),
    sourceKeys: a.threadKey ? [a.threadKey] : [],
    // AI を使わない区切り（0050）は返事待ちと直近の候補を使わないので読まない
    awaiting: policy.threading === 'source' || conversation.ours ? false : conversation.group ? 'all' : { address: inbound.from },
    window: policy.threading === 'source' ? null : { since: windowStart(now, policy.candidateWindowDays), limit: policy.candidateWindowLimit },
  };
}

/** 状態の写し（`planMirror`）の置き先を引く作業範囲 */
export function mirrorRequest(m: Pick<InboundMirror, 'dataSourceId' | 'threadKey'>): WorkingSetRequest {
  return {
    dataSourceId: m.dataSourceId,
    keys: [
      { kind: 'threadKey', value: m.threadKey },
      { kind: 'messageId', value: m.threadKey },
    ],
    sourceKeys: [m.threadKey],
    awaiting: false,
    window: null,
  };
}

/** 窓の始まり（now から days 日前）。時刻の計算は渡された now からだけ行う */
export function windowStart(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 窓の並び（最後のシグナルの新しい順、同じなら id の順）。D1 の ORDER BY と同じ */
export function compareWindow(a: Thread, b: Thread): number {
  const x = lastSignalAt(a) ?? '';
  const y = lastSignalAt(b) ?? '';
  return x < y ? 1 : x > y ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 作業範囲の意味（全件の投影から選ぶ）。メモリの保存先が使い、D1 の実装と結果を比べるテストの基準にもなる */
export function selectWorkingSet(full: Projections, req: WorkingSetRequest): Projections {
  const ds = req.dataSourceId;
  const latest = new Map<string, SignalRecord>();
  for (const s of Object.values(full.signals)) {
    if (s.dataSourceId !== ds) continue;
    for (const k of signalKeysOf(s)) {
      const id = `${k.kind}\n${k.value}`;
      const prev = latest.get(id);
      if (!prev || s.seq > prev.seq) latest.set(id, s);
    }
  }
  const out: Projections = { lastSeq: full.lastSeq, threads: {}, signals: {}, index: { sourceRefs: {}, messageIds: {} } };
  const addThread = (t: Thread | undefined) => {
    if (!t || out.threads[t.id]) return;
    out.threads[t.id] = t;
    for (const id of t.signalIds) {
      const s = full.signals[id];
      if (s) out.signals[id] = s;
    }
  };
  for (const k of req.keys) {
    const s = latest.get(`${k.kind}\n${k.value}`);
    if (!s) continue;
    out.signals[s.signalId] = s;
    if (k.kind === 'sourceRef') out.index.sourceRefs[indexKey(ds, k.value)] = s.signalId;
    if (k.kind === 'messageId') out.index.messageIds[indexKey(ds, k.value)] = s.signalId;
    if (s.threadId) addThread(full.threads[s.threadId]);
  }
  const inDs = Object.values(full.threads).filter((t) => t.dataSourceId === ds);
  const sourceKeys = new Set(req.sourceKeys);
  for (const t of inDs) if (t.sourceKey && sourceKeys.has(t.sourceKey)) addThread(t);
  const awaiting = req.awaiting;
  if (awaiting === 'all') {
    for (const t of inDs) if (hasPendingNaming(t)) addThread(t);
  } else if (awaiting) {
    const key = addressKey(awaiting.address);
    for (const t of inDs) if (pendingNamedKeys(t).includes(key)) addThread(t);
  }
  if (req.window) {
    const since = req.window.since;
    inDs
      .filter((t) => (lastSignalAt(t) ?? '') >= since)
      .sort(compareWindow)
      .slice(0, req.window.limit)
      .forEach(addThread);
  }
  return out;
}
