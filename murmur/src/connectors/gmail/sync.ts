import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import type { ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import { GoogleApiNotEnabled } from '../google-error';
import type { ConnectorStateStore } from '../../store/connector-state';
import type { SyncJob } from '../graph/jobs';
import type { GmailCursor, SourceState } from '../graph/state';
import { GmailError, type GmailApi } from './api';
import { classifyMessageFailure } from './failure';
import { GmailMessage } from './message';
import { normalizeGmailMessage } from './normalize';
import { appendRecoveryIds, MAX_FETCH_PER_RUN, MAX_HISTORY_PAGES, MAX_RECOVERY_IDS, MAX_RECOVERY_PAGES, nextFailure, planHistory, planPoll, planRecoveryChunk, recoveryAfter, SAVE_EVERY } from './plan';

// Gmail の取り込み（0041）。変更の通知はなく（Pub/Sub は使わない）、5 分ごとの見回り（maintain）で履歴（history.list）を読む。
// つないだ直後（setup）は profile.historyId を位置にするだけで、過去のメールは取らない（Outlook と同じ）。
// 位置（historyId）は、処理し終えた履歴のところまでしか進めない。途中で落ちても同じところから読み直し、
// 同じメールが 2 度来ても sourceRef の重複排除（prepareInbound）で 1 通になる。
// 購読がないので、キューの仕事は maintain と setup だけ（外す仕事 disconnect は消すものがなく何もしない）。
// 同意の問題と、Gmail API がゲートウェイのプロジェクトで有効でないことは broken にして止め、上限（429・クォータの 403）やそのほかの失敗は次の見回りが試し直す。
// 1 通で見回りを止めない: そのメッセージ固有でやり直しても直らない失敗（Gmail の 400・404・410 など、本体が断った取り込み）は ID だけ記録して飛ばす。
// 上限・5xx・ネットワーク・ゲートウェイや AI 判断の不調は、どれだけ続いても数えず見回りを止めて試し直す（障害のあいだにメールを失わない）。
// 種類の分からない失敗だけ、見回り 1 回につき 1 回と数え、同じ ID が 3 回続いたら飛ばす（回数と時刻は源の状態の blocked。分類は failure.ts）。
// 書き込みは、そのつど今のデータソースの状態を読み直して、見回りが持つ項目だけを重ねる。読んでいる間に外された・別の接続に
// つなぎ直された場合は、何も書かずに止める（外したのを元に戻さない）

export interface GmailSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  /** データソースの本人の同意で Gmail を呼ぶ口を作る */
  gmailFor(source: SourceState): Promise<GmailApi>;
  now(): string;
  log?(entry: Record<string, unknown>): void;
}

/** 読んでいる間に、本人が外した・別の接続につなぎ直した。何も書かずに止める */
class SyncSuperseded extends Error {}

interface Ctx {
  source: SourceState;
  /** 見回りを始めたときの接続（ゲートウェイの資格情報）。書くときに今のと違えば止める */
  credentialId: string;
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
    const ctx: Ctx = { source, credentialId: source.gatewayCredentialId, ds: ds as Ctx['ds'], api: null };
    try {
      await run(ctx);
    } catch (err) {
      if (err instanceof SyncSuperseded) {
        this.deps.log?.({ msg: 'gmail_sync_superseded', dataSourceId });
        return;
      }
      if (!(err instanceof GatewayAuthError || err instanceof GoogleApiNotEnabled)) throw err;
      const latest = (await this.deps.state.source(dataSourceId)) ?? source;
      // 別の接続につなぎ直されたものは、古い接続の失敗で止めない
      if (latest.gatewayCredentialId !== ctx.credentialId) return;
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
    // 履歴のレコードの順に取り込み、SAVE_EVERY 通ごとに、そこまでのレコードの id へ位置を進める（落ちても全部は取り直さない）。
    // 位置は、処理し終えたレコードまでしか進めない
    let sinceSave = 0;
    for (const record of plan.records) {
      for (const id of record.ids) await this.processMessage(ctx, id);
      sinceSave += record.ids.length;
      if (sinceSave >= SAVE_EVERY) {
        await this.putGmail(ctx, { historyId: record.id });
        sinceSave = 0;
      }
    }
    await this.putGmail(ctx, { historyId: plan.nextCursor ?? g.historyId });
    if (plan.complete) await this.put(ctx, { lastSyncAt: startedAt });
    else this.deps.log?.({ msg: 'gmail_sync_paged_out', dataSourceId: ctx.ds.id });
  }

