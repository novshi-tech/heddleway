import type { MurmurService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import { renameTaskList, type ServiceDataSource } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import { GoogleApiNotEnabled } from '../google-error';
import type { ConnectorStateStore } from '../../store/connector-state';
import type { SyncJob } from '../graph/jobs';
import type { GtasksCursor, SourceState } from '../graph/state';
import { GtasksError, type GtasksApi } from './api';
import { normalizeGtask } from './normalize';
import { advanceCursor, finalCursor, isListCheckDue, MAX_PAGES_PER_RUN, planPoll, planRead } from './plan';
import { GtasksTask, listDisplayName } from './task';

// Google Tasks の取り込み（0041）。変更の通知はなく、5 分ごとの見回り（maintain）でリストごとに updatedMin の差分を読む。
// つないだ直後（setup）はリストを全部読む。写しは冪等（同じ値なら何もしない）なので、同じタスクが 2 度来ても二重にならない。
// 購読がないので、キューの仕事は maintain と setup だけ（外す仕事 disconnect は消すものがなく何もしない）。
// 同意の問題と、Google の API がゲートウェイのプロジェクトで有効でないことは broken にして止め、そのほかの失敗（上限を含む）は次の見回りが試し直す。
// 書き込みは、そのつど今のデータソースの状態を読み直して、見回りが持つ項目だけを重ねる。読んでいる間に外された・別の接続に
// つなぎ直された場合は、何も書かずに止める（外したのを元に戻さない）

export interface GtasksSyncDeps {
  service: MurmurService;
  state: ConnectorStateStore;
  /** データソースの本人の同意で Google Tasks を呼ぶ口を作る */
  gtasksFor(source: SourceState): Promise<GtasksApi>;
  now(): string;
  /** 見回りの間隔（分。MurmurConfig.tasksPollMinutes）。なければ見回りのたび */
  pollMinutes?: number;
  log?(entry: Record<string, unknown>): void;
}

/** 読んでいる間に、本人が外した・別の接続につなぎ直した。何も書かずに止める */
class SyncSuperseded extends Error {}

interface Ctx {
  source: SourceState;
  /** 見回りを始めたときの接続（ゲートウェイの資格情報）。書くときに今のと違えば止める */
  credentialId: string;
  ds: ServiceDataSource & { connector: { kind: 'google-tasks'; listId: string; listName: string } };
  /** 本人のアカウント（チャネル todo のアドレス） */
  account: string;
  api: GtasksApi | null;
}

export class GtasksSync {
  constructor(private readonly deps: GtasksSyncDeps) {}

  /** directory は maintain のとき、ほかのコネクタと見回り 1 回のマスタの読み込みを共有するために渡す（なければこの 1 回だけ読む） */
  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'gtasks') continue;
          await this.guard(s.dataSourceId, (ctx) => this.maintain(ctx), loadDirectory).catch((err: unknown) => {
            this.deps.log?.({ msg: 'gtasks_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
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
    if (!source || source.kind !== 'gtasks' || source.status === 'disconnected') return;
    const dir = await (directory ?? (() => this.deps.service.directory()))();
    const ds = dir.dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'google-tasks') return;
    const account = dir.credentialRef(ds.credentialRefId)?.address.value ?? '';
    const ctx: Ctx = { source, credentialId: source.gatewayCredentialId, ds: ds as Ctx['ds'], account, api: null };
    try {
      await run(ctx);
    } catch (err) {
      if (err instanceof SyncSuperseded) {
        this.deps.log?.({ msg: 'gtasks_sync_superseded', dataSourceId });
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
    const plan = planPoll(ctx.source, this.deps.now(), this.deps.pollMinutes);
    switch (plan.kind) {
      case 'idle':
        return;
      case 'retry':
        await this.put(ctx, { lastRetryAt: this.deps.now() });
        return this.setup(ctx);
      case 'setup':
        return this.setup(ctx);
      case 'poll': {
        // 名前の変更は通知がないので、ときどき確かめる。変わっていれば写しの statusLabel を直すために全部読み直す
        if (isListCheckDue(this.deps.now(), ctx.source.gtasks?.listCheckedAt) && (await this.refreshList(ctx))) {
          await this.read(ctx, 'full');
          return;
        }
        await this.read(ctx, 'delta');
      }
    }
  }

  /** つないだ直後・broken からの戻り: リストの名前を確かめ、リストを全部読んで ok にする */
  private async setup(ctx: Ctx): Promise<void> {
    await this.refreshList(ctx);
    await this.read(ctx, 'full');
    await this.put(ctx, { status: 'ok', reason: null });
  }

  /**
   * Google Tasks の側でリストの名前が変わっていれば、データソースの名前を直す。変わったら true。
   * リストがなくなっていれば止める（broken。本人に伝わる）
   */
  private async refreshList(ctx: Ctx): Promise<boolean> {
    const listId = ctx.ds.connector.listId;
    const list = await (await this.api(ctx)).list(listId);
    if (!list) throw this.listGone(ctx);
    await this.putGtasks(ctx, { listCheckedAt: this.deps.now() });
    const title = listDisplayName(list.title);
    if (title === ctx.ds.connector.listName) return false;
    const { result } = await this.deps.service.changeMaster(null, 'Google Tasks のリストの名前が変わった', (d) => renameTaskList(d, ctx.ds.id, title));
    if (!result) return false;
    this.deps.log?.({ msg: 'gtasks_list_renamed', dataSourceId: ctx.ds.id });
    ctx.ds = { ...ctx.ds, connector: { ...ctx.ds.connector, listName: title } };
    return true;
  }

  private listGone(ctx: Ctx): GatewayAuthError {
    return new GatewayAuthError(`Google Tasks のリスト ${ctx.ds.connector.listName} が見つからない（消したか、見えなくなった）`);
  }

  /**
   * タスクを読んで写す。full はリスト全部（updatedMin なし）、delta は cursor 以後に変わったもの。
   * 1 回に読むのは MAX_PAGES_PER_RUN ページまで。上限で止めたら読みかけの位置（resume）を、その問い合わせ（mode と updatedMin）と
   * 読み始めた時刻つきで残し、次の見回りが同じ問い合わせで続ける（planRead）。
   * 読み切ったら cursor を見えた中で一番新しい updated まで進める。ただし読み始めた時刻から余裕を引いた時刻より後にはしない（finalCursor）。
   * 見回りの間隔の基準（lastSyncAt）は、読み始めた時刻（終わった時刻だと、間隔が読む時間の分だけずれていく）
   */
  private async read(ctx: Ctx, requested: 'full' | 'delta'): Promise<void> {
    const api = await this.api(ctx);
    const listId = ctx.ds.connector.listId;
    const taskCtx = { dataSourceId: ctx.ds.id, account: ctx.account, listName: ctx.ds.connector.listName, connectedAt: ctx.source.connectedAt };
    const g = ctx.source.gtasks ?? { updatedMin: null };
    const plan = planRead({ requested, cursor: g.updatedMin, resume: g.resume });
    const startedAt = plan.startedAt ?? this.deps.now();
    let pageToken: string | null = plan.pageToken;
    let seen: string[] = plan.maxUpdated ? [plan.maxUpdated] : [];

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      let result;
      try {
        result = await api.tasks(listId, { updatedMin: plan.updatedMin, pageToken });
      } catch (err) {
        if (err instanceof GtasksError && err.status === 404) throw this.listGone(ctx);
        // 読みかけの pageToken が無効になった: 同じ問い合わせを最初から読み直す（写しは冪等。読み始めた時刻は元のまま）
        if (err instanceof GtasksError && err.status === 400 && pageToken) {
          this.deps.log?.({ msg: 'gtasks_page_token_reset', dataSourceId: ctx.ds.id });
          pageToken = null;
          seen = [];
          continue;
        }
        throw err;
      }
      const tasks = (result.items ?? [])
        .map((raw) => GtasksTask.safeParse(raw))
        .flatMap((r) => (r.success ? [r.data] : []))
        .sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));
      for (const task of tasks) {
        seen.push(task.updated);
        const n = normalizeGtask(taskCtx, task);
        if (n.kind === 'mirror') await this.deps.service.ingestItem(n.mirror);
      }
      const maxUpdated = advanceMax(seen);
      seen = maxUpdated ? [maxUpdated] : [];
      if (!result.nextPageToken) {
        await this.update(ctx, (latest) => ({
          gtasks: { ...latest.gtasks, updatedMin: finalCursor(latest.gtasks?.updatedMin ?? null, seen, startedAt), resume: null },
          lastSyncAt: startedAt,
        }));
        return;
      }
      pageToken = result.nextPageToken;
      const resume = { pageToken, mode: plan.mode, updatedMin: plan.updatedMin, startedAt, maxUpdated };
      await this.putGtasks(ctx, { resume });
    }
    this.deps.log?.({ msg: 'gtasks_sync_paged_out', dataSourceId: ctx.ds.id });
  }

  private async api(ctx: Ctx): Promise<GtasksApi> {
    ctx.api ??= await this.deps.gtasksFor(ctx.source);
    return ctx.api;
  }

  private async putGtasks(ctx: Ctx, patch: Partial<GtasksCursor>) {
    await this.update(ctx, (latest) => ({ gtasks: { updatedMin: null, ...latest.gtasks, ...patch } }));
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

/** 見えた updated の中で一番新しいもの（なければ null） */
function advanceMax(seen: readonly string[]): string | null {
  return advanceCursor(null, seen);
}
