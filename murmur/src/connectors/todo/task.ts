import { z } from 'zod';

// Microsoft To Do（Graph の todoTask・todoTaskList）の部分スキーマ。写しに使う項目だけを読み、ほかは捨てる（0039）。

export const TodoTask = z.object({
  id: z.string(),
  /** delta で消えたもの（{ reason: 'deleted' } など） */
  '@removed': z.unknown().optional(),
  title: z.string().nullable().optional(),
  /** notStarted / inProgress / completed / waitingOnOthers / deferred */
  status: z.string().optional(),
  importance: z.string().optional(),
  /** { dateTime: '2026-10-20T00:00:00.0000000', timeZone: 'UTC' } */
  dueDateTime: z.object({ dateTime: z.string(), timeZone: z.string().optional() }).nullable().optional(),
  lastModifiedDateTime: z.string().optional(),
  createdDateTime: z.string().optional(),
});
export type TodoTask = z.infer<typeof TodoTask>;

export const TodoTaskList = z.object({
  id: z.string(),
  displayName: z.string(),
  /** defaultList（「タスク」）・flaggedEmails（フラグを付けたメール）・none */
  wellknownListName: z.string().optional(),
});
export type TodoTaskList = z.infer<typeof TodoTaskList>;

export const TodoListsPage = z.object({ value: z.array(TodoTaskList), '@odata.nextLink': z.string().optional() });

/** delta で取る項目（$select）。本文（body）は写さない（経過は Murmur のメモに書く。0039 の決定 3） */
export const TASK_SELECT = ['id', 'title', 'status', 'importance', 'dueDateTime', 'lastModifiedDateTime', 'createdDateTime'].join(',');