  /**
   * 位置が切れたときの拾い直し。2 段で進める。
   * (1) 最初に profile.historyId（新しい位置）を読んで残し、最後に読めた時刻より重なりの分だけ手前から messages.list で検索して、
   * ID を全部集める（新しい順。1 回に読むのは MAX_RECOVERY_PAGES ページまで、続きは pageToken から。総数は MAX_RECOVERY_IDS まで。
   * 超えたら新しい方だけにして、記録に残す）。残した pageToken が使えなくなったら（4xx）、集めた ID を捨てて最初から読み直す。
   * (2) 集め終えたら、古い方から（スレッドの順は取り込んだ順なので、新しい順に取り込まない）1 回に MAX_FETCH_PER_RUN 通ずつ取り込み、
   * 取り込んだ ID を残りから外す。残りが空になってから新しい位置に移る（拾い直しの間に着いたメールは、新しい位置からの履歴が拾う）
   */
  private async recover(ctx: Ctx, startedAt: string): Promise<void> {
    const api = await this.api(ctx);
    let rec = ctx.source.gmail?.recovery;
    if (!rec) {
      const began = this.deps.now();
      const profile = await api.profile();
      rec = { nextHistoryId: profile.historyId, after: recoveryAfter(ctx.source.lastSyncAt, ctx.source.connectedAt), pageToken: null, ids: [], listed: false, startedAt: began };
      // 途中で失敗しても、同じ起点・同じ新しい位置で続ける
      await this.putGmail(ctx, { recovery: rec });
    }
    let ids = rec.ids ?? [];
    if (!rec.listed) {
      let pageToken = rec.pageToken;
      let listed = false;
      let restarted = false;
      let budget = MAX_RECOVERY_PAGES;
      while (budget > 0) {
        budget--;
        let page;
        try {
          page = await api.list(rec.after, pageToken);
        } catch (err) {
          // 残した位置が使えなくなった（古くなった）: 集めた ID を捨てて最初から読み直す。起点と新しい位置は変えない
          if (pageToken !== null && !restarted && err instanceof GmailError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
            this.deps.log?.({ msg: 'gmail_recovery_restarted', dataSourceId: ctx.ds.id, status: err.status });
            restarted = true;
            pageToken = null;
            ids = [];
            budget = MAX_RECOVERY_PAGES;
            continue;
          }
          throw err;
        }
        const added = appendRecoveryIds(ids, page.ids);
        ids = added.ids;
        if (added.truncated) {
          this.deps.log?.({ msg: 'gmail_recovery_truncated', dataSourceId: ctx.ds.id, kept: MAX_RECOVERY_IDS });
          pageToken = null;
          listed = true;
          break;
        }
        if (!page.nextPageToken) {
          pageToken = null;
          listed = true;
          break;
        }
        pageToken = page.nextPageToken;
      }
      rec = { ...rec, pageToken, ids, listed };
      await this.putGmail(ctx, { recovery: rec });
      if (!listed) {
        this.deps.log?.({ msg: 'gmail_recovery_paged_out', dataSourceId: ctx.ds.id });
        return;
      }
    }

    const { chunk, remaining } = planRecoveryChunk(ids, MAX_FETCH_PER_RUN);
    // 取り込んだ ID は、配列の末尾から外していく。失敗したら、そこまでの分を残して止める
    const left = [...ids];
    let sinceSave = 0;
    try {
      for (const id of chunk) {
        await this.processMessage(ctx, id);
        left.pop();
        if (++sinceSave >= SAVE_EVERY) {
          await this.putGmail(ctx, { recovery: { ...rec, ids: left } });
          sinceSave = 0;
        }
      }
    } catch (err) {
      if (!(err instanceof SyncSuperseded)) await this.putGmail(ctx, { recovery: { ...rec, ids: left } }).catch(() => undefined);
      throw err;
    }
    if (remaining.length > 0) {
      await this.putGmail(ctx, { recovery: { ...rec, ids: remaining } });
      this.deps.log?.({ msg: 'gmail_recovery_paged_out', dataSourceId: ctx.ds.id });
      return;
    }
    await this.putGmail(ctx, { historyId: rec.nextHistoryId, recovery: null });
    // 保証できるのは、拾い直しを始めたとき（profile.historyId を読んだとき）までのメール。終えた時刻にしない
    await this.put(ctx, { lastSyncAt: rec.startedAt ?? startedAt });
    this.deps.log?.({ msg: 'gmail_recovered', dataSourceId: ctx.ds.id });
  }

