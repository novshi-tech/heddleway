import {
  addAddress,
  addListMember,
  addNote,
  bindIdentity,
  contactView,
  createContact,
  createPersonalDataSource,
  endAddress,
  ensureUser,
  mergeContacts,
  renameContact,
  renameUser,
  requireMember,
  searchContacts,
  unbindContact,
  unresolvedAddresses,
  acknowledgeAttention,
  isStaleProjections,
  claimThread,
  deriveViewer,
  planOverdue,
  recordSent,
  type RecordSentInput,
  Directory,
  DomainError,
  dismissThread,
  emptyProjections,
  finalizeIngest,
  isMirror,
  planMirror,
  fold,
  foldChanges,
  getListView,
  getThreadView,
  linkThreads,
  listLists,
  listThreads,
  moveSignal,
  planIngest,
  planMasterEdit,
  prepareInbound,
  reopenThread,
  signalEvent,
  unlinkThreads,
  type CoreContext,
  type DraftEvent,
  type Author,
  type MirrorFields,
  type InboundItem,
  type InboundMirror,
  type InboundSignal,
  type IngestOutcome,
  type IngestPolicy,
  type AddressRef,
  type MasterChange,
  type PersonalDataSourceInput,
  type MoveTarget,
  type Projections,
  type Seed,
  type ThreadFilter,
  type Viewer,
} from '../domain';
import type { Connectors } from '../connectors/types';
import type { Decider } from '../ingest/deciders';
import { ConcurrencyError, type Repo } from '../store/types';

// 命令型シェル。IO（DB・Claude・コネクタ・時計・ID 生成）をここに集め、判断は全部コア（src/domain）に任せる。
//   読む → コアで決める → イベントを追記 → fold して投影を保存

export interface Clock {
  now(): string;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };

export const randomIds = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

export interface ServiceDeps {
  repo: Repo;
  clock: Clock;
  newId: (prefix: string) => string;
  decider: Decider;
  connectors: Connectors;
  policy: IngestPolicy;
}

export type IngestResult =
  | { status: 'duplicate'; signalId: string }
  | { status: 'merged'; signalId: string; threadId: string | null }
  | ({ status: 'threaded'; signalId: string } & IngestOutcome);

/** 状態の写しの結果。no_thread はまだ課題のスレッドがない（写さない） */
export type MirrorResult =
  | { status: 'mirrored'; threadId: string; newThread: boolean; fields: MirrorFields }
  | { status: 'unchanged'; threadId: string }
  | { status: 'no_thread'; threadKey: string };

const MAX_RETRIES = 3;

export class MurmurService {
  constructor(readonly deps: ServiceDeps) {}

  // ---- 土台 ----

  async directory(): Promise<Directory> {
    return new Directory(await this.deps.repo.master.loadSeed());
  }

  /** 投影を読み、取りこぼしたイベントがあれば追いつく */
  async state(): Promise<Projections> {
    const { repo } = this.deps;
    let saved = (await repo.projections.load()) ?? emptyProjections();
    if (isStaleProjections(saved)) {
      // 投影の形が古い（0038 で名指しを足した前のもの）。イベントから作り直す
      await repo.projections.clear();
      saved = emptyProjections();
    }
    const missing = await repo.events.read(saved.lastSeq);
    if (missing.length === 0) return saved;
    const { projections, changes } = foldChanges(missing, saved);
    await repo.projections.save(projections, changes);
    return projections;
  }

  /** 投影を消してイベントから作り直す（H1 の検証にも使う） */
  async rebuild(): Promise<Projections> {
    await this.deps.repo.projections.clear();
    return this.state();
  }

  private context(dir: Directory): CoreContext {
    return { dir, now: this.deps.clock.now(), newId: this.deps.newId };
  }

