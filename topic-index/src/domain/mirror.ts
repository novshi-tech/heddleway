import type { CoreContext } from './context';
import type { Channel } from './entities';
import { DomainError } from './errors';
import { draft, MirrorFields, type DraftEvent } from './events';
import { threadOfSourceKey, type InboundSignal } from './ingest';
import type { Projections } from './projections';

// 状態の写し（0010・0031）。状態を持つデータソース（Jira の課題・PR）の状態を、
// トピック索引が決めた形でスレッドに片方向で写す判断（純関数）。トピック索引の側では書き換えない。

/** コネクタが正規化した状態の写し。課題の更新 1 回分 */
export interface InboundMirror {
  kind: 'mirror';
  dataSourceId: string;
  channel: Channel;
  /** ソースの区切り（課題キー） */
  threadKey: string;
  /** 写す項目（省略は変わっていない）。holders はそのチャネルのアカウント（アドレスの値）で渡す */
  fields: MirrorFields;
  /** ソースの更新の識別子（監査用） */
  sourceRef: string;
}

/** コネクタが返すもの: シグナルか状態の写し */
export type InboundItem = InboundSignal | InboundMirror;

export function isMirror(item: InboundItem): item is InboundMirror {
  return (item as { kind?: unknown }).kind === 'mirror';
}

export type MirrorPlan =
  | { kind: 'no_thread'; threadKey: string }
  | { kind: 'unchanged'; threadId: string }
  | { kind: 'mirrored'; threadId: string; newThread: boolean; fields: MirrorFields; events: DraftEvent[] };

/**
 * 写しの判断。課題キーのスレッドに、変わった項目だけを ThreadMirrored で写す（同じ値なら何もしない。冪等）。
 * 課題キーのスレッドがまだなければ、件名（title）のある写しならそのスレッドを作る（0031 の 8。Webhook の順番は保証されない）。
 * 件名がなければ写さない（no_thread）
 */
export function planMirror(p: Projections, ctx: CoreContext, m: InboundMirror): MirrorPlan {
  const ds = ctx.dir.dataSource(m.dataSourceId);
  if (!ds || ds.kind !== 'service') {
    throw new DomainError('invalid', `data source ${m.dataSourceId} is not a service data source`);
  }
  if (ds.channel !== m.channel) throw new DomainError('invalid', `data source ${ds.id} is ${ds.channel}, not ${m.channel}`);
  const parsed = MirrorFields.safeParse(m.fields);
  if (!parsed.success) throw new DomainError('invalid', `mirror fields: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  const f = parsed.data;
  const threadId = threadOfSourceKey(p, ds.id, m.threadKey);
  if (!threadId) {
    if (f.title === undefined) return { kind: 'no_thread', threadKey: m.threadKey };
    const fields: MirrorFields = { ...f };
    if (fields.holders) fields.holders = [...new Set(fields.holders)].sort();
    const id = ctx.newId('thr');
    return {
      kind: 'mirrored',
      threadId: id,
      newThread: true,
      fields,
      events: [draft('ThreadMirrored', { threadId: id, created: true, dataSourceId: ds.id, threadKey: m.threadKey, fields, sourceRef: m.sourceRef })],
    };
  }
  const t = p.threads[threadId]!;

  const src = t.source;
  const changed: MirrorFields = {};
  if (f.closed !== undefined && f.closed !== t.closedAtSource) changed.closed = f.closed;
  if (f.holders !== undefined) {
    const holders = [...new Set(f.holders)].sort();
    if (!src || holders.join('\n') !== src.holders.join('\n')) changed.holders = holders;
  }
  if (f.title !== undefined && f.title !== t.title) changed.title = f.title;
  if (f.statusLabel !== undefined && f.statusLabel !== (src?.statusLabel ?? null)) changed.statusLabel = f.statusLabel;
  if (f.due !== undefined && f.due !== (src?.due ?? null)) changed.due = f.due;
  if (Object.keys(changed).length === 0) return { kind: 'unchanged', threadId };
  return {
    kind: 'mirrored',
    threadId,
    newThread: false,
    fields: changed,
    events: [draft('ThreadMirrored', { threadId, created: false, dataSourceId: ds.id, threadKey: m.threadKey, fields: changed, sourceRef: m.sourceRef })],
  };
}
