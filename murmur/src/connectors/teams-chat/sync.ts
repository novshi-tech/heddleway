import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import type { ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import type { ConnectorStateStore } from '../../store/connector-state';
import { minutesBetween } from '../jira/plan';
import type { SyncJob, SyncQueue } from '../graph/jobs';
import type { SourceState, SubscriptionRecord, TeamsChatCursor, TeamsChatRecord } from '../graph/state';
import { expiresAfter, planLifecycle, planMaintenance, type SubscriptionAction } from '../graph/subscriptions';
import { TEAMS_SUBSCRIPTION_MINUTES } from '../teams/sync';
import type { TeamsChatApi } from './api';
import type { Chat } from './message';
import { normalizeChatMessage } from './normalize';
import { chatFloor, chatRecord, CHATS_FOLDER, MAX_CHATS_PER_SCAN, MAX_PAGES_PER_JOB, minus, needsCheck, OVERLAP_MINUTES, planChatsPage, planMessages, SAFETY_SYNC_MINUTES } from './plan';

// Teams のチャットのキューの仕事（0044 の決定 5）。本人の全チャットの購読の通知はヒントで、通知の来たチャットを読み直す。
// 保険の見回りで、チャットの一覧から前に読んだあとに動いたチャットを読む。位置（チャットごとの syncedUntil）は読み終えてから進める。
// サブスクリプションの台帳・通知の照合・キューは Outlook・Teams のチャネルと共有し、Teams のチャットの経路のデータソースだけを扱う。

export interface TeamsChatSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  queue: SyncQueue;
  /** データソースの本人の委任で Teams のチャットを呼ぶ口を作る */
  chatsFor(source: SourceState): Promise<TeamsChatApi>;
  now(): string;
  notificationUrl: string;
  newClientState(): string;
  hash(text: string): Promise<string>;
  log?(entry: Record<string, unknown>): void;
}

interface Ctx {
  source: SourceState;
  ds: ServiceDataSource & { connector: { kind: 'teams-chat'; tenantId: string; objectId: string } };
  subs: SubscriptionRecord[];
  api: TeamsChatApi | null;
}

export class TeamsChatSync {
  constructor(private readonly deps: TeamsChatSyncDeps) {}

