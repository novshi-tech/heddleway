import type { MurmurService } from '../../app/service';
import { syncSharedReaders, type ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import type { ConnectorStateStore } from '../../store/connector-state';
import { minutesBetween } from '../jira/plan';
import type { SyncJob, SyncQueue } from '../graph/jobs';
import type { SourceState, SubscriptionRecord, TeamsCursor } from '../graph/state';
import { expiresAfter, planLifecycle, planMaintenance, type SubscriptionAction } from '../graph/subscriptions';
import type { TeamsApi } from './api';
import { normalizeChannelMessage } from './normalize';
import { MAX_PAGES_PER_JOB, planPage, READERS_SYNC_MINUTES, SAFETY_SYNC_MINUTES, TEAMS_FOLDER, teamsMembers } from './plan';

// Teams のキューの仕事（0036 の決定 6）。通知はヒントで、正は投稿の一覧（返信つき）の走査。位置（syncedUntil）は読み終えてから進める。
// サブスクリプションの台帳・通知の照合・キューは Outlook と共有し、Teams の経路のデータソースだけを扱う。

export interface TeamsSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  queue: SyncQueue;
  /** データソースのつないだ人の委任で Teams を呼ぶ口を作る */
  teamsFor(source: SourceState): Promise<TeamsApi>;
  now(): string;
  notificationUrl: string;
  newClientState(): string;
  hash(text: string): Promise<string>;
  log?(entry: Record<string, unknown>): void;
}

interface Ctx {
  source: SourceState;
  ds: ServiceDataSource & { connector: { kind: 'teams'; teamId: string; channelId: string } };
  subs: SubscriptionRecord[];
  api: TeamsApi | null;
}

export class TeamsSync {
  constructor(private readonly deps: TeamsSyncDeps) {}

