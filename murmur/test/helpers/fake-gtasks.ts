import { GtasksError, type GtasksApi } from '../../src/connectors/gtasks/api';
import type { GtasksTaskList, GtasksTasksPage } from '../../src/connectors/gtasks/task';
import { GatewayAuthError } from '../../src/ports/gateway';

/**
 * Google Tasks の偽物（本人のタスクのリスト）。本物と同じく、タスクは 1 件ずつ最新の状態だけを持ち（put は同じ ID を置き換える）、
 * 一覧は更新順ではなく並び（最初に置いた順）で返す。updatedMin は updated がそれ以上のものだけ（本物と同じく境界を含む）。
 * pageToken は「何件目まで渡したか」。calls に updatedMin と pageToken を残す
 */
export class FakeGtasks implements GtasksApi {
  readonly tasksByList = new Map<string, Record<string, unknown>[]>();
  readonly calls: { fn: string; listId?: string; updatedMin?: string | null; pageToken?: string | null }[] = [];
  pageSize = 2;
  authBroken = false;
  /** 次の tasks の呼び出しを失敗させる（上限に当たったときなど） */
  failNextTasks: Error | null = null;
  readonly invalidTokens = new Set<string>();
  /** tasks の呼び出しの前に呼ぶ（n は何回目か。1 から）。途中で外す・失敗させるなど、読んでいる間の出来事を起こす */
  beforeTasks: ((n: number) => Promise<void> | void) | null = null;

  constructor(
    readonly listsInfo: GtasksTaskList[] = [
      { id: 'L_default', title: 'My Tasks' },
      { id: 'L_murmur', title: 'Murmur' },
    ],
    public email = 'bob@gws.example',
  ) {}

  /** タスクを作る・変える。同じ ID は置き換える */
  put(listId: string, task: Record<string, unknown>) {
    const list = this.tasksByList.get(listId) ?? [];
    const i = list.findIndex((t) => t.id === task.id);
    if (i >= 0) list[i] = task;
    else list.push(task);
    this.tasksByList.set(listId, list);
  }

  private check(fn: string, extra: { listId?: string; updatedMin?: string | null; pageToken?: string | null } = {}) {
    this.calls.push({ fn, ...extra });
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async account() {
    this.check('account');
    return this.email;
  }

  async lists() {
    this.check('lists');
    return this.listsInfo;
  }

  async list(listId: string) {
    this.check('list', { listId });
    return this.listsInfo.find((l) => l.id === listId) ?? null;
  }

  async tasks(listId: string, opts: { updatedMin?: string | null; pageToken?: string | null } = {}): Promise<GtasksTasksPage> {
    this.check('tasks', { listId, updatedMin: opts.updatedMin ?? null, pageToken: opts.pageToken ?? null });
    await this.beforeTasks?.(this.taskCalls.length);
    if (this.failNextTasks) {
      const err = this.failNextTasks;
      this.failNextTasks = null;
      throw err;
    }
    if (!this.listsInfo.some((l) => l.id === listId)) throw new GtasksError(404, 'NOT_FOUND');
    if (opts.pageToken && this.invalidTokens.has(opts.pageToken)) throw new GtasksError(400, 'INVALID_ARGUMENT');
    const all = (this.tasksByList.get(listId) ?? []).filter((t) => !opts.updatedMin || Date.parse(String(t.updated)) >= Date.parse(opts.updatedMin));
    const offset = opts.pageToken ? Number(opts.pageToken.split(':')[1]) : 0;
    const items = all.slice(offset, offset + this.pageSize);
    const end = offset + items.length;
    return { ...(items.length > 0 ? { items } : {}), ...(end < all.length ? { nextPageToken: `tok:${end}` } : {}) };
  }

  /** この呼び出しのうち、タスクの一覧のもの */
  get taskCalls() {
    return this.calls.filter((c) => c.fn === 'tasks');
  }
}

/** Google Tasks の task（一覧の 1 件） */
export function gtask(over: { id: string; title?: string | null; status?: 'needsAction' | 'completed'; due?: string | null; at: string; deleted?: boolean; hidden?: boolean; parent?: string }) {
  return {
    id: over.id,
    ...(over.title === null ? {} : { title: over.title ?? '件名' }),
    status: over.status ?? 'needsAction',
    ...(over.due ? { due: `${over.due}T00:00:00.000Z` } : {}),
    updated: over.at,
    ...(over.deleted ? { deleted: true } : {}),
    ...(over.hidden ? { hidden: true } : {}),
    ...(over.parent ? { parent: over.parent } : {}),
    notes: '本文',
    links: [{ type: 'email', description: 'Re: 件名', link: 'https://mail.google.com/mail/u/0/#all/abc' }],
  };
}