  /**
   * メッセージ 1 通を取って取り込む。消えていたもの（404）・読めない形・取り込まないものは飛ばす。
   * 失敗したときは、やり直しても直らないもの（4xx、本体が断った）か、同じ ID が MAX_MESSAGE_FAILURES 回続けて失敗したものを、
   * ID だけ記録して飛ばす。それ以外（上限・5xx など）は失敗の回数を残して見回りを止め、次の見回りが試し直す。
   * 同意の問題（broken にする）と、外された・つなぎ直された（SyncSuperseded）は、メッセージの失敗として数えない
   */
  private async processMessage(ctx: Ctx, id: string): Promise<void> {
    try {
      const raw = await (await this.api(ctx)).message(id);
      const parsed = raw ? GmailMessage.safeParse(raw) : null;
      if (parsed && !parsed.success) this.deps.log?.({ msg: 'gmail_message_unreadable', dataSourceId: ctx.ds.id, id });
      if (parsed?.success) {
        const n = normalizeGmailMessage(ctx.ds.id, parsed.data);
        if (n.kind === 'signal') await this.deps.service.ingestItem(n.signal);
      }
    } catch (err) {
      if (err instanceof SyncSuperseded || err instanceof GatewayAuthError || err instanceof GoogleApiNotEnabled) throw err;
      const kind = classifyMessageFailure(err);
      // 一時的・基盤の失敗は数えない。見回りを止めて、次の見回りでいつまでも試し直す
      if (kind === 'transient') throw err;
      const blocked = ctx.source.gmail?.blocked ?? null;
      const failure = nextFailure(blocked, id, this.deps.now());
      if (kind === 'count' && !failure.skip) {
        if (failure.counted) await this.putGmail(ctx, { blocked: { id, count: failure.count, at: this.deps.now() } });
        throw err;
      }
      this.deps.log?.({ msg: 'gmail_message_skipped', dataSourceId: ctx.ds.id, id, permanent: kind === 'skip', count: failure.count });
      if (blocked?.id === id) await this.putGmail(ctx, { blocked: null });
      return;
    }
    if (ctx.source.gmail?.blocked?.id === id) await this.putGmail(ctx, { blocked: null });
  }

  private async api(ctx: Ctx): Promise<GmailApi> {
    ctx.api ??= await this.deps.gmailFor(ctx.source);
    return ctx.api;
  }

  private async putGmail(ctx: Ctx, patch: Partial<GmailCursor>) {
    await this.update(ctx, (latest) => ({ gmail: { historyId: null, ...latest.gmail, ...patch } }));
  }

  private async put(ctx: Ctx, patch: Partial<SourceState>) {
    await this.update(ctx, () => patch);
  }

  /**
   * 今のデータソースの状態を読み直し、見回りが持つ項目（patch）だけを重ねて書く。外されていたら（disconnected）、
   * 別の接続につなぎ直されていたら、何も書かずに止める（SyncSuperseded）
   */
  private async update(ctx: Ctx, patch: (latest: SourceState) => Partial<SourceState>) {
    const latest = await this.deps.state.source(ctx.ds.id);
    if (!latest || latest.status === 'disconnected' || latest.gatewayCredentialId !== ctx.credentialId) throw new SyncSuperseded();
    ctx.source = { ...latest, ...patch(latest) };
    await this.deps.state.putSource(ctx.source);
  }
}