  /** directory は maintain のとき、ほかのコネクタと見回り 1 回のマスタの読み込みを共有するために渡す */
  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'teams-chat') continue;
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), { allowDisconnected: true, directory: loadDirectory }).catch((err: unknown) => {
            this.deps.log?.({ msg: 'teams_chat_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        return;
      }
      case 'setup':
        return this.guard(job.dataSourceId, (ctx) => this.setup(ctx));
      case 'sync':
        return this.guard(job.dataSourceId, (ctx) => (job.chatId ? this.readChat(ctx, job.chatId) : this.scan(ctx)));
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

  private async guard(dataSourceId: string, run: (ctx: Ctx) => Promise<void>, opts: { allowDisconnected?: boolean; directory?: DirectoryLoader } = {}): Promise<void> {
    const source = await this.deps.state.source(dataSourceId);
    if (!source || source.kind !== 'teams-chat') return;
    if (source.status === 'disconnected' && !opts.allowDisconnected) return;
    const ds = (await (opts.directory ?? (() => this.deps.service.directory()))()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'teams-chat') return;
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
    const plan = planMaintenance(ctx.source, ctx.subs, [CHATS_FOLDER], this.deps.now(), this.deps.notificationUrl);
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

  /** つないだ直後・broken からの戻り: サブスクリプションをそろえ、見回って ok にする */
  private async setup(ctx: Ctx): Promise<void> {
    const now = this.deps.now();
    const plan = planMaintenance({ ...ctx.source, status: 'ok', lastSyncAt: now }, ctx.subs, [CHATS_FOLDER], now, this.deps.notificationUrl);
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
      objectId: ctx.ds.connector.objectId,
      notificationUrl: this.deps.notificationUrl,
      clientState,
      expiresAt: expiresAfter(this.deps.now(), TEAMS_SUBSCRIPTION_MINUTES),
    });
    const record: SubscriptionRecord = {
      id: created.id,
      dataSourceId: ctx.ds.id,
      folder: CHATS_FOLDER,
      clientStateHash: await this.deps.hash(clientState),
      expiresAt: created.expiresAt,
      notificationUrl: this.deps.notificationUrl,
    };
    await this.deps.state.putSubscription(record);
    ctx.subs = [...ctx.subs, record];
  }

  /**
   * 保険の見回り: チャットの一覧を新しい順に読み、前に読んだあとに動いたチャットを読む。
   * 一覧の重なりより古いチャットに当たったら止める。読むチャットの上限を超えたら、位置を進めずに続きを積む
   */
  private async scan(ctx: Ctx): Promise<void> {
    const api = await this.api(ctx);
    const startedAt = this.deps.now();
    const listFloor = minus(this.cursor(ctx).syncedUntil, OVERLAP_MINUTES);
    let next: string | undefined;
    let read = 0;
    for (let page = 0; page < MAX_PAGES_PER_JOB; page++) {
      const r = await api.chats(next);
      const plan = planChatsPage(r.chats, listFloor, this.cursor(ctx).chats, ctx.source.connectedAt, startedAt);
      for (const chat of plan.read) {
        if (read >= MAX_CHATS_PER_SCAN) {
          this.deps.log?.({ msg: 'teams_chat_scan_capped', dataSourceId: ctx.ds.id });
          await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder: CHATS_FOLDER });
          return;
        }
        read++;
        await this.readChat(ctx, chat.id, chat);
      }
      if (plan.done || !r.next) {
        await this.put(ctx, { teamsChat: { ...this.cursor(ctx), syncedUntil: startedAt }, lastSyncAt: startedAt });
        return;
      }
      next = r.next;
    }
    this.deps.log?.({ msg: 'teams_chat_scan_paged_out', dataSourceId: ctx.ds.id });
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder: CHATS_FOLDER });
  }

  /** チャット 1 つを、そのチャットの位置から読む。種類とメンバーは覚えておき、古ければ読み直す */
  private async readChat(ctx: Ctx, chatId: string, listed?: Chat): Promise<void> {
    const api = await this.api(ctx);
    const startedAt = this.deps.now();
    let record: TeamsChatRecord | undefined = this.cursor(ctx).chats[chatId];
    if (needsCheck(record, startedAt)) {
      const chat = (await api.chat(chatId)) ?? (listed ? { ...listed, chatType: 'unknownFutureValue' } : { id: chatId, chatType: 'unknownFutureValue' });
      const members = chat.chatType === 'oneOnOne' || chat.chatType === 'group' ? await api.members(chatId) : [];
      record = { ...chatRecord(chat, members, ctx.ds.connector.objectId, startedAt), ...(record?.syncedUntil ? { syncedUntil: record.syncedUntil } : {}) };
      await this.putChat(ctx, chatId, record);
    }
    if (record!.kind === 'skip') return;
    const since = chatFloor(record, ctx.source.connectedAt);
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_JOB; page++) {
      const r = await api.messages(chatId, since, next);
      if (!r) {
        // 読めなくなった（抜けた・消えた）。次に種類を読み直すまで取り込まない
        await this.putChat(ctx, chatId, { ...record!, kind: 'skip', checkedAt: startedAt });
        return;
      }
      for (const msg of planMessages(r.messages, ctx.source.connectedAt)) {
        const n = normalizeChatMessage({ dataSourceId: ctx.ds.id, chatId, record: record!, self: ctx.ds.connector }, msg);
        if (n.kind === 'skip') continue;
        await this.deps.service.ingestItem(n.signal);
      }
      if (!r.next) {
        await this.putChat(ctx, chatId, { ...record!, syncedUntil: startedAt });
        return;
      }
      next = r.next;
    }
    // ページの上限: 位置は進めずに続きを積む（取り込み済みは重複排除で落ちる）
    this.deps.log?.({ msg: 'teams_chat_read_paged_out', dataSourceId: ctx.ds.id });
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder: CHATS_FOLDER, chatId });
  }

  private scanDue(ctx: Ctx): boolean {
    return !ctx.source.lastSyncAt || minutesBetween(ctx.source.lastSyncAt, this.deps.now()) >= SAFETY_SYNC_MINUTES;
  }

  private cursor(ctx: Ctx): TeamsChatCursor {
    return ctx.source.teamsChat ?? { syncedUntil: ctx.source.connectedAt, chats: {} };
  }

  private async putChat(ctx: Ctx, chatId: string, record: TeamsChatRecord): Promise<void> {
    const cursor = this.cursor(ctx);
    await this.put(ctx, { teamsChat: { ...cursor, chats: { ...cursor.chats, [chatId]: record } } });
  }

  private async api(ctx: Ctx): Promise<TeamsChatApi> {
    ctx.api ??= await this.deps.chatsFor(ctx.source);
    return ctx.api;
  }

  private async put(ctx: Ctx, patch: Partial<SourceState>) {
    ctx.source = { ...ctx.source, ...patch };
    await this.deps.state.putSource(ctx.source);
  }
}
