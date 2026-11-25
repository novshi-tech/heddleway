import type { TopicIndexService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import { lineReaderIdentity, replaceSharedCredential, syncSharedReaders, type ServiceDataSource, type SpaceMember } from '../../domain';
import { GatewayAuthError } from '../../ports/gateway';
import type { ConnectorStateStore } from '../../store/connector-state';
import type { SyncJob } from '../graph/jobs';
import type { SourceState } from '../graph/state';
import { minutesSince, planPoll } from '../google-chat/plan';
import { LINE_PAGE_SIZE, type LineApi } from './api';
import { normalizeLineEvent, type LineContext } from './normalize';

// LINE 公式アカウントの取り込み（0049）。原本は受け口（業務システム）が持ち、本体は 5 分ごとの見回り（maintain）で
// 受け口の差分読み（lineEvents）を前回の endCursor から読む（0041 の決定 1）。購読はないので、キューの仕事は maintain と setup だけ。
// 読者は「自分の接続で受け口のメッセージを読めた人」で、60 分ごとに確かめ直す（0042 の決定 4 と同じ）。
// 書き込みは、そのつど今のデータソースの状態を読み直して、見回りが持つ項目だけを重ねる（0045 と同じ）

/** 1 回の見回りで読むページ（LINE_PAGE_SIZE 件）の上限。超えたら位置まで進めて、次の見回りで続ける */
export const MAX_PAGES_PER_RUN = 5;
/** 読者を確かめ直す間隔 */
export const LINE_READERS_MINUTES = 60;

export interface LineSyncDeps {
  service: TopicIndexService;
  state: ConnectorStateStore;
  /** データソースの資格情報（取り込みに使っている読者の接続）で受け口を読む口 */
  lineFor(source: SourceState): Promise<LineApi>;
  /** 読者を確かめ直すとき: その人のゲートウェイの受け口の接続ごとの口。同意がない・接続がなければ空 */
  linesOfUser?(userId: string): Promise<{ credentialId: string; api: LineApi }[]>;
  now(): string;
  log?(entry: Record<string, unknown>): void;
}

/** 読んでいる間に、外された・別の接続につなぎ直された。何も書かずに止める */
class SyncSuperseded extends Error {}

type LineDs = ServiceDataSource & { connector: { kind: 'line'; organizationId: string } };

interface Ctx {
  source: SourceState;
  credentialId: string;
  ds: LineDs;
  api: LineApi | null;
}

export class LineSync {
  constructor(private readonly deps: LineSyncDeps) {}

  async handle(job: SyncJob, directory?: DirectoryLoader): Promise<void> {
    switch (job.kind) {
      case 'maintain': {
        const loadDirectory = directory ?? onceDirectory(() => this.deps.service.directory());
        for (const s of await this.deps.state.sources()) {
          if (s.kind !== 'line') continue;
          await this.run(s.dataSourceId, 'maintain', loadDirectory).catch((err: unknown) => {
            this.deps.log?.({ msg: 'line_maintain_failed', dataSourceId: s.dataSourceId, error: String(err) });
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
    if (!source || source.status === 'disconnected' || source.kind !== 'line') return;
    const ds = (await (directory ?? (() => this.deps.service.directory()))()).dataSource(dataSourceId);
    if (!ds || ds.kind !== 'service' || ds.connector?.kind !== 'line') return;
    const ctx: Ctx = { source, credentialId: source.gatewayCredentialId, ds: ds as LineDs, api: null };
    try {
      await (what === 'setup' ? this.setup(ctx) : this.maintain(ctx));
    } catch (err) {
      if (err instanceof SyncSuperseded) {
        this.deps.log?.({ msg: 'line_sync_superseded', dataSourceId });
        return;
      }
      if (!(err instanceof GatewayAuthError)) throw err;
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

  private async maintain(ctx: Ctx): Promise<void> {
    const plan = planPoll(ctx.source, ctx.source.line?.setupAt, this.deps.now());
    switch (plan.kind) {
      case 'idle':
        return;
      case 'retry':
        await this.update(ctx, () => ({ lastRetryAt: this.deps.now() }));
        return this.setup(ctx);
      case 'setup':
        return this.setup(ctx);
      case 'poll':
        if (minutesSince(ctx.source.line?.readersSyncedAt, this.deps.now()) >= LINE_READERS_MINUTES) await this.syncReaders(ctx);
        return this.read(ctx);
    }
  }

  /** つないだ直後・broken からの戻り: 読者を確かめ、読んで ok にする */
  private async setup(ctx: Ctx): Promise<void> {
    await this.syncReaders(ctx);
    await this.read(ctx);
    await this.update(ctx, () => ({ status: 'ok', reason: null }));
  }

  /**
   * 読者を確かめ直す（0049 の決定 4）。読者それぞれの接続で、受け口のメッセージが読めて組織が同じかを試し、読めた人だけを残す。
   * 取り込みに使っている接続が読めなくなったら、読める読者の 1 人に入れ替える。誰も読めなければ broken。
   * 一時的な失敗（ゲートウェイ・受け口の障害）は投げて、読者を減らさない
   */
  private async syncReaders(ctx: Ctx): Promise<void> {
    const { organizationId } = ctx.ds.connector;
    const dir = await this.deps.service.directory();
    const list = dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id);
    if (!list) return;
    const ownerId = ctx.source.userId;
    const candidates = [...new Set([ownerId, ...dir.readersOfList(list.id)])];
    const readable: (SpaceMember & { userId: string; credentialId: string })[] = [];
    for (const userId of candidates) {
      const others = this.deps.linesOfUser ? await this.deps.linesOfUser(userId) : [];
      const tries = userId === ownerId ? [...(await this.ownApi(ctx)), ...others.filter((t) => t.credentialId !== ctx.source.gatewayCredentialId)] : others;
      for (const t of tries) {
        if (!(await readableIn(t.api, organizationId))) continue;
        readable.push({ userId, credentialId: t.credentialId, address: lineReaderIdentity(organizationId, userId) });
        break;
      }
    }
    const { result } = await this.deps.service.changeMaster(null, 'LINE 公式アカウントの読者の確かめ直し', (d, c) => syncSharedReaders(d, c, ctx.ds.id, readable));
    if (result.added.length > 0 || result.removed.length > 0) {
      this.deps.log?.({ msg: 'line_readers_synced', dataSourceId: ctx.ds.id, added: result.added.length, removed: result.removed.length });
    }
    const next = readable.find((r) => r.userId === ownerId) ?? readable[0];
    if (!next) {
      await this.update(ctx, (latest) => ({ line: { after: null, ...latest.line, readersSyncedAt: this.deps.now() } }));
      throw new GatewayAuthError('受け口の LINE のメッセージを読める読者がいない。読める人がつなぎ直す');
    }
    if (next.userId !== ownerId || next.credentialId !== ctx.source.gatewayCredentialId) {
      await this.deps.service.changeMaster(null, 'LINE 公式アカウントの資格情報を入れ替える', (d, c) =>
        replaceSharedCredential(d, c, ctx.ds.id, { userId: next.userId, gatewayCredentialId: next.credentialId, identity: next.address.value }),
      );
      this.deps.log?.({ msg: 'line_credential_replaced', dataSourceId: ctx.ds.id });
      // 入れ替えは見回り自身が書く（update の「つなぎ直された」の判定を、入れ替えたあとの接続で続ける）
      const latest = await this.deps.state.source(ctx.ds.id);
      if (!latest || latest.status === 'disconnected' || latest.gatewayCredentialId !== ctx.credentialId) throw new SyncSuperseded();
      ctx.source = { ...latest, userId: next.userId, gatewayCredentialId: next.credentialId };
      await this.deps.state.putSource(ctx.source);
      ctx.credentialId = next.credentialId;
      ctx.api = null;
    }
    await this.update(ctx, (latest) => ({ line: { after: null, ...latest.line, readersSyncedAt: this.deps.now() } }));
  }

  /** 前回の位置（なければつないだ時刻）から保存の順に読み、取り込む。ページの上限で止めたら、読んだところまで位置を進める */
  private async read(ctx: Ctx): Promise<void> {
    const startedAt = this.deps.now();
    const api = await this.api(ctx);
    const line: LineContext = { dataSourceId: ctx.ds.id, organizationId: ctx.ds.connector.organizationId };
    let after = ctx.source.line?.after ?? null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const r = await api.events({ after, since: ctx.source.connectedAt, first: LINE_PAGE_SIZE });
      const signals = [];
      for (const e of r.events) {
        const n = normalizeLineEvent(line, e);
        if (n.kind === 'signal') signals.push(n.signal);
      }
      await this.deps.service.ingestItems(signals);
      after = r.endCursor ?? after;
      // 1 ページ読むたびに位置を残す（途中で失敗しても、読んだ分を読み直さない。読み直しても sourceRef の重複排除で落ちる）
      const cursor = after;
      await this.update(ctx, (latest) => ({ line: { ...latest.line, after: cursor } }));
      if (!r.hasMore) {
        await this.update(ctx, () => ({ lastSyncAt: startedAt }));
        return;
      }
    }
    this.deps.log?.({ msg: 'line_paged_out', dataSourceId: ctx.ds.id });
  }

  /** 取り込みに使っている接続の口。ゲートウェイで使えなくなっていれば（同意の取り消しなど）空（読者の入れ替えに進む） */
  private async ownApi(ctx: Ctx): Promise<{ credentialId: string; api: LineApi }[]> {
    try {
      return [{ credentialId: ctx.source.gatewayCredentialId, api: await this.api(ctx) }];
    } catch (err) {
      if (err instanceof GatewayAuthError) return [];
      throw err;
    }
  }

  private async api(ctx: Ctx): Promise<LineApi> {
    ctx.api ??= await this.deps.lineFor(ctx.source);
    return ctx.api;
  }

  /** 今のデータソースの状態を読み直し、見回りが持つ項目だけを重ねて書く。外された・つなぎ直されたら止める */
  private async update(ctx: Ctx, patch: (latest: SourceState) => Partial<SourceState>) {
    const latest = await this.deps.state.source(ctx.ds.id);
    if (!latest || latest.status === 'disconnected' || latest.gatewayCredentialId !== ctx.credentialId) throw new SyncSuperseded();
    ctx.source = { ...latest, ...patch(latest) };
    await this.deps.state.putSource(ctx.source);
  }
}

/** その接続で、組織 organizationId の LINE のメッセージが読めるか。読めない・同意がない（GatewayAuthError）なら false */
export async function readableIn(api: LineApi, organizationId: string): Promise<boolean> {
  try {
    return (await api.probe()).id === organizationId;
  } catch (err) {
    if (err instanceof GatewayAuthError) return false;
    throw err;
  }
}

