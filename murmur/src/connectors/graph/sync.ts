import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import type { ServiceDataSource } from '../../domain';
import type { ConnectorStateStore } from '../../store/connector-state';
import { GatewayAuthError } from '../../ports/gateway';
import { GraphError, type GraphApi } from './api';
import type { SyncJob, SyncQueue } from './jobs';
import { GraphMessage } from './message';
import { normalizeMessage } from './normalize';
import type { SourceState, SubscriptionRecord } from './state';
import { expiresAfter, planLifecycle, planMaintenance, type SubscriptionAction } from './subscriptions';

// キューの仕事を 1 つずつこなす（同時実行 1）。通知はヒントで、正は delta（0024 の決定 2）。
// cursor は取り込みが終わったページの分だけ進めるので、途中で落ちても同じ差分を取り直し、sourceRef の重複排除で二重にならない。

/** 1 回の仕事で読むページの上限。超えたら続きをキューに積む */
export const MAX_PAGES_PER_JOB = 20;

export interface GraphSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  queue: SyncQueue;
  /** データソースの本人の同意で Graph を呼ぶ口を作る（issue_token する） */
  graphFor(source: SourceState): Promise<GraphApi>;
  now(): string;
  /** /webhooks/graph の URL */
  notificationUrl: string;
  newClientState(): string;
  hash(text: string): Promise<string>;
  log?(entry: Record<string, unknown>): void;
}

export class GraphMailSync {
  constructor(private readonly deps: GraphSyncDeps) {}

