import type { TopicIndexService } from '../../app/service';
import { onceDirectory, type DirectoryLoader } from '../directory-once';
import { replaceSharedCredential, syncSharedReaders, type ServiceDataSource, type SpaceMember } from '../../domain';
import type { ConnectorStateStore } from '../../store/connector-state';
import { GatewayAuthError } from '../../ports/gateway';
import { GraphError, type GraphApi } from './api';
import type { SyncJob, SyncQueue } from './jobs';
import { GraphMessage } from './message';
import { normalizeMessage } from './normalize';
import type { SourceState, SubscriptionRecord } from './state';
import { expiresAfter, planLifecycle, planMaintenance, RETRY_MINUTES, type SubscriptionAction } from './subscriptions';

// キューの仕事を 1 つずつこなす（同時実行 1）。通知はヒントで、正は delta（0024 の決定 2）。
// cursor は取り込みが終わったページの分だけ進めるので、途中で落ちても同じ差分を取り直し、sourceRef の重複排除で二重にならない。

/** 1 回の仕事で読むページの上限。超えたら続きをキューに積む */
export const MAX_PAGES_PER_JOB = 20;
/** 共有メールボックスの読者を確かめ直す間隔（0042 の決定 4） */
export const MAILBOX_READERS_MINUTES = 60;

export interface GraphSyncDeps {
  service: TopicIndexService;
  state: ConnectorStateStore;
  queue: SyncQueue;
  /** データソースの本人の同意で Graph を呼ぶ口を作る（issue_token する） */
  graphFor(source: SourceState): Promise<GraphApi>;
  /**
   * 共有メールボックスの読者を確かめ直すとき（0042 の決定 4）: その人のゲートウェイの graph の接続ごとの口。
   * 同意がない・接続がなければ空。なければ共有メールボックスの読者は確かめ直さない
   */
  graphsOfUser?(userId: string): Promise<{ credentialId: string; graph: GraphApi }[]>;
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
    const ctx: SourceContext = { source, ds, mailbox: ds.connector.mailbox, folders: ds.connector.folders, subs: await this.deps.state.subscriptions(dataSourceId), graph: null };
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
    if (isShared(ctx)) return this.maintainShared(ctx);
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
    if (isShared(ctx)) {
      // 共有メールボックス（0042）: サブスクリプションは作らない。読者を確かめ、全フォルダを取り直して ok にする
      await this.syncReaders(ctx);
      await this.apply(ctx, ctx.subs.map((s) => ({ kind: 'delete', subscription: s })));
      await this.syncFolders(ctx, ctx.folders);
      await this.putSource(ctx, { status: 'ok', reason: null });
      return;
    }
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

  /**
   * 共有メールボックスの見回り（0042 の決定 1）: 通知がないので、見回りのたびに全フォルダの delta を読む。
   * broken は間をおいて試し直し、読者は間をおいて確かめ直す
   */
  private async maintainShared(ctx: SourceContext): Promise<void> {
    const now = this.deps.now();
    if (ctx.source.status === 'broken') {
      if (ctx.source.lastRetryAt && minutesBetween(ctx.source.lastRetryAt, now) < RETRY_MINUTES) return;
      await this.putSource(ctx, { lastRetryAt: now });
      return this.setup(ctx);
    }
    // setup の仕事が落ちたきり（キューの試し直しの上限）でも止まらないように、見回りが setup をやり直す。
    // キューは直列で、delta の位置と sourceRef の重複排除があるので、setup の仕事と重なっても二重にならない
    if (ctx.source.status === 'setup') return this.setup(ctx);
    const at = ctx.source.mailbox?.readersSyncedAt;
    if (!at || minutesBetween(at, now) >= MAILBOX_READERS_MINUTES) await this.syncReaders(ctx);
    await this.syncFolders(ctx, ctx.folders);
  }

