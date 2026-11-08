import type { MurmurService } from '../../app/service';
import { renameTaskList, type ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import type { ConnectorStateStore } from '../../store/connector-state';
import { GraphError } from '../graph/api';
import type { SyncJob, SyncQueue } from '../graph/jobs';
import type { SourceState, SubscriptionRecord } from '../graph/state';
import { expiresAfter, planLifecycle, planMaintenance, type SubscriptionAction } from '../graph/subscriptions';
import { TODO_SUBSCRIPTION_MINUTES, type TodoApi } from './api';
import { normalizeTask } from './normalize';
import { TodoTask } from './task';

// To Do のキューの仕事（0039 の決定 3）。通知はヒントで、正はタスクの delta。位置（delta の link）は取り込んだページの分だけ進める。
// 写しは冪等（同じ値なら何もしない）なので、取り直しても二重にならない。サブスクリプションの台帳・通知の照合・キューは Outlook と共有し、
// To Do の経路（connector.kind = graph-todo）のデータソースだけを扱う。サブスクリプションの「フォルダ」はタスクのリストの ID

/** 1 回の仕事で読むページの上限。超えたら続きをキューに積む */
export const MAX_PAGES_PER_JOB = 20;

export interface TodoSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  queue: SyncQueue;
  /** データソースの本人の同意で To Do を呼ぶ口を作る */
  todoFor(source: SourceState): Promise<TodoApi>;
  now(): string;
  /** /webhooks/graph の URL（Outlook と共有） */
  notificationUrl: string;
  newClientState(): string;
  hash(text: string): Promise<string>;
  log?(entry: Record<string, unknown>): void;
}

interface Ctx {
  source: SourceState;
  ds: ServiceDataSource & { connector: { kind: 'graph-todo'; listId: string; listName: string } };
  /** 本人のアカウント（チャネル todo のアドレス） */
  account: string;
  subs: SubscriptionRecord[];
  api: TodoApi | null;
}

export class TodoSync {
  constructor(private readonly deps: TodoSyncDeps) {}

