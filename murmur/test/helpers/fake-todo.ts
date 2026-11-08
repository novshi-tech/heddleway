import type { CreatedSubscription, GraphMe } from '../../src/connectors/graph/api';
import { GraphError, GRAPH_ORIGIN } from '../../src/connectors/graph/api';
import type { DeltaPage } from '../../src/connectors/graph/message';
import type { TodoApi } from '../../src/connectors/todo/api';
import type { TodoTaskList } from '../../src/connectors/todo/task';
import { GatewayAuthError } from '../../src/ports/gateway';

/**
 * To Do の偽物（本人のタスクのリスト）。タスクの変更を順に積み、delta の位置（何件目まで渡したか）で続きを返す。
 * 同じタスクを何度も変えれば、その分だけ delta に出る（本物は最新の状態だけを返すが、写しは冪等なので同じ扱いになる）
 */
export class FakeTodo implements TodoApi {
  readonly changes = new Map<string, Record<string, unknown>[]>();
  readonly subscriptions = new Map<string, { listId: string; clientState: string; expiresAt: string; notificationUrl: string }>();
  readonly calls: string[] = [];
  pageSize = 2;
  authBroken = false;
  readonly invalidLinks = new Set<string>();
  private seq = 0;

  constructor(
    readonly listsInfo: TodoTaskList[] = [
      { id: 'L_default', displayName: 'タスク', wellknownListName: 'defaultList' },
      { id: 'L_murmur', displayName: 'Murmur', wellknownListName: 'none' },
    ],
    readonly meInfo: GraphMe = { id: 'oid_bob', displayName: 'Bob', addresses: ['bob@ubs.example'] },
  ) {}

  /** タスクを作る・変える（delta に出る） */
  put(listId: string, task: Record<string, unknown>) {
    const list = this.changes.get(listId) ?? [];
    list.push(task);
    this.changes.set(listId, list);
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async me() {
    this.check('me');
    return this.meInfo;
  }

  async lists() {
    this.check('lists');
    return this.listsInfo;
  }

  async deltaStart(listId: string): Promise<DeltaPage> {
    this.check(`deltaStart ${listId}`);
    return this.page(listId, 0);
  }

  async deltaNext(link: string): Promise<DeltaPage> {
    this.check(`deltaNext ${link.replace(GRAPH_ORIGIN, '')}`);
    if (this.invalidLinks.has(link)) throw new GraphError(410, 'syncStateNotFound');
    const u = new URL(link);
    const [listId, offset] = (u.searchParams.get('$skiptoken') ?? u.searchParams.get('$deltatoken'))!.split('|');
    return this.page(listId!, Number(offset));
  }

  private page(listId: string, offset: number): DeltaPage {
    const all = this.changes.get(listId) ?? [];
    const value = all.slice(offset, offset + this.pageSize);
    const end = offset + value.length;
    const base = `${GRAPH_ORIGIN}/v1.0/me/todo/lists/${listId}/tasks/delta`;
    if (end < all.length) return { value, '@odata.nextLink': `${base}?$skiptoken=${listId}|${end}` };
    return { value, '@odata.deltaLink': `${base}?$deltatoken=${listId}|${end}` };
  }

  async createSubscription(input: { listId: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription> {
    this.check(`create ${input.listId}`);
    const id = `sub_${++this.seq}`;
    this.subscriptions.set(id, { listId: input.listId, clientState: input.clientState, expiresAt: input.expiresAt, notificationUrl: input.notificationUrl });
    return { id, expiresAt: input.expiresAt };
  }

  async renewSubscription(id: string, expiresAt: string) {
    this.check(`renew ${id}`);
    const s = this.subscriptions.get(id);
    if (!s) return null;
    s.expiresAt = expiresAt;
    return expiresAt;
  }

  async deleteSubscription(id: string) {
    this.check(`delete ${id}`);
    this.subscriptions.delete(id);
  }

  /** そのリストのサブスクリプションへの通知の本文 */
  notification(listId: string, lifecycleEvent?: string) {
    const [id, s] = [...this.subscriptions].find(([, x]) => x.listId === listId)!;
    return { value: [{ subscriptionId: id, clientState: s.clientState, ...(lifecycleEvent ? { lifecycleEvent } : { changeType: 'updated', resource: 'x' }) }] };
  }
}

/** To Do の todoTask（delta の 1 件） */
export function todoTask(over: { id: string; title?: string; status?: string; due?: string | null; at: string }) {
  return {
    id: over.id,
    title: over.title ?? '件名',
    status: over.status ?? 'notStarted',
    importance: 'normal',
    ...(over.due === undefined ? {} : { dueDateTime: over.due === null ? null : { dateTime: `${over.due}T00:00:00.0000000`, timeZone: 'Tokyo Standard Time' } }),
    lastModifiedDateTime: over.at,
    createdDateTime: over.at,
  };
}
