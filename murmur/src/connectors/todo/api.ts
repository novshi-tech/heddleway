import type { UpstreamCall } from '../../ports/gateway';
import { GatewayGraphApi, GRAPH_ORIGIN, GraphError, graphRequest, type CreatedSubscription, type GraphMe } from '../graph/api';
import { DeltaPage } from '../graph/message';
import { TodoListsPage, type TodoTaskList } from './task';

// To Do の読み取り（ゲートウェイの REST 経由。0039）。本体が To Do に対してするのは、読み取りと購読の管理だけ。
// タスクを作る・変える・完了にするのはスタンド（ゲートウェイの graph でスタンドが書き、本体には record_sent で記録する）。
// 呼べる口は Outlook と同じ GRAPH_SCOPE（/me の下の GET とサブスクリプション）。書き込みの口はここに足さない

export interface TodoApi {
  me(): Promise<GraphMe>;
  /** 本人のタスクのリスト */
  lists(): Promise<TodoTaskList[]>;
  /** タスクの delta の最初（リストの全部） */
  deltaStart(listId: string): Promise<DeltaPage>;
  /** nextLink か deltaLink の続き */
  deltaNext(link: string): Promise<DeltaPage>;
  createSubscription(input: { listId: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription>;
  /** 延長と再認可を兼ねる。なければ null */
  renewSubscription(id: string, expiresAt: string): Promise<string | null>;
  deleteSubscription(id: string): Promise<void>;
}

/** To Do のタスクのサブスクリプションの期限（Graph の todoTask は最長 4,230 分。少し手前にする） */
export const TODO_SUBSCRIPTION_MINUTES = 4_220;

export class GatewayTodoApi implements TodoApi {
  private readonly graph: GatewayGraphApi;

  constructor(private readonly upstream: UpstreamCall) {
    this.graph = new GatewayGraphApi(upstream);
  }

  me(): Promise<GraphMe> {
    return this.graph.me();
  }

  async lists(): Promise<TodoTaskList[]> {
    const out: TodoTaskList[] = [];
    let path: string | undefined = '/v1.0/me/todo/lists';
    for (let page = 0; path && page < 10; page++) {
      const r = TodoListsPage.parse(await this.call('GET', path));
      out.push(...r.value);
      const next = r['@odata.nextLink'];
      path = next?.startsWith(`${GRAPH_ORIGIN}/`) ? next.slice(GRAPH_ORIGIN.length) : undefined;
    }
    return out;
  }

  /**
   * 期限（dueDateTime）は UTC に直して返る。日付への直しは normalize.ts の dueDate（一番近い 0 時に丸める）。
   * 本人のタイムゾーンを引くには MailboxSettings.Read が要るので引かない（2026-11-08、実物で 403）
   */
  async deltaStart(listId: string): Promise<DeltaPage> {
    return DeltaPage.parse(await this.call('GET', `/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`));
  }

  deltaNext(link: string): Promise<DeltaPage> {
    return this.graph.deltaNext(link);
  }

  async createSubscription(input: { listId: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription> {
    const r = (await this.call('POST', '/v1.0/subscriptions', {
      changeType: 'created,updated,deleted',
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: `me/todo/lists/${input.listId}/tasks`,
      expirationDateTime: input.expiresAt,
      clientState: input.clientState,
    })) as { id: string; expirationDateTime: string };
    return { id: r.id, expiresAt: new Date(r.expirationDateTime).toISOString() };
  }

  renewSubscription(id: string, expiresAt: string): Promise<string | null> {
    return this.graph.renewSubscription(id, expiresAt);
  }

  deleteSubscription(id: string): Promise<void> {
    return this.graph.deleteSubscription(id);
  }

  private call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return graphRequest(this.upstream, method, path, body);
  }
}

export { GraphError };