  async handle(job: SyncJob): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'todo') continue;
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), { allowDisconnected: true }).catch((err: unknown) => {
            this.deps.log?.({ msg: 'todo_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        return;
      }
      case 'setup':
        return this.guard(job.dataSourceId, (ctx) => this.setup(ctx));
      case 'sync':
        return this.guard(job.dataSourceId, (ctx) => this.syncList(ctx).then(() => undefined));
      case 'lifecycle': {
        const sub = await this.deps.state.subscription(job.subscriptionId);
        if (!sub) return;
        return this.guard(sub.dataSourceId, async (ctx) => {
          const plan = planLifecycle(job.event, sub);
          await this.apply(ctx, plan.actions);
          if (plan.sync) await this.syncList(ctx);
        });
      }
      case 'disconnect':
        return this.guard(job.dataSourceId, (ctx) => this.apply(ctx, ctx.subs.map((s) => ({ kind: 'delete', subscription: s }))), { allowDisconnected: true });
      default:
        return;
    }
  }

  private async guard(dataSourceId: string, run: (ctx: Ctx) => Promise<void>, opts: { allowDisconnected?: boolean } = {}): Promise<void> {
    const source = await this.deps.state.source(dataSourceId);
    if (!source || source.kind !== 'todo') return;
    if (source.status === 'disconnected' && !opts.allowDisconnected) return;
    const dir = await this.deps.service.directory();
    const ds = dir.dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'graph-todo') return;
    const account = dir.credentialRef(ds.credentialRefId)?.address.value ?? '';
    const ctx: Ctx = { source, ds: ds as Ctx['ds'], account, subs: await this.deps.state.subscriptions(dataSourceId), api: null };
    try {
      await run(ctx);
    } catch (err) {
      if (!(err instanceof GatewayAuthError)) throw err;
      const latest = (await this.deps.state.source(dataSourceId)) ?? source;
      // 外したもの（disconnect の仕事の途中で同意が切れた）は外したままにする。broken にすると見回りが勝手につなぎ直す
      if (latest.status === 'disconnected') {
        this.deps.log?.({ msg: 'connector_disconnect_unclean', dataSourceId, reason: err.message });
        return;
      }
      await this.deps.state.putSource({ ...latest, status: 'broken', reason: err.message, lastRetryAt: this.deps.now() });
      this.deps.log?.({ msg: 'connector_broken', dataSourceId, reason: err.message });
    }
  }

  private async maintain(ctx: Ctx): Promise<void> {
    const plan = planMaintenance(ctx.source, ctx.subs, [ctx.ds.connector.listId], this.deps.now(), this.deps.notificationUrl);
    if (plan.kind === 'idle') return;
    if (plan.kind === 'retry') {
      await this.put(ctx, { lastRetryAt: this.deps.now() });
      return this.setup(ctx);
    }
    await this.apply(ctx, plan.actions);
    if (plan.sync) {
      await this.refreshList(ctx);
      await this.syncList(ctx);
    }
  }

  /**
   * To Do の側でリストの名前が変わっていれば、データソースの名前と写しの statusLabel を直す（位置を捨てて読み直し、写しを直す。写しは冪等）。
   * リストがなくなっていれば止める（broken。本人に伝わる）
   */
  private async refreshList(ctx: Ctx): Promise<void> {
    const list = (await (await this.api(ctx)).lists()).find((l) => l.id === ctx.ds.connector.listId);
    if (!list) throw new GatewayAuthError(`To Do のリスト ${ctx.ds.connector.listName} が見つからない（消したか、見えなくなった）`);
    if (list.displayName === ctx.ds.connector.listName) return;
    const { result } = await this.deps.service.changeMaster(null, 'To Do のリストの名前が変わった', (d) => renameTaskList(d, ctx.ds.id, list.displayName));
    if (!result) return;
    this.deps.log?.({ msg: 'todo_list_renamed', dataSourceId: ctx.ds.id });
    ctx.ds = { ...ctx.ds, connector: { ...ctx.ds.connector, listName: list.displayName } };
    await this.putCursor(ctx, ctx.ds.connector.listId, { link: null, lastReceivedAt: ctx.source.folders[ctx.ds.connector.listId]?.lastReceivedAt ?? null });
  }

  /** つないだ直後・broken からの戻り: サブスクリプションをそろえ、リストを読み切って ok にする */
  private async setup(ctx: Ctx): Promise<void> {
    await this.refreshList(ctx);
    const now = this.deps.now();
    const plan = planMaintenance({ ...ctx.source, status: 'ok', lastSyncAt: now }, ctx.subs, [ctx.ds.connector.listId], now, this.deps.notificationUrl);
    if (plan.kind === 'maintain') await this.apply(ctx, plan.actions);
    await this.syncList(ctx);
    await this.put(ctx, { status: 'ok', reason: null });
  }

  private async apply(ctx: Ctx, actions: SubscriptionAction[]): Promise<void> {
    const { state, now } = this.deps;
    for (const a of actions) {
      const api = await this.api(ctx);
      if (a.kind === 'delete') {
        await api.deleteSubscription(a.subscription.id);
        await state.deleteSubscription(a.subscription.id);
        ctx.subs = ctx.subs.filter((s) => s.id !== a.subscription.id);
      } else if (a.kind === 'renew') {
        const expiresAt = await api.renewSubscription(a.subscription.id, expiresAfter(now(), TODO_SUBSCRIPTION_MINUTES));
        if (expiresAt) {
          await state.putSubscription({ ...a.subscription, expiresAt });
          continue;
        }
        // もうない: 作り直して、その間の分を取り直す
        await state.deleteSubscription(a.subscription.id);
        ctx.subs = ctx.subs.filter((s) => s.id !== a.subscription.id);
        await this.create(ctx);
        await this.syncList(ctx);
      } else {
        await this.create(ctx);
      }
    }
  }

  /** 作成の最中に Graph が受け口を検証しに来るので、台帳は作れたあとに書く。照合に間に合わない通知は捨てても delta が拾う */
  private async create(ctx: Ctx): Promise<void> {
    const api = await this.api(ctx);
    const clientState = this.deps.newClientState();
    const listId = ctx.ds.connector.listId;
    const created = await api.createSubscription({
      listId,
      notificationUrl: this.deps.notificationUrl,
      clientState,
      expiresAt: expiresAfter(this.deps.now(), TODO_SUBSCRIPTION_MINUTES),
    });
    const record: SubscriptionRecord = {
      id: created.id,
      dataSourceId: ctx.ds.id,
      folder: listId,
      clientStateHash: await this.deps.hash(clientState),
      expiresAt: created.expiresAt,
      notificationUrl: this.deps.notificationUrl,
    };
    await this.deps.state.putSubscription(record);
    ctx.subs = [...ctx.subs, record];
  }

  /** タスクの delta。読み切れば true、ページの上限で止めたら続きを積んで false */
  private async syncList(ctx: Ctx): Promise<boolean> {
    const api = await this.api(ctx);
    const listId = ctx.ds.connector.listId;
    const taskCtx = { dataSourceId: ctx.ds.id, account: ctx.account, listName: ctx.ds.connector.listName, connectedAt: ctx.source.connectedAt };
    for (let page = 0; page < MAX_PAGES_PER_JOB; page++) {
      const cursor = ctx.source.folders[listId] ?? { link: null, lastReceivedAt: null };
      let result;
      try {
        result = cursor.link ? await api.deltaNext(cursor.link) : await api.deltaStart(listId);
      } catch (err) {
        // delta の位置が無効になった: 最初から読み直す（写しは冪等なので、変わっていないものは何もしない）
        if (err instanceof GraphError && err.status === 410 && cursor.link) {
          this.deps.log?.({ msg: 'todo_delta_reset', dataSourceId: ctx.ds.id });
          await this.putCursor(ctx, listId, { link: null, lastReceivedAt: cursor.lastReceivedAt });
          continue;
        }
        throw err;
      }
      let lastModified = cursor.lastReceivedAt;
      const tasks = result.value
        .map((raw) => TodoTask.safeParse(raw))
        .flatMap((r) => (r.success ? [r.data] : []))
        .sort((a, b) => (a.lastModifiedDateTime ?? '').localeCompare(b.lastModifiedDateTime ?? ''));
      for (const task of tasks) {
        const n = normalizeTask(taskCtx, task);
        if (n.kind === 'skip') continue;
        await this.deps.service.ingestItem(n.mirror);
        if (task.lastModifiedDateTime && (!lastModified || task.lastModifiedDateTime > lastModified)) lastModified = task.lastModifiedDateTime;
      }
      const next = result['@odata.nextLink'] ?? result['@odata.deltaLink'] ?? null;
      await this.putCursor(ctx, listId, { link: next, lastReceivedAt: lastModified });
      if (!result['@odata.nextLink']) {
        await this.put(ctx, { lastSyncAt: this.deps.now() });
        return true;
      }
    }
    this.deps.log?.({ msg: 'todo_sync_paged_out', dataSourceId: ctx.ds.id });
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder: listId });
    return false;
  }

  private async api(ctx: Ctx): Promise<TodoApi> {
    ctx.api ??= await this.deps.todoFor(ctx.source);
    return ctx.api;
  }

  private async putCursor(ctx: Ctx, listId: string, cursor: SourceState['folders'][string]) {
    await this.put(ctx, { folders: { ...ctx.source.folders, [listId]: cursor } });
  }

  private async put(ctx: Ctx, patch: Partial<SourceState>) {
    ctx.source = { ...ctx.source, ...patch };
    await this.deps.state.putSource(ctx.source);
  }
}
