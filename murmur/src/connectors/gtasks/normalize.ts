import type { InboundMirror } from '../../domain';
import type { GtasksTask } from './task';

// Google Tasks のタスク → 状態の写し（純関数。0039 の決定 3 の表・0041 の決定 3）。写しは 0031 の決まった形で、
// Google Tasks の標準の意味で写す: closed = 完了・削除・非表示、holders = 本人、title = 件名、statusLabel = タスクのリストの名前、
// due = 期限の日付。本文（notes）は写さない。サブタスク（parent）は親と同じ 1 つずつのタスクとして写し、親子は写さない。
// task.links（Gmail から作ったタスクのメールへのリンク）はアンカーにしない（0041 未決 3: 実物で確かめてから決める）

export type NormalizedGtask = { kind: 'mirror'; mirror: InboundMirror } | { kind: 'skip'; reason: string };

export interface GtaskContext {
  dataSourceId: string;
  /** 本人のアカウント（チャネル todo のアドレスの値） */
  account: string;
  listName: string;
  /** つないだ時刻。それより前に閉じたきりのタスクは取り込まない */
  connectedAt: string;
}

export function normalizeGtask(ctx: GtaskContext, task: GtasksTask): NormalizedGtask {
  const sourceRef = `gtasks:${task.id}:${task.updated}`;
  const closed = task.status === 'completed' || task.deleted === true || task.hidden === true;
  if (closed && Date.parse(task.updated) < Date.parse(ctx.connectedAt)) return { kind: 'skip', reason: 'closed before connecting' };
  const title = task.title?.trim();
  if (!title) {
    // 件名のないタスクは写さない。ただし閉じたものは、すでにあるスレッドを閉じるために閉じる印だけ渡す
    // （削除されたタスクは件名を返さないことがある。スレッドがなければ写しは作られない）
    if (closed) return { kind: 'mirror', mirror: mirror(ctx, task.id, { closed: true }, sourceRef) };
    return { kind: 'skip', reason: 'no title' };
  }
  return {
    kind: 'mirror',
    mirror: mirror(ctx, task.id, { closed, holders: [ctx.account], title, statusLabel: ctx.listName, due: dueDate(task) }, sourceRef),
  };
}

/**
 * 期限の日付。Google Tasks の期限は日付だけが意味を持ち、その日の UTC の 0 時として返る（時刻は捨てられる）。
 * To Do と違い、タイムゾーンで丸めず、日付の部分をそのまま使う
 */
export function dueDate(task: Pick<GtasksTask, 'due'>): string | null {
  return task.due?.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1] ?? null;
}

function mirror(ctx: GtaskContext, taskId: string, fields: InboundMirror['fields'], sourceRef: string): InboundMirror {
  return { kind: 'mirror', dataSourceId: ctx.dataSourceId, channel: 'todo', threadKey: taskId, fields, sourceRef };
}