  /** directory は maintain のとき、ほかのコネクタと見回り 1 回のマスタの読み込みを共有するために渡す（なければこの 1 回だけ読む） */
  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        // 1 つのデータソースの失敗でほかの手入れを止めない（失敗したものは次の見回りでまた試す）
        let failed = 0;
        for (const s of await this.deps.state.sources()) {
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), { directory: loadDirectory }).catch((err: unknown) => {
            failed++;
            this.deps.log?.({ msg: 'maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        if (failed > 0) this.deps.log?.({ msg: 'maintain_done', failed });
        return;
      }
      case 'setup':
        return this.guard(job.dataSourceId, (ctx) => this.setup(ctx));
      case 'sync':
        return this.guard(job.dataSourceId, (ctx) => this.syncFolders(ctx, [job.folder]));
      case 'lifecycle': {
        const sub = await this.deps.state.subscription(job.subscriptionId);
        if (!sub) return;
        return this.guard(sub.dataSourceId, async (ctx) => {
          const plan = planLifecycle(job.event, sub);
          await this.apply(ctx, plan.actions);
          if (plan.sync) await this.syncFolders(ctx, [sub.folder]);
        });
      }
      case 'disconnect':
        return this.guard(job.dataSourceId, (ctx) => this.apply(ctx, ctx.subs.map((s) => ({ kind: 'delete', subscription: s }))), { allowDisconnected: true });
    }
  }

  /**
   * データソースの状態を読んで仕事をする。同意の問題（GatewayAuthError）なら broken にして止める（ほかの失敗はキューが試し直す）。
   * disconnected のデータソースは、外す仕事のほかは何もしない
   */
  private async guard(dataSourceId: string, run: (ctx: SourceContext) => Promise<void>, opts: { allowDisconnected?: boolean; directory?: DirectoryLoader } = {}): Promise<void> {
    const source = await this.deps.state.source(dataSourceId);
    if (!source) return;
    if (source.status === 'disconnected' && !opts.allowDisconnected) return;
    const ds = (await (opts.directory ?? (() => this.deps.service.directory()))()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'graph-mail') return;
    const ctx: SourceContext = { source, ds, folders: ds.connector.folders, subs: await this.deps.state.subscriptions(dataSourceId), graph: null };
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

  private async maintain(ctx: SourceContext): Promise<void> {
    const plan = planMaintenance(ctx.source, ctx.subs, ctx.folders, this.deps.now(), this.deps.notificationUrl);
    if (plan.kind === 'idle') return;
    if (plan.kind === 'retry') {
      await this.putSource(ctx, { lastRetryAt: this.deps.now() });
      return this.setup(ctx);
    }
    await this.apply(ctx, plan.actions);
    if (plan.sync) await this.syncFolders(ctx, ctx.folders);
  }

  /** サブスクリプションをそろえ、全フォルダを取り直して ok にする（つないだ直後・broken からの戻り） */
  private async setup(ctx: SourceContext): Promise<void> {
    const now = this.deps.now();
    const plan = planMaintenance({ ...ctx.source, status: 'ok', lastSyncAt: now }, ctx.subs, ctx.folders, now, this.deps.notificationUrl);
    if (plan.kind === 'maintain') await this.apply(ctx, plan.actions);
    await this.syncFolders(ctx, ctx.folders);
    await this.putSource(ctx, { status: 'ok', reason: null });
  }

  private async apply(ctx: SourceContext, actions: SubscriptionAction[]): Promise<void> {
    const { state, now } = this.deps;
    for (const a of actions) {
      const graph = await this.graph(ctx);
      if (a.kind === 'delete') {
        await graph.deleteSubscription(a.subscription.id);
        await state.deleteSubscription(a.subscription.id);
        ctx.subs = ctx.subs.filter((s) => s.id !== a.subscription.id);
      } else if (a.kind === 'renew') {
        const expiresAt = await graph.renewSubscription(a.subscription.id, expiresAfter(now()));
        if (expiresAt) {
          await state.putSubscription({ ...a.subscription, expiresAt });
          continue;
        }
        // もうない: 作り直して、その間の分を取り直す
        await state.deleteSubscription(a.subscription.id);
        ctx.subs = ctx.subs.filter((s) => s.id !== a.subscription.id);
        await this.create(ctx, a.subscription.folder);
        await this.syncFolders(ctx, [a.subscription.folder]);
      } else {
        await this.create(ctx, a.folder);
      }
    }
  }

  /** 作成の最中に Graph が受け口を検証しに来るので、台帳は作れたあとに書く。照合に間に合わない通知は捨てても delta が拾う */
  private async create(ctx: SourceContext, folder: string): Promise<void> {
    const graph = await this.graph(ctx);
    const clientState = this.deps.newClientState();
    const created = await graph.createSubscription({
      folder,
      notificationUrl: this.deps.notificationUrl,
      clientState,
      expiresAt: expiresAfter(this.deps.now()),
    });
    const record: SubscriptionRecord = {
      id: created.id,
      dataSourceId: ctx.ds.id,
      folder,
      clientStateHash: await this.deps.hash(clientState),
      expiresAt: created.expiresAt,
      notificationUrl: this.deps.notificationUrl,
    };
    await this.deps.state.putSubscription(record);
    ctx.subs = [...ctx.subs, record];
  }

  private async syncFolders(ctx: SourceContext, folders: readonly string[]): Promise<void> {
    let complete = true;
    for (const folder of folders) complete = (await this.syncFolder(ctx, folder)) && complete;
    if (complete && folders.length === ctx.folders.length) await this.putSource(ctx, { lastSyncAt: this.deps.now() });
  }

  /** 1 フォルダの delta。読み切れば true、ページの上限で止めたら続きを積んで false */
  private async syncFolder(ctx: SourceContext, folder: string): Promise<boolean> {
    const graph = await this.graph(ctx);
    for (let page = 0; page < MAX_PAGES_PER_JOB; page++) {
      const cursor = ctx.source.folders[folder] ?? { link: null, lastReceivedAt: null };
      let result;
      try {
        result = cursor.link ? await graph.deltaNext(cursor.link) : await graph.deltaStart(folder, cursor.lastReceivedAt ?? ctx.source.connectedAt);
      } catch (err) {
        // delta の位置が無効になった: 最後に取り込んだ時刻から取り直す（取り込み済みは重複排除で落ちる）
        if (err instanceof GraphError && err.status === 410 && cursor.link) {
          this.deps.log?.({ msg: 'delta_reset', dataSourceId: ctx.ds.id, folder });
          await this.putCursor(ctx, folder, { ...cursor, link: null });
          continue;
        }
        throw err;
      }
      let lastReceivedAt = cursor.lastReceivedAt;
      const messages = result.value
        .map((raw) => GraphMessage.safeParse(raw))
        .flatMap((r) => (r.success ? [r.data] : []))
        .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
      for (const msg of messages) {
        const n = normalizeMessage(ctx.ds.id, msg);
        if (n.kind === 'skip') continue;
        await this.deps.service.ingestItem(n.signal);
        if (msg.receivedDateTime && (!lastReceivedAt || msg.receivedDateTime > lastReceivedAt)) lastReceivedAt = msg.receivedDateTime;
      }
      const next = result['@odata.nextLink'] ?? result['@odata.deltaLink'] ?? null;
      await this.putCursor(ctx, folder, { link: next, lastReceivedAt });
      if (!result['@odata.nextLink']) return true;
    }
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder });
    return false;
  }

  private async graph(ctx: SourceContext): Promise<GraphApi> {
    ctx.graph ??= await this.deps.graphFor(ctx.source);
    return ctx.graph;
  }

  private async putCursor(ctx: SourceContext, folder: string, cursor: SourceState['folders'][string]) {
    await this.putSource(ctx, { folders: { ...ctx.source.folders, [folder]: cursor } });
  }

  private async putSource(ctx: SourceContext, patch: Partial<SourceState>) {
    ctx.source = { ...ctx.source, ...patch };
    await this.deps.state.putSource(ctx.source);
  }
}

interface SourceContext {
  source: SourceState;
  ds: ServiceDataSource;
  folders: readonly string[];
  subs: SubscriptionRecord[];
  graph: GraphApi | null;
}
