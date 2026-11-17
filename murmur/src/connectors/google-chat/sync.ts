import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import { syncSharedReaders, type ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import { GoogleApiNotEnabled } from '../google-error';
import type { ConnectorStateStore } from '../../store/connector-state';
import type { SyncJob } from '../graph/jobs';
import type { GoogleChatDmRecord, SourceState } from '../graph/state';
import { GoogleChatError, type GoogleChatApi } from './api';
import type { ChatSpace } from './message';
import { normalizeChatMessage, type ChatContext } from './normalize';
import { advance, chatMembers, dmRecord, MAX_PAGES_PER_SPACE, minus, minutesSince, needsCheck, OVERLAP_MINUTES, planDmSpaces, planMessages, planPoll, READERS_SYNC_MINUTES } from './plan';

// Google Chat の取り込み（0045）。変更の通知は使わず、5 分ごとの見回り（maintain）で createTime の差分を読む（0041 の決定 1）。
// - スペース（kind google-chat）: 共有リスト。データソースのスペースのメッセージを読み、読者をメンバーから写す（0037）
// - DM・グループ（kind google-chat-dm）: 本人の個人リスト。本人のスペースの一覧の lastActiveTime で動いたものだけを読む
// 購読がないので、キューの仕事は maintain と setup だけ。同意の問題と、Chat API がゲートウェイのプロジェクトで有効でないことは
// broken にして止め、そのほかの失敗（上限を含む）は次の見回りが試し直す。
// 書き込みは、そのつど今のデータソースの状態を読み直して、見回りが持つ項目だけを重ねる。読んでいる間に外された・別の接続に
// つなぎ直された場合は、何も書かずに止める（0041 の Google Tasks と同じ）

export interface GoogleChatSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  /** データソースの委任で Google Chat を呼ぶ口を作る（スペースと DM で読める口が違う） */
  chatFor(source: SourceState): Promise<GoogleChatApi>;
  now(): string;
  log?(entry: Record<string, unknown>): void;
}

/** 読んでいる間に、外された・別の接続につなぎ直された。何も書かずに止める */
class SyncSuperseded extends Error {}

type SpaceDs = ServiceDataSource & { connector: { kind: 'google-chat'; space: string; threaded: boolean } };
type DmDs = ServiceDataSource & { connector: { kind: 'google-chat-dm'; account: string } };

interface Ctx<D> {
  source: SourceState;
  credentialId: string;
  ds: D;
  api: GoogleChatApi | null;
}

export class GoogleChatSync {
  constructor(private readonly deps: GoogleChatSyncDeps) {}