  /**
   * 共有メールボックスの読者を確かめ直す（0042 の決定 4）。読者それぞれの委任で箱を読めるか試し、読めた人だけを読者に残す。
   * 取り込みに委任を使っている人が読めなくなったら、読める読者の 1 人に入れ替える。誰も読めなければ broken。
   * 一時的な失敗（ゲートウェイ・Graph の障害）は投げて、読者を減らさない
   */
  private async syncReaders(ctx: SourceContext): Promise<void> {
    const of = this.deps.graphsOfUser;
    if (!of) return;
    const dir = await this.deps.service.directory();
    const list = dir.seed.lists.find((l) => l.dataSourceId === ctx.ds.id);
    if (!list) return;
    const ownerId = ctx.source.userId;
    const candidates = [...new Set([ownerId, ...dir.readersOfList(list.id)])];
    const readable: (SpaceMember & { userId: string; credentialId: string })[] = [];
    for (const userId of candidates) {
      const tries = userId === ownerId ? [...(await this.ownGraph(ctx)), ...(await of(userId)).filter((g) => g.credentialId !== ctx.source.gatewayCredentialId)] : await of(userId);
      for (const t of tries) {
        const r = await probe(t.graph, ctx.mailbox);
        if (!r) continue;
        readable.push({ userId, credentialId: t.credentialId, address: { channel: 'email', value: r } });
        break;
      }
    }
    const { result } = await this.deps.service.changeMaster(null, '共有メールボックスの読者の確かめ直し', (d, c) => syncSharedReaders(d, c, ctx.ds.id, readable));
    if (result.added.length > 0 || result.removed.length > 0) {
      this.deps.log?.({ msg: 'mailbox_readers_synced', dataSourceId: ctx.ds.id, added: result.added.length, removed: result.removed.length });
    }
    const owner = readable.find((r) => r.userId === ownerId);
    const next = owner ?? readable[0];
    if (!next) {
      await this.putSource(ctx, { mailbox: { ...ctx.source.mailbox, readersSyncedAt: this.deps.now() } });
      throw new GatewayAuthError('共有メールボックスを読める読者がいない。読める人がつなぎ直す');
    }
    if (next.userId !== ownerId || next.credentialId !== ctx.source.gatewayCredentialId) {
      await this.deps.service.changeMaster(null, '共有メールボックスの資格情報を入れ替える', (d, c) =>
        replaceSharedCredential(d, c, ctx.ds.id, { userId: next.userId, gatewayCredentialId: next.credentialId, identity: next.address.value }),
      );
      this.deps.log?.({ msg: 'mailbox_credential_replaced', dataSourceId: ctx.ds.id });
      ctx.graph = null;
      await this.putSource(ctx, { userId: next.userId, gatewayCredentialId: next.credentialId });
    }
    await this.putSource(ctx, { mailbox: { ...ctx.source.mailbox, readersSyncedAt: this.deps.now() } });
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
        result = cursor.link ? await graph.deltaNext(cursor.link) : await graph.deltaStart(folder, cursor.lastReceivedAt ?? ctx.source.connectedAt, ctx.mailbox);
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
      const signals = [];
      for (const msg of messages) {
        const n = normalizeMessage(ctx.ds.id, msg);
        if (n.kind === 'skip') continue;
        signals.push(n.signal);
        if (msg.receivedDateTime && (!lastReceivedAt || msg.receivedDateTime > lastReceivedAt)) lastReceivedAt = msg.receivedDateTime;
      }
      // delta は既読の変化なども返すので、取り込み済みのものはまとめて落としてから取り込む（0046）
      await this.deps.service.ingestItems(signals);
      const next = result['@odata.nextLink'] ?? result['@odata.deltaLink'] ?? null;
      await this.putCursor(ctx, folder, { link: next, lastReceivedAt });
      if (!result['@odata.nextLink']) return true;
    }
    await this.deps.queue.send({ kind: 'sync', dataSourceId: ctx.ds.id, folder });
    return false;
  }

  /** 取り込みに使っている委任の口。ゲートウェイで使えなくなっていれば（同意の取り消しなど）空（読者の入れ替えに進む） */
  private async ownGraph(ctx: SourceContext): Promise<{ credentialId: string; graph: GraphApi }[]> {
    try {
      return [{ credentialId: ctx.source.gatewayCredentialId, graph: await this.graph(ctx) }];
    } catch (err) {
      if (err instanceof GatewayAuthError) return [];
      throw err;
    }
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
  /** 'me' か共有メールボックスのアドレス（0042） */
  mailbox: string;
  folders: readonly string[];
  subs: SubscriptionRecord[];
  graph: GraphApi | null;
}

function isShared(ctx: SourceContext): boolean {
  return ctx.mailbox !== 'me';
}

/** その委任で箱が読めれば、委任の本人の主のアドレスを返す。読めない・同意がない（GatewayAuthError）なら null */
async function probe(graph: GraphApi, mailbox: string): Promise<string | null> {
  try {
    if (!(await graph.mailboxReadable(mailbox))) return null;
    return (await graph.me()).addresses[0] ?? null;
  } catch (err) {
    if (err instanceof GatewayAuthError) return null;
    throw err;
  }
}

function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}
