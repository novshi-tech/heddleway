import type { InboundMirror } from '../../domain';
import type { TodoTask } from './task';

// To Do のタスク → 状態の写し（純関数。0039 の決定 3）。写しは 0031 の決まった形で、To Do の標準の意味で写す:
// closed = 完了（消したタスクも閉じる）、holders = 本人、title = 件名、statusLabel = タスクのリストの名前、due = 期限の日付。
// 本文は写さない。タスクのスレッドは写しで作る（0031 の決定 8。作った記録 record_sent が先なら、そのスレッドに入る）

export type NormalizedTask = { kind: 'mirror'; mirror: InboundMirror } | { kind: 'skip'; reason: string };

export interface TaskContext {
  dataSourceId: string;
  /** 本人のアカウント（チャネル todo のアドレスの値） */
  account: string;
  listName: string;
  /** つないだ時刻。それより前に完了したきりのタスクは取り込まない */
  connectedAt: string;
}

export function normalizeTask(ctx: TaskContext, task: TodoTask): NormalizedTask {
  const sourceRef = `todo:${task.id}:${task.lastModifiedDateTime ?? (task['@removed'] !== undefined ? 'removed' : 'unknown')}`;
  if (task['@removed'] !== undefined) {
    // 消えたタスク: 閉じる。スレッドがなければ（件名がないので）写しは作られない
    return { kind: 'mirror', mirror: mirror(ctx, task.id, { closed: true }, sourceRef) };
  }
  const closed = task.status === 'completed';
  if (closed && task.lastModifiedDateTime && task.lastModifiedDateTime < ctx.connectedAt) return { kind: 'skip', reason: 'completed before connecting' };
  const title = task.title?.trim();
  if (!title) return { kind: 'skip', reason: 'no title' };
  return {
    kind: 'mirror',
    mirror: mirror(ctx, task.id, { closed, holders: [ctx.account], title, statusLabel: ctx.listName, due: dueDate(task) }, sourceRef),
  };
}

/** 期限の日付（To Do の期限は日付だけ。時刻はタイムゾーンの 0 時なので、日付の部分だけ取る） */
function dueDate(task: TodoTask): string | null {
  const m = task.dueDateTime?.dateTime.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

function mirror(ctx: TaskContext, taskId: string, fields: InboundMirror['fields'], sourceRef: string): InboundMirror {
  return { kind: 'mirror', dataSourceId: ctx.dataSourceId, channel: 'todo', threadKey: taskId, fields, sourceRef };
}