  /** directory は maintain のとき、ほかのコネクタと見回り 1 回のマスタの読み込みを共有するために渡す */
  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'google-chat' && s.kind !== 'google-chat-dm') continue;
          await this.run(s.dataSourceId, 'maintain', loadDirectory).catch((err: unknown) => {
            this.deps.log?.({ msg: 'google_chat_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        return;
      }
      case 'setup':
        return this.run(job.dataSourceId, 'setup');
      default:
        return;
    }
  }

  private async run(dataSourceId: string, what: 'maintain' | 'setup', directory?: DirectoryLoader): Promise<void> {
    const source = await this.deps.state.source(dataSourceId);
    if (!source || source.status === 'disconnected') return;
    if (source.kind !== 'google-chat' && source.kind !== 'google-chat-dm') return;
    const ds = (await (directory ?? (() => this.deps.service.directory()))()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service') return;
    const ctx = { source, credentialId: source.gatewayCredentialId, ds, api: null } as Ctx<ServiceDataSource>;
    try {
      if (source.kind === 'google-chat' && ds.connector?.kind === 'google-chat') {
        const c = ctx as Ctx<SpaceDs>;
        await (what === 'setup' ? this.setupSpace(c) : this.maintainSpace(c));
      } else if (source.kind === 'google-chat-dm' && ds.connector?.kind === 'google-chat-dm') {
        const c = ctx as Ctx<DmDs>;
        await (what === 'setup' ? this.setupDm(c) : this.maintainDm(c));
      }
    } catch (err) {
      if (err instanceof SyncSuperseded) {
        this.deps.log?.({ msg: 'google_chat_sync_superseded', dataSourceId });
        return;
      }
      if (!(err instanceof GatewayAuthError || err instanceof GoogleApiNotEnabled)) throw err;
      const latest = (await this.deps.state.source(dataSourceId)) ?? source;
      if (latest.gatewayCredentialId !== ctx.credentialId) return;
      if (latest.status === 'disconnected') {
        this.deps.log?.({ msg: 'connector_disconnect_unclean', dataSourceId, reason: err.message });
        return;
      }
      await this.deps.state.putSource({ ...latest, status: 'broken', reason: err.message, lastRetryAt: this.deps.now() });
      this.deps.log?.({ msg: 'connector_broken', dataSourceId, reason: err.message });
    }
  }

  // ---- スペース（共有リスト） ----

  private async maintainSpace(ctx: Ctx<SpaceDs>): Promise<void> {
    const plan = planPoll(ctx.source, ctx.source.googleChat?.setupAt, this.deps.now());
    switch (plan.kind) {
      case 'idle':
        return;
      case 'retry':
        await this.put(ctx, { lastRetryAt: this.deps.now() });
        return this.setupSpace(ctx);
      case 'setup':
        return this.setupSpace(ctx);
      case 'poll':
        if (minutesSince(ctx.source.googleChat?.readersSyncedAt, this.deps.now()) >= READERS_SYNC_MINUTES) await this.syncReaders(ctx);
        return this.readSpace(ctx);
    }
  }

  /** つないだ直後・broken からの戻り: 読者を写し、読んで ok にする */
  private async setupSpace(ctx: Ctx<SpaceDs>): Promise<void> {
    await this.syncReaders(ctx);
    await this.readSpace(ctx);
    await this.put(ctx, { status: 'ok', reason: null });
  }

  /** 読者をスペースのメンバーに合わせる（0037 の決定 2）。つないだ人がメンバーでなくなれば broken */
  private async syncReaders(ctx: Ctx<SpaceDs>): Promise<void> {
    let memberships;
    try {
      memberships = await (await this.api(ctx)).members(ctx.ds.connector.space);
    } catch (err) {
      throw this.spaceGone(ctx, err);
    }
    const members = chatMembers(memberships);
    const { result } = await this.deps.service.changeMaster(null, 'Google Chat の読者の同期', (d, c) => syncSharedReaders(d, c, ctx.ds.id, members));
    await this.update(ctx, (latest) => ({ googleChat: { syncedUntil: latest.connectedAt, ...latest.googleChat, readersSyncedAt: this.deps.now() } }));
    if (result.added.length > 0 || result.removed.length > 0) {
      this.deps.log?.({ msg: 'google_chat_readers_synced', dataSourceId: ctx.ds.id, added: result.added.length, removed: result.removed.length });
    }
    if (result.ownerLost) throw new GatewayAuthError('つないだ人がスペースのメンバーでなくなった。ほかの読者がつなぎ直す');
  }

  /** スペースのメッセージを、位置から重なりを引いた時刻より後から古い順に読む。ページの上限で止めたら、読んだところまで位置を進める */
  private async readSpace(ctx: Ctx<SpaceDs>): Promise<void> {
    const startedAt = this.deps.now();
    const { space, threaded } = ctx.ds.connector;
    const cursor = ctx.source.googleChat ?? { syncedUntil: ctx.source.connectedAt };
    const chat: ChatContext = { dataSourceId: ctx.ds.id, space, threaded };
    const read = await this.readMessages(ctx, chat, cursor.syncedUntil, cursor.pagedOut ?? false).catch((err: unknown) => {
      throw this.spaceGone(ctx, err);
    });
    await this.update(ctx, (latest) => ({ googleChat: { ...latest.googleChat, ...read }, lastSyncAt: startedAt }));
  }

  /** スペースが読めない（消えた・メンバーでなくなった）のは、この共有リストの接続の問題（broken。ほかの読者がつなぎ直す） */
  private spaceGone(ctx: Ctx<SpaceDs>, err: unknown): unknown {
    if (err instanceof GoogleChatError && (err.status === 403 || err.status === 404)) {
      return new GatewayAuthError(`Google Chat のスペース ${ctx.ds.name} が読めない（消えたか、つないだ人がメンバーでなくなった。${err.message}）`);
    }
    return err;
  }

  // ---- DM・グループ（個人リスト） ----

  private async maintainDm(ctx: Ctx<DmDs>): Promise<void> {
    const plan = planPoll(ctx.source, ctx.source.googleChatDm?.setupAt, this.deps.now());
    switch (plan.kind) {
      case 'idle':
        return;
      case 'retry':
        await this.put(ctx, { lastRetryAt: this.deps.now() });
        return this.setupDm(ctx);
      case 'setup':
        return this.setupDm(ctx);
      case 'poll':
        return this.readDms(ctx);
    }
  }

  private async setupDm(ctx: Ctx<DmDs>): Promise<void> {
    await this.readDms(ctx);
    await this.put(ctx, { status: 'ok', reason: null });
  }

  /** 本人の DM・グループのうち、前に読んだあとに動いたものだけを読む（上限 MAX_SPACES_PER_RUN。残りは次の見回り） */
  private async readDms(ctx: Ctx<DmDs>): Promise<void> {
    const api = await this.api(ctx);
    const now = this.deps.now();
    const self = ctx.ds.connector.account;
    const spaces = await api.spaces('spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"');
    const records: Record<string, GoogleChatDmRecord> = { ...ctx.source.googleChatDm?.spaces };
    for (const space of planDmSpaces(spaces, records, ctx.source.connectedAt, now)) {
      const record = await this.recordOf(api, space, records[space.name], self, now);
      if (record.kind === 'skip') {
        // 取り込まないもの: 今の最後に動いた時刻まで読んだことにする（読み直す時期までは planDmSpaces が選ばない）
        records[space.name] = { ...record, ...(space.lastActiveTime ? { syncedUntil: space.lastActiveTime } : {}) };
      } else {
        const chat: ChatContext = { dataSourceId: ctx.ds.id, space: space.name, threaded: true, conversation: { record, self } };
        try {
          records[space.name] = { ...record, ...(await this.readMessages(ctx, chat, record.syncedUntil ?? ctx.source.connectedAt, record.pagedOut ?? false)) };
        } catch (err) {
          // スペース 1 つが読めない（抜けた・外された）のは接続の問題にせず、そのスペースを取り込まない
          if (!(err instanceof GoogleChatError && (err.status === 403 || err.status === 404))) throw err;
          this.deps.log?.({ msg: 'google_chat_dm_unreadable', dataSourceId: ctx.ds.id, status: err.status });
          records[space.name] = { kind: 'skip', members: [], checkedAt: now };
        }
      }
      // 1 つ読むたびに位置を残す（途中で失敗しても、読んだ分を読み直さない）
      await this.update(ctx, (latest) => ({ googleChatDm: { ...latest.googleChatDm, spaces: { ...latest.googleChatDm?.spaces, [space.name]: records[space.name]! } } }));
    }
    await this.update(ctx, () => ({ lastSyncAt: now }));
  }

  /** DM・グループの種類とメンバー。覚えていて新しければそのまま、古ければ読み直す（読めなければ skip） */
  private async recordOf(api: GoogleChatApi, space: ChatSpace, record: GoogleChatDmRecord | undefined, self: string, now: string): Promise<GoogleChatDmRecord> {
    if (record && !needsCheck(record, now)) return record;
    let memberships = null;
    try {
      memberships = await api.members(space.name);
    } catch (err) {
      if (!(err instanceof GoogleChatError && (err.status === 403 || err.status === 404))) throw err;
    }
    const fresh = dmRecord(space, memberships, self, now);
    return record?.syncedUntil ? { ...fresh, syncedUntil: record.syncedUntil } : fresh;
  }

  // ---- 共通 ----

  /**
   * スペースのメッセージを from（位置）から重なりを引いた時刻より後から、古い順に MAX_PAGES_PER_SPACE ページまで読み、
   * 取り込む。前の見回りがページの上限で止まっていれば（pagedOut）、重なりなしで from の続きから読む。
   * 返すのは新しい位置（読んだ中で一番新しい createTime。取り込まなかったメッセージも含める）と、上限で止まったか
   */
  private async readMessages(ctx: Ctx<ServiceDataSource>, chat: ChatContext, from: string, pagedOut: boolean): Promise<{ syncedUntil: string; pagedOut: boolean }> {
    const api = await this.api(ctx);
    const after = pagedOut ? from : minus(from, OVERLAP_MINUTES);
    let syncedUntil = from;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_SPACE; page++) {
      const r = await api.messages(chat.space, { after, pageToken });
      for (const msg of planMessages(r.messages, ctx.source.connectedAt)) {
        const n = normalizeChatMessage(chat, msg);
        if (n.kind === 'skip') continue;
        await this.deps.service.ingestItem(n.signal);
      }
      syncedUntil = advance(syncedUntil, r.messages);
      if (!r.next) return { syncedUntil, pagedOut: false };
      pageToken = r.next;
    }
    this.deps.log?.({ msg: 'google_chat_paged_out', dataSourceId: ctx.ds.id });
    return { syncedUntil, pagedOut: true };
  }

  private async api(ctx: Ctx<ServiceDataSource>): Promise<GoogleChatApi> {
    ctx.api ??= await this.deps.chatFor(ctx.source);
    return ctx.api;
  }

  private async put(ctx: Ctx<ServiceDataSource>, patch: Partial<SourceState>) {
    await this.update(ctx, () => patch);
  }

  /** 今のデータソースの状態を読み直し、見回りが持つ項目だけを重ねて書く。外された・つなぎ直されたら止める */
  private async update(ctx: Ctx<ServiceDataSource>, patch: (latest: SourceState) => Partial<SourceState>) {
    const latest = await this.deps.state.source(ctx.ds.id);
    if (!latest || latest.status === 'disconnected' || latest.gatewayCredentialId !== ctx.credentialId) throw new SyncSuperseded();
    ctx.source = { ...latest, ...patch(latest) };
    await this.deps.state.putSource(ctx.source);
  }
}
