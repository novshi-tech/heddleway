import { comparePos } from './comm';
import { indexKey, type Projections, type SignalRecord, type Thread } from './projections';

// 取り込みの作業範囲（0046）。投影の全件ではなく、区切りに要る行だけを読むための純関数。
// 索引・列はどれも投影（シグナルとスレッドの記録）だけから決まる。保存先はこれを行に写し、いつでも作り直せる

/** シグナルの索引の種類（0046 の決定 2）。値ごとに、その値を持つ最新のシグナル（seq の大きいもの）を指す */
export const SIGNAL_KEY_KINDS = ['sourceRef', 'messageId', 'threadKey', 'threadTs'] as const;
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

/** 外していない名指しが 1 つでも残っているか（返事待ちの上位集合。向きと読者はクエリ層が決める。0046 の決定 3） */
export function hasPendingNaming(t: Thread): boolean {
  // 形が古い投影（0038 より前。isStaleProjections）にも書けるように、名指しがなければ false
  return (t.attention?.named ?? []).some((n) => !n.ackedThrough || comparePos(n.last, n.ackedThrough) > 0);
}

/** 最後のシグナルの時刻（向きは問わない）。シグナルがなければ null */
export function lastSignalAt(t: Thread): string | null {
  let last: string | null = null;
  for (const l of t.log ?? []) if (l.kind === 'signal' && (last === null || l.at > last)) last = l.at;
  return last;
}

/** スレッドの行に持つ列（0046 の決定 2） */
export function threadColumns(t: Thread): { sourceKey: string | null; lastSignalAt: string | null; namedPending: boolean } {
  return { sourceKey: t.sourceKey ?? null, lastSignalAt: lastSignalAt(t), namedPending: hasPendingNaming(t) };
}
