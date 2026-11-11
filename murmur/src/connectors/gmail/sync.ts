import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import type { ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import type { ConnectorStateStore } from '../../store/connector-state';
import type { SyncJob } from '../graph/jobs';
import type { GmailCursor, SourceState } from '../graph/state';
import { GmailError, type GmailApi } from './api';
import { GmailMessage } from './message';
import { normalizeGmailMessage } from './normalize';
import { MAX_HISTORY_PAGES, MAX_RECOVERY_PAGES, planHistory, planPoll, recoveryAfter } from './plan';

// Gmail の取り込み（0041）。変更の通知はなく（Pub/Sub は使わない）、5 分ごとの見回り（maintain）で履歴（history.list）を読む。
// つないだ直後（setup）は profile.historyId を位置にするだけで、過去のメールは取らない（Outlook と同じ）。
// 位置（historyId）は、処理し終えた履歴のところまでしか進めない。途中で落ちても同じところから読み直し、
// 同じメールが 2 度来ても sourceRef の重複排除（prepareInbound）で 1 通になる。
// 購読がないので、キューの仕事は maintain と setup だけ（外す仕事 disconnect は消すものがなく何もしない）。
// 同意の問題は broken にして止め、上限（429・クォータの 403）やそのほかの失敗は次の見回りが試し直す

export interface GmailSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  /** データソースの本人の同意で Gmail を呼ぶ口を作る */
  gmailFor(source: SourceState): Promise<GmailApi>;
  now(): string;
  log?(entry: Record<string, unknown>): void;
}

interface Ctx {
  source: SourceState;
  ds: ServiceDataSource & { connector: { kind: 'gmail'; mailbox: 'me' } };
  api: GmailApi | null;
}

export class GmailSync {
  constructor(private readonly deps: GmailSyncDeps) {}