  /**
   * 1 回のコマンド処理。decide はコアの関数を呼んでイベントを返す。
   * 追記が競合したら読み直してやり直す（楽観ロック）。
   */
  private async run<T>(
    decide: (p: Projections, ctx: CoreContext) => Promise<{ events: DraftEvent[]; result: T }> | { events: DraftEvent[]; result: T },
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const p = await this.state();
      const ctx = this.context(await this.directory());
      const { events, result } = await decide(p, ctx);
      if (events.length === 0) return result;
      try {
        const stored = await this.deps.repo.events.append(p.lastSeq, events, ctx.now);
        const { projections, changes } = foldChanges(stored, p);
        await this.deps.repo.projections.save(projections, changes);
        return result;
      } catch (err) {
        if (err instanceof ConcurrencyError && attempt < MAX_RETRIES) continue;
        throw err;
      }
    }
  }

  /**
   * マスタの書き換え（0030 の 5）。edit はコアの関数で、今のマスタの写しを書き換える（整合性はコアが確かめる）。
   * 差分と変更の記録を同じ書き込みで残す。イベントは出さない（fold はマスタに依存しない）
   */
  async changeMaster<T>(
    actorUserId: string | null,
    reason: string | undefined,
    edit: (draft: Seed, ctx: CoreContext) => T,
  ): Promise<{ result: T; changes: MasterChange[] }> {
    const before = await this.deps.repo.master.loadSeed();
    const ctx = this.context(new Directory(before));
    let result!: T;
    const { changes } = planMasterEdit(before, (d) => {
      result = edit(d, ctx);
    });
    await this.deps.repo.master.applyChanges(changes, { at: ctx.now, actorUserId, reason });
    return { result, changes };
  }

  async viewer(userId: string): Promise<{ viewer: Viewer; dir: Directory }> {
    const dir = await this.directory();
    return { viewer: deriveViewer(dir, userId), dir };
  }

  // ---- Ingest ----

  async ingest(inbound: InboundSignal): Promise<IngestResult> {
    return this.run<IngestResult>(async (p, ctx) => {
      const prepared = prepareInbound(p, ctx, inbound);
      if (prepared.kind === 'duplicate') return { events: [], result: { status: 'duplicate', signalId: prepared.signalId } };
      // 記録した送信の観測（記録が先に届いた順）。シグナルは 1 本のまま、イベントは出さない（H5）
      if (prepared.kind === 'merged') return { events: [], result: { status: 'merged', signalId: prepared.signalId, threadId: prepared.threadId } };

      const { payload, dataSource } = prepared;
      const sigEvent = signalEvent(payload);
      // シグナルを先に畳み込んだ状態で判断する（索引に入るだけで、どのスレッドにもまだ入っていない）
      const withSignal = fold([{ ...sigEvent, seq: p.lastSeq + 1, at: ctx.now }], p);
      const plan = planIngest(withSignal, ctx, dataSource, payload, this.deps.policy);
      let decided;
      if (plan.kind === 'decided') decided = plan;
      else {
        const { raw, by } = await this.deps.decider.decide(plan.request);
        decided = finalizeIngest(ctx, plan.request, raw, by);
      }
      return {
        events: [sigEvent, ...decided.events],
        result: { status: 'threaded', signalId: payload.signalId, ...decided.outcome },
      };
    });
  }

  /** 状態の写し（Jira の課題・PR の状態）。変わった項目だけを ThreadMirrored で写す（0031） */
  async mirror(inbound: InboundMirror): Promise<MirrorResult> {
    return this.run<MirrorResult>((p, ctx) => {
      const plan = planMirror(p, ctx, inbound);
      if (plan.kind === 'no_thread') return { events: [], result: { status: 'no_thread', threadKey: plan.threadKey } };
      if (plan.kind === 'unchanged') return { events: [], result: { status: 'unchanged', threadId: plan.threadId } };
      return { events: plan.events, result: { status: 'mirrored', threadId: plan.threadId, newThread: plan.newThread, fields: plan.fields } };
    });
  }

  /** コネクタ・Webhook から来た 1 件（シグナルか状態の写し） */
  async ingestItem(item: InboundItem): Promise<IngestResult | MirrorResult> {
    return isMirror(item) ? this.mirror(item) : this.ingest(item);
  }

  // ---- 定期処理（Cron） ----

  /** 各データソースから、そのチャネルのコネクタで取り込む */
  async pollConnectors(): Promise<(IngestResult | MirrorResult)[]> {
    const dir = await this.directory();
    const results: (IngestResult | MirrorResult)[] = [];
    for (const ds of dir.seed.dataSources) {
      // 実行時につないだデータソース（Graph など）はキューの同期が取り込む（0024）
      if (ds.kind !== 'service' || ds.connector) continue;
      const connector = this.deps.connectors[ds.channel];
      if (!connector) continue;
      const { items } = await connector.pull(ds, null);
      for (const item of items) results.push(await this.ingestItem(item));
    }
    return results;
  }

  /** 期限の見回り。返事期待の期限を過ぎたスレッドに ReplyOverdue を出す（冪等） */
  async checkOverdue(): Promise<number> {
    return this.run((p, ctx) => {
      const events = planOverdue(ctx.dir, p, ctx.now);
      return { events, result: events.length };
    });
  }

  async tick(): Promise<{ ingested: number; overdue: number }> {
    const ingested = (await this.pollConnectors()).length;
    return { ingested, overdue: await this.checkOverdue() };
  }

  // ---- スタンド向け API（Viewer = ゲートウェイから伝搬された User） ----

  async me(userId: string) {
    const { viewer, dir } = await this.viewer(userId);
    const user = dir.seed.users.find((u) => u.id === userId);
    if (!user) throw new DomainError('not_found', `user ${userId} not found`);
    return {
      user,
      contact: viewer.contactId === null ? null : { contactId: viewer.contactId, name: dir.contact(viewer.contactId)?.name ?? '' },
      lists: viewer.listIds.map((id) => {
        const ds = dir.dataSource(dir.list(id)?.dataSourceId ?? '');
        return { id, dataSourceId: ds?.id ?? '', name: ds?.name ?? id, kind: ds?.kind ?? 'service' };
      }),
    };
  }

  /** サインインした sub の User がなければ作る（名前は空、Contact はなし。0030 の 6）。API の入口で毎回呼ぶ */
  async ensureUser(userId: string): Promise<void> {
    const seed = await this.deps.repo.master.loadSeed();
    if (seed.users.some((u) => u.id === userId)) return;
    await this.changeMaster(userId, 'サインイン', (d) => ensureUser(d, userId));
  }

  async renameMe(userId: string, name: string) {
    await this.changeMaster(userId, '名前を付ける', (d) => renameUser(d, userId, name));
    return this.me(userId);
  }

  /** 個人のリストを作る（スタンドがゲートウェイの接続を確かめてから呼ぶ。0030 の 7） */
  async createDataSource(userId: string, input: PersonalDataSourceInput) {
    const { result } = await this.changeMaster(userId, `個人のリスト ${input.name}`, (d, ctx) => createPersonalDataSource(d, userId, input, ctx));
    return { ...(await this.getList(userId, result.listId)), identity: result.identity };
  }

  /** 読者になっているリストでの自分のアイデンティティを決める（0030 の 7） */
  async setIdentity(userId: string, listId: string, identity: string) {
    const { viewer, dir } = await this.viewer(userId);
    const ds = dir.dataSource(dir.list(listId)?.dataSourceId ?? '');
    if (!ds || !viewer.listIds.includes(listId)) throw new DomainError('not_found', `list ${listId} not found`);
    const { result } = await this.changeMaster(userId, `リスト ${listId} でのアイデンティティ`, (d, ctx) =>
      bindIdentity(d, userId, { channel: ds.channel, value: identity.trim() }, ctx),
    );
    return result;
  }

  /** 共有のリストに読者を足す（管理者だけ。スタンドの API にはしない。0030 の 7） */
  async addListMember(input: { listId: string; userId: string; identity?: string; actor?: string }) {
    const { result } = await this.changeMaster(input.actor ?? null, `リスト ${input.listId} の読者`, (d, ctx) =>
      addListMember(d, input.listId, input.userId, input.identity, ctx),
    );
    return result;
  }

  // ---- 名寄せ（0030 の 8・9）。Contact はチームで共有する連絡先なので、チームのメンバーが読み書きする ----

  private async member(userId: string): Promise<{ viewer: Viewer; dir: Directory }> {
    const v = await this.viewer(userId);
    requireMember(v.viewer);
    return v;
  }

  async unresolvedAddresses(userId: string) {
    const { viewer, dir } = await this.member(userId);
    return unresolvedAddresses(dir, viewer, await this.state());
  }

  async searchContacts(userId: string, q?: string) {
    const { dir } = await this.member(userId);
    return searchContacts(dir, q);
  }

  async getContact(userId: string, contactId: string) {
    const { dir } = await this.member(userId);
    const c = dir.contact(contactId);
    if (!c) throw new DomainError('not_found', `contact ${contactId} not found`);
    return contactView(dir, c);
  }

  async createContact(userId: string, input: { name: string; address?: AddressRef }) {
    await this.member(userId);
    const { result } = await this.changeMaster(userId, `Contact ${input.name}`, (d, ctx) => createContact(d, input, ctx));
    return this.getContact(userId, result);
  }

  async addContactAddress(userId: string, contactId: string, input: { address: AddressRef; validFrom?: string; reason?: string }) {
    await this.member(userId);
    await this.changeMaster(userId, input.reason, (d, ctx) => addAddress(d, contactId, input.address, ctx, input.validFrom));
    return this.getContact(userId, contactId);
  }

  async endContactAddress(userId: string, contactId: string, addressId: string, input: { validTo?: string; reason?: string }) {
    await this.member(userId);
    await this.changeMaster(userId, input.reason, (d, ctx) => endAddress(d, contactId, addressId, ctx, input.validTo));
    return this.getContact(userId, contactId);
  }

  async renameContact(userId: string, contactId: string, name: string) {
    await this.member(userId);
    await this.changeMaster(userId, '名前を直す', (d) => renameContact(d, contactId, name));
    return this.getContact(userId, contactId);
  }

  async mergeContacts(userId: string, intoId: string, fromId: string, reason?: string) {
    await this.member(userId);
    await this.changeMaster(userId, reason ?? `${fromId} を ${intoId} にまとめる`, (d) => mergeContacts(d, intoId, fromId));
    return this.getContact(userId, intoId);
  }

  async unbindContact(userId: string, contactId: string) {
    await this.changeMaster(userId, 'User との結びを外す', (d) => unbindContact(d, contactId, userId));
    return this.getContact(userId, contactId);
  }

  async listThreads(userId: string, opts: { filter?: ThreadFilter; dataSourceId?: string; since?: string } = {}) {
    const { viewer, dir } = await this.viewer(userId);
    return listThreads(dir, viewer, await this.state(), opts);
  }

  async getThread(userId: string, threadId: string, opts: { since?: string } = {}) {
    const { viewer, dir } = await this.viewer(userId);
    const view = getThreadView(dir, viewer, await this.state(), threadId, opts);
    if (!view) throw new DomainError('not_found', `thread ${threadId} not found`);
    return view;
  }

  /** メモ（経過の記録）を個人リストのスレッドに書く（0039 の決定 2）。返すのはそのスレッド */
  async addNote(userId: string, input: { threadId: string; body: string; author?: Author }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: addNote(p, viewer, ctx, input).events, result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  async claimThread(userId: string, input: { threadId: string; userId: string | null; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: claimThread(p, viewer, ctx.dir, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  /** 名指しを外す（0038 の決定 3・4） */
  async acknowledge(userId: string, input: { threadId: string; untilSignalId?: string; addresses?: AddressRef[]; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: acknowledgeAttention(p, viewer, ctx.dir, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  /** 複数のスレッドの自分への名指しを、それぞれの最新のシグナルまでまとめて外す。外したスレッドの数を返す */
  async acknowledgeMany(userId: string, input: { threadIds: string[]; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    const acknowledged = await this.run((p, ctx) => {
      const events = [...new Set(input.threadIds)].flatMap((threadId) => acknowledgeAttention(p, viewer, ctx.dir, { threadId, reason: input.reason }));
      return { events, result: events.length };
    });
    return { acknowledged };
  }

  async linkThreads(userId: string, input: { threadId: string; otherThreadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p) => ({ events: linkThreads(p, viewer, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  async unlinkThreads(userId: string, input: { threadId: string; otherThreadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p) => ({ events: unlinkThreads(p, viewer, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  /** 送信の記録。スタンドがゲートウェイ経由で送った直後に呼ぶ。返すのは送ったシグナルの入ったスレッド */
  async recordSent(userId: string, input: RecordSentInput) {
    const { viewer, dir } = await this.viewer(userId);
    const ds = dir.dataSource(input.dataSourceId);
    if (!ds || !viewer.dataSourceIds.includes(ds.id)) {
      throw new DomainError('not_found', `data source ${input.dataSourceId} not found`);
    }
    const threadId = await this.run((p, ctx) => {
      const { events, threadId } = recordSent(p, viewer, ctx, input);
      return { events, result: threadId };
    });
    return this.getThread(userId, threadId);
  }

  async dismissThread(userId: string, input: { threadId: string; reason: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: dismissThread(p, viewer, ctx.dir, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  async reopenThread(userId: string, input: { threadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: reopenThread(p, viewer, ctx.dir, input), result: undefined }));
    return this.getThread(userId, input.threadId);
  }

  async moveSignal(userId: string, input: { signalId: string; to: MoveTarget; reason: string }) {
    const { viewer } = await this.viewer(userId);
    const threadId = await this.run((p, ctx) => {
      const { events, threadId } = moveSignal(p, viewer, ctx, input);
      return { events, result: threadId };
    });
    return this.getThread(userId, threadId);
  }

  async listLists(userId: string) {
    const { viewer, dir } = await this.viewer(userId);
    return listLists(dir, viewer);
  }

  async getList(userId: string, listId: string) {
    const { viewer, dir } = await this.viewer(userId);
    const view = getListView(dir, viewer, listId);
    if (!view) throw new DomainError('not_found', `list ${listId} not found`);
    return view;
  }
}