  async handle(job: SyncJob): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'teams') continue;
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), { allowDisconnected: true }).catch((err: unknown) => {
            this.deps.log?.({ msg: 'teams_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        return;
      }
      case 'setup':
        return this.guard(job.dataSourceId, (ctx) => this.setup(ctx));
      case 'sync':
        return this.guard(job.dataSourceId, (ctx) => this.scan(ctx));
      case 'lifecycle': {
        const sub = await this.deps.state.subscription(job.subscriptionId);
        if (!sub) return;
        return this.guard(sub.dataSourceId, async (ctx) => {
          const plan = planLifecycle(job.event, sub);
          await this.apply(ctx, plan.actions);
          if (plan.sync) await this.scan(ctx);
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
    if (!source || source.kind !== 'teams') return;
    if (source.status === 'disconnected' && !opts.allowDisconnected) return;
    const ds = (await this.deps.service.directory()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'teams') return;
    const ctx: Ctx = { source, ds: ds as Ctx['ds'], subs: await this.deps.state.subscriptions(dataSourceId), api: null };
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
    if (ctx.source.status === 'ok' && this.readersDue(ctx)) await this.syncReaders(ctx);
    const plan = planMaintenance(ctx.source, ctx.subs, [TEAMS_FOLDER], this.deps.now(), this.deps.notificationUrl);
    if (plan.kind === 'idle') {
      if (ctx.source.status === 'ok' && this.scanDue(ctx)) await this.scan(ctx);
      return;
    }
    if (plan.kind === 'retry') {
      await this.put(ctx, { lastRetryAt: this.deps.now() });
      return this.setup(ctx);
    }
    await this.apply(ctx, plan.actions);
    if (plan.sync || this.scanDue(ctx)) await this.scan(ctx);
  }

  /** つないだ直後・broken からの戻り: 読者を写し、サブスクリプションをそろえ、走査して ok にする */
  private async setup(ctx: Ctx): Promise<void> {
    await this.syncReaders(ctx);
    const now = this.deps.now();
    const plan = planMaintenance({ ...ctx.source, status: 'ok', lastSyncAt: now }, ctx.subs, [TEAMS_FOLDER], now, this.deps.notificationUrl);
    if (plan.kind === 'maintain') await this.apply(ctx, plan.actions);
    await this.scan(ctx);
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
        const expiresAt = await api.renewSubscription(a.subscription.id, expiresAfter(now(), TEAMS_SUBSCRIPTION_MINUTES));
        if (expiresAt) {
          await state.putSubscription({ ...a.subscription, expiresAt });
          continue;
        }
        await state.deleteSubscription(a.subscription.id);
        ctx.subs = ctx.subs.filter((s) => s.id !== a.subscription.id);
        await this.create(ctx);
      } else {
        await this.create(ctx);
      }
    }
  }

  private async create(ctx: Ctx): Promise<void> {
    const api = await this.api(ctx);
    const clientState = this.deps.newClientState();
    const created = await api.createSubscription({
      teamId: ctx.ds.connector.teamId,
      channelId: ctx.ds.connector.channelId,
      notificationUrl: this.deps.notificationUrl,
      clientState,
      expiresAt: expiresAfter(this.deps.now(), TEAMS_SUBSCRIPTION_MINUTES),
    });
    const record: SubscriptionRecord = {
      id: created.id,
      dataSourceId: ctx.ds.id,
      folder: TEAMS_FOLDER,
      clientStateHash: await this.deps.hash(clientState),
      expiresAt: created.expiresAt,
      notificationUrl: this.deps.notificationUrl,
    };
    await this.deps.state.putSubscription(record);
    ctx.subs = [...ctx.subs, record];
  }

  /** 投稿の一覧を新しい順に読み、重なりより前に動いたきりのページまで辿る。読み切れなければ続きを積む */
  private async scan(ctx: Ctx): Promise<void> {
    const api = await this.api(ctx);
    const startedAt = this.deps.now();
    const cursor = this.cursor(ctx);
    const { teamId, channelId } = ctx.ds.connector;
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_JOB; page++) {
      const r = await api.messages(teamId, channelId, next);
      const plan = planPage(r.messages, cursor.syncedUntil, ctx.source.connectedAt);
      for (const { msg, root } of plan.items) {
        const n = normalizeChannelMessage(ctx.ds.id, channelId, msg, root);
        if (n.kind === 'skip') continue;
        await this.deps.service.ingestItem(n.signal);
      }
      if (plan.done || !r.next) {
        await this.put(ctx, { teams: { ...this.cursor(ctx), syncedUntil: startedAt }, lastSyncAt: startedAt });
        return;
      }
      next = r.next;
    }
    // ページの上限: 位置は進めずに続きを積む（次の走査は同じ起点から。取り込み済みは重複排除で落ちる）
    this.deps.log?.({ msg: 'teams_scan_paged_out', dataSourceId: ctx.ds.id });
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder: TEAMS_FOLDER });
  }

  /** 読者をチャネルのメンバーに合わせる（0037 の決定 2）。つないだ人がメンバーでなくなれば broken */
  private async syncReaders(ctx: Ctx): Promise<void> {
    const members = teamsMembers(await (await this.api(ctx)).members(ctx.ds.connector.teamId, ctx.ds.connector.channelId));
    const { result } = await this.deps.service.changeMaster(null, 'Teams の読者の同期', (d, c) => syncSharedReaders(d, c, ctx.ds.id, members));
    await this.put(ctx, { teams: { ...this.cursor(ctx), readersSyncedAt: this.deps.now() } });
    if (result.added.length > 0 || result.removed.length > 0) {
      this.deps.log?.({ msg: 'teams_readers_synced', dataSourceId: ctx.ds.id, added: result.added.length, removed: result.removed.length });
    }
    if (result.ownerLost) throw new GatewayAuthError('つないだ人がチャネルのメンバーでなくなった。ほかの読者がつなぎ直す');
  }

  private readersDue(ctx: Ctx): boolean {
    const at = ctx.source.teams?.readersSyncedAt;
    return !at || minutesBetween(at, this.deps.now()) >= READERS_SYNC_MINUTES;
  }

  private scanDue(ctx: Ctx): boolean {
    return !ctx.source.lastSyncAt || minutesBetween(ctx.source.lastSyncAt, this.deps.now()) >= SAFETY_SYNC_MINUTES;
  }

  private cursor(ctx: Ctx): TeamsCursor {
    return ctx.source.teams ?? { syncedUntil: ctx.source.connectedAt };
  }

  private async api(ctx: Ctx): Promise<TeamsApi> {
    ctx.api ??= await this.deps.teamsFor(ctx.source);
    return ctx.api;
  }

  private async put(ctx: Ctx, patch: Partial<SourceState>) {
    ctx.source = { ...ctx.source, ...patch };
    await this.deps.state.putSource(ctx.source);
  }
}

/** Teams のチャネルのメッセージのサブスクリプションの期限（S0 で 3 日を受け付けた。少し手前にする） */
export const TEAMS_SUBSCRIPTION_MINUTES = 3 * 24 * 60 - 10;