  /** directory は maintain のとき、ほかのコネクタと見回り 1 回のマスタの読み込みを共有するために渡す（なければこの 1 回だけ読む） */
  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'gmail') continue;
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), loadDirectory).catch((err: unknown) => {
            this.deps.log?.({ msg: 'gmail_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
          });
        }
        return;
      }
      case 'setup':
        return this.guard(job.dataSourceId, (ctx) => this.setup(ctx));
      default:
        return;
    }
  }

  private async guard(dataSourceId: string, run: (ctx: Ctx) => Promise<void>, directory?: DirectoryLoader): Promise<void> {
    const source = await this.deps.state.source(dataSourceId);
    if (!source || source.kind !== 'gmail' || source.status === 'disconnected') return;
    const ds = (await (directory ?? (() => this.deps.service.directory()))()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'gmail') return;
    const ctx: Ctx = { source, ds: ds as Ctx['ds'], api: null };
    try {
      await run(ctx);
    } catch (err) {
      if (!(err instanceof GatewayAuthError)) throw err;
      const latest = (await this.deps.state.source(dataSourceId)) ?? source;
      // 外したもの（仕事の途中で同意が切れた）は外したままにする。broken にすると見回りが勝手につなぎ直す
      if (latest.status === 'disconnected') {
        this.deps.log?.({ msg: 'connector_disconnect_unclean', dataSourceId, reason: err.message });
        return;
      }
      await this.deps.state.putSource({ ...latest, status: 'broken', reason: err.message, lastRetryAt: this.deps.now() });
      this.deps.log?.({ msg: 'connector_broken', dataSourceId, reason: err.message });
    }
  }

  private async maintain(ctx: Ctx): Promise<void> {
    const plan = planPoll(ctx.source, this.deps.now());
    switch (plan.kind) {
      case 'idle':
        return;
      case 'retry':
        await this.put(ctx, { lastRetryAt: this.deps.now() });
        return this.setup(ctx);
      case 'setup':
        return this.setup(ctx);
      case 'poll':
        return this.poll(ctx);
    }
  }

  /**
   * つないだ直後: 位置がなければ profile.historyId を位置にする（過去のメールは取らない）。
   * broken からの戻りで位置が残っていれば、位置は捨てずにそこから読む（切れていれば poll が拾い直す）
   */
  private async setup(ctx: Ctx): Promise<void> {
    if (!ctx.source.gmail?.historyId) {
      const startedAt = this.deps.now();
      const profile = await (await this.api(ctx)).profile();
      await this.put(ctx, { gmail: { historyId: profile.historyId, recovery: null }, lastSyncAt: startedAt, status: 'ok', reason: null });
      return;
    }
    await this.poll(ctx);
    await this.put(ctx, { status: 'ok', reason: null });
  }

  /** 履歴を読み、増えたメールを取り込んで位置を進める。位置が切れていれば拾い直す */
  private async poll(ctx: Ctx): Promise<void> {
    const startedAt = this.deps.now();
    const g = ctx.source.gmail ?? { historyId: null };
    if (g.recovery) return this.recover(ctx, startedAt);
    if (!g.historyId) return this.setup(ctx);
    const api = await this.api(ctx);

    const pages = [];
    let exhausted = false;
    let pageToken: string | null = null;
    try {
      for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
        const page = await api.history(g.historyId, pageToken);
        pages.push(page);
        if (!page.nextPageToken) {
          exhausted = true;
          break;
        }
        pageToken = page.nextPageToken;
      }
    } catch (err) {
      // startHistoryId が古すぎる: 検索で拾い直す
      if (err instanceof GmailError && err.status === 404) {
        this.deps.log?.({ msg: 'gmail_history_expired', dataSourceId: ctx.ds.id });
        return this.recover(ctx, startedAt);
      }
      throw err;
    }

    const plan = planHistory({ cursor: g.historyId, pages, exhausted });
    await this.ingest(ctx, plan.fetch);
    await this.putGmail(ctx, { historyId: plan.nextCursor ?? g.historyId });
    if (plan.complete) await this.put(ctx, { lastSyncAt: startedAt });
    else this.deps.log?.({ msg: 'gmail_sync_paged_out', dataSourceId: ctx.ds.id });
  }

  /**
   * 位置が切れたときの拾い直し。最初に profile.historyId（新しい位置）を読んで残し、最後に読めた時刻より重なりの分だけ手前から
   * messages.list で検索して取り込む。1 回に読むのは MAX_RECOVERY_PAGES ページまで。続きがあれば検索の位置（pageToken）を残し、
   * 次の見回りが続ける。読み切ってから新しい位置に移る（拾い直しの間に着いたメールは、新しい位置からの履歴が拾う）
   */
  private async recover(ctx: Ctx, startedAt: string): Promise<void> {
    const api = await this.api(ctx);
    let rec = ctx.source.gmail?.recovery;
    if (!rec) {
      const profile = await api.profile();
      rec = { nextHistoryId: profile.historyId, after: recoveryAfter(ctx.source.lastSyncAt, ctx.source.connectedAt), pageToken: null };
      // 途中で失敗しても、同じ起点・同じ新しい位置で続ける
      await this.putGmail(ctx, { recovery: rec });
    }
    const ids: string[] = [];
    let pageToken = rec.pageToken;
    let done = false;
    for (let i = 0; i < MAX_RECOVERY_PAGES; i++) {
      const r = await api.list(rec.after, pageToken);
      ids.push(...r.ids);
      if (!r.nextPageToken) {
        done = true;
        pageToken = null;
        break;
      }
      pageToken = r.nextPageToken;
    }
    await this.ingest(ctx, ids, 'byDate');
    if (!done) {
      await this.putGmail(ctx, { recovery: { ...rec, pageToken } });
      this.deps.log?.({ msg: 'gmail_recovery_paged_out', dataSourceId: ctx.ds.id });
      return;
    }
    await this.putGmail(ctx, { historyId: rec.nextHistoryId, recovery: null });
    await this.put(ctx, { lastSyncAt: startedAt });
    this.deps.log?.({ msg: 'gmail_recovered', dataSourceId: ctx.ds.id });
  }

  /**
   * メッセージを取って取り込む。消えていたもの（404）・読めない形・取り込まないラベルのものは飛ばす。
   * 履歴の順（時系列）のまま取り込む。byDate は検索の結果（新しい順）を internalDate の昇順にそろえる
   */
  private async ingest(ctx: Ctx, ids: readonly string[], order: 'asGiven' | 'byDate' = 'asGiven'): Promise<void> {
    const api = await this.api(ctx);
    const pending: GmailMessage[] = [];
    const take = async (msg: GmailMessage) => {
      const n = normalizeGmailMessage(ctx.ds.id, msg);
      if (n.kind === 'signal') await this.deps.service.ingestItem(n.signal);
    };
    for (const id of new Set(ids)) {
      const raw = await api.message(id);
      if (!raw) continue;
      const parsed = GmailMessage.safeParse(raw);
      if (!parsed.success) {
        this.deps.log?.({ msg: 'gmail_message_unreadable', dataSourceId: ctx.ds.id, id });
        continue;
      }
      if (order === 'asGiven') await take(parsed.data);
      else pending.push(parsed.data);
    }
    pending.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    for (const msg of pending) await take(msg);
  }

  private async api(ctx: Ctx): Promise<GmailApi> {
    ctx.api ??= await this.deps.gmailFor(ctx.source);
    return ctx.api;
  }

  private async putGmail(ctx: Ctx, patch: Partial<GmailCursor>) {
    await this.put(ctx, { gmail: { historyId: null, ...ctx.source.gmail, ...patch } });
  }

  private async put(ctx: Ctx, patch: Partial<SourceState>) {
    ctx.source = { ...ctx.source, ...patch };
    await this.deps.state.putSource(ctx.source);
  }
}
