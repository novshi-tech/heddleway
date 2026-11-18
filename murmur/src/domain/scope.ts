import type { Projections, Thread } from './projections';
import { crossKeysOfSignals } from './turn';

// API の経路の範囲（0047）。投影の全件ではなく、詳細・操作・一覧が見るものだけ。意味をここで決め、
// メモリの保存先はそのまま使い、D1 は SQL で同じものを引く（0046 の作業範囲と同じ形）

/**
 * 詳細と操作の範囲（0047 の決定 1）:
 * - threadIds のスレッドと、signalIds のシグナルとそのスレッド（主なスレッド）
 * - links なら、主なスレッドの結んだ先
 * - candidates なら、主なスレッドとアンカーのキー（`crossKeys`）を共有するスレッド（結び候補）
 * どのスレッドも、そのシグナルを全部含む。見えるかどうかはコアが決める
 */
export interface ThreadScopeRequest {
  threadIds: string[];
  signalIds?: string[];
  links?: boolean;
  candidates?: boolean;
}

/**
 * 一覧の範囲（0047 の決定 2）: dataSourceIds のスレッド（openOnly なら片付けておらずソースで完了していないもの）、
 * その結んだ先、結び候補。シグナルは含めない。代わりに、一覧のスレッドと結び候補のアンカーのキーを `keys` に添える
 */
export interface ListScopeRequest {
  dataSourceIds: string[];
  openOnly: boolean;
}

/** 一覧の open 系の絞り込みは、開いているスレッドしか出さない */
export function isOpenThread(t: Pick<Thread, 'dismissed' | 'closedAtSource'>): boolean {
  return !t.dismissed && !t.closedAtSource;
}

function emptyScope(full: Projections): Projections {
  return { lastSeq: full.lastSeq, threads: {}, signals: {}, index: { sourceRefs: {}, messageIds: {} } };
}

/** キー → それを持つスレッド（全件から） */
function threadsByKey(full: Projections): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of Object.values(full.threads)) for (const k of crossKeysOfSignals(full, t)) out.set(k, [...(out.get(k) ?? []), t.id]);
  return out;
}

export function selectThreadScope(full: Projections, req: ThreadScopeRequest): Projections {
  const out = emptyScope(full);
  const add = (t: Thread | undefined) => {
    if (!t || out.threads[t.id]) return;
    out.threads[t.id] = t;
    for (const id of t.signalIds) if (full.signals[id]) out.signals[id] = full.signals[id]!;
  };
  const primary: Thread[] = [];
  for (const id of req.threadIds) if (full.threads[id]) primary.push(full.threads[id]!);
  for (const id of req.signalIds ?? []) {
    const s = full.signals[id];
    if (!s) continue;
    out.signals[id] = s;
    if (s.threadId && full.threads[s.threadId]) primary.push(full.threads[s.threadId]!);
  }
  primary.forEach(add);
  if (req.links) for (const t of primary) for (const l of t.links) add(full.threads[l.threadId]);
  if (req.candidates) {
    const byKey = threadsByKey(full);
    for (const t of primary) for (const k of crossKeysOfSignals(full, t)) for (const id of byKey.get(k) ?? []) add(full.threads[id]);
  }
  return out;
}

export function selectListScope(full: Projections, req: ListScopeRequest): Projections {
  const out = emptyScope(full);
  out.keys = {};
  const ds = new Set(req.dataSourceIds);
  const listed = Object.values(full.threads).filter((t) => ds.has(t.dataSourceId) && (!req.openOnly || isOpenThread(t)));
  for (const t of listed) out.threads[t.id] = t;
  for (const t of listed) for (const l of t.links) if (full.threads[l.threadId]) out.threads[l.threadId] = full.threads[l.threadId]!;
  // 一覧のスレッドのキーは全部、結び候補のキーはそのうち一覧のキーと重なるものだけ（結び候補の計算にはそれで足りる）
  const mine = new Set<string>();
  for (const t of listed) {
    const keys = crossKeysOfSignals(full, t);
    out.keys[t.id] = keys;
    keys.forEach((k) => mine.add(k));
  }
  const listedIds = new Set(listed.map((t) => t.id));
  const byKey = threadsByKey(full);
  for (const k of mine) {
    for (const id of byKey.get(k) ?? []) {
      if (!out.threads[id]) out.threads[id] = full.threads[id]!;
      if (!listedIds.has(id)) out.keys[id] = [...new Set([...(out.keys[id] ?? []), k])].sort();
    }
  }
  // 範囲のどのスレッドにもキーを添える（結んだ先で、一覧のキーと重ならないものは空。シグナルを読みに行かせない）
  for (const id of Object.keys(out.threads)) out.keys[id] ??= [];
  return out;
}
