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
  type ThreadScopeRequest,
  isGroup,
  isOurs,
  dedupeRequest,
  mirrorRequest,
  threadingRequest,
  type WorkingSetRequest,
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
  needsAiThreading,
  planMasterEdit,
  prepareInbound,
  reopenThread,
  retitleThread,
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
  type TimelineEntry,
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
  /** 区切りの AI 判断。AI を使わないデプロイ（policy.threading が source。0050）ではない */
  decider?: Decider;
  connectors: Connectors;
  policy: IngestPolicy;
}

export type IngestResult =
  | { status: 'duplicate'; signalId: string }
  | { status: 'merged'; signalId: string; threadId: string | null }
  | ({ status: 'threaded'; signalId: string } & IngestOutcome)
  /** AI を使わないデプロイで、ソースのスレッドで区切れないリストのシグナル（0050 の決定 3）。取り込まない */
  | { status: 'unsupported'; dataSourceId: string };

/** 状態の写しの結果。no_thread はまだ課題のスレッドがない（写さない） */
export type MirrorResult =
  | { status: 'mirrored'; threadId: string; newThread: boolean; fields: MirrorFields }
  | { status: 'unchanged'; threadId: string }
  | { status: 'no_thread'; threadKey: string };

const MAX_RETRIES = 3;

export class TopicIndexService {
  constructor(readonly deps: ServiceDeps) {}

  // ---- 土台 ----

  async directory(): Promise<Directory> {
    return new Directory(await this.deps.repo.master.loadSeed());
  }

  /** 投影を読み、取りこぼしたイベントがあれば追いつく */
  async state(): Promise<Projections> {
    const { repo } = this.deps;
    const saved = (await repo.projections.load()) ?? emptyProjections();
    // 投影の形が古い（0038 で名指しを足した前のもの）。イベントから作り直す（消さずに、丸ごとの保存 1 回で入れ替える）
    if (isStaleProjections(saved)) return this.refold();
    const missing = await repo.events.read(saved.lastSeq);
    if (missing.length === 0) return saved;
    const { projections, changes } = foldChanges(missing, saved);
    // 土台より先の保存先や、すでに先へ進んだ保存先には当たらない（弾かれる）。そのときも投影は返し、次の state() が追いつく
    await repo.projections.save(projections, changes);
    return projections;
  }

  /**
   * イベントを頭から畳み、保存済みの投影を丸ごと 1 回の保存で入れ替える（H1 の検証にも使う）。
   * 保存先を先に空にしない: 空の間に別の書き手の差分が着いて、足りない行のまま lastSeq が進むことがない
   */
  async rebuild(): Promise<Projections> {
    return this.refold();
  }

  private async refold(): Promise<Projections> {
    const projections = fold(await this.deps.repo.events.read());
    await this.deps.repo.projections.save(projections);
    return projections;
  }

  /**
   * 取り込みの作業範囲（0046）。保存先が持たない・保存済みの投影より先のイベントがある（追いつきが要る）・投影の形が古いときは、
   * 全件（state()）を使う。全件は作業範囲を必ず含むので、どちらでも同じ判断になる（窓の外の候補を除く）
   */
  private async workingSet(req: WorkingSetRequest): Promise<{ p: Projections; partial: boolean }> {
    const store = this.deps.repo.projections;
    return this.scoped(store.workingSet ? () => store.workingSet!(req) : null);
  }

  /**
   * 範囲で読む（0046・0047）。保存先が持たない・保存済みの投影より先のイベントがある（追いつきが要る）・投影の形が古いときは、
   * 全件（state()）を使う。全件は範囲を必ず含むので、どちらでも同じ判断になる（0046 の窓の外の候補を除く）
   */
  private async scoped(read: (() => Promise<Projections | null>) | null): Promise<{ p: Projections; partial: boolean }> {
    const ws = read ? await read() : null;
    if (ws && !isStaleProjections(ws) && (await this.deps.repo.events.read(ws.lastSeq)).length === 0) return { p: ws, partial: true };
    return { p: await this.state(), partial: false };
  }

  /** 詳細と操作の範囲（0047 の決定 1） */
  private threadScope(req: ThreadScopeRequest): Promise<{ p: Projections; partial: boolean }> {
    const store = this.deps.repo.projections;
    return this.scoped(store.threadScope ? () => store.threadScope!(req) : null);
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
    load: (ctx: CoreContext) => Promise<{ p: Projections; partial: boolean }> = async () => ({ p: await this.state(), partial: false }),
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const ctx = this.context(await this.directory());
      const { p, partial } = await load(ctx);
      const { events, result } = await decide(p, ctx);
      if (events.length === 0) return result;
      try {
        const stored = await this.deps.repo.events.append(p.lastSeq, events, ctx.now);
        const { projections, changes } = foldChanges(stored, p);
        // 作業範囲の上で畳んだものは、変わった行だけ書き、全件の写しとしては持たない（0046）
        await this.deps.repo.projections.save(projections, changes, partial ? { partial: true } : undefined);
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
    // AI を使わないデプロイでは、ソースのスレッドで区切れないリストは取り込まない（0050 の決定 3。つなぐ操作も断る）
    if (this.deps.policy.threading === 'source') {
      const ds = (await this.directory()).dataSource(inbound.dataSourceId);
      if (ds?.kind === 'service' && needsAiThreading(ds)) return { status: 'unsupported', dataSourceId: inbound.dataSourceId };
    }
    // 重複と記録との統合は、索引の数行で決まる（0046 の決定 1 の段 1）。どちらでもなければ、区切りの作業範囲で読み直して決める
    // 確かめるだけなので ID を使わない（採番を進めると、後の判断の ID がずれる）
    const ctx0 = { ...this.context(await this.directory()), newId: (prefix: string) => `${prefix}_probe` };
    const quick = prepareInbound((await this.workingSet(dedupeRequest(inbound))).p, ctx0, inbound);
    if (quick.kind === 'duplicate') return { status: 'duplicate', signalId: quick.signalId };
    if (quick.kind === 'merged') return { status: 'merged', signalId: quick.signalId, threadId: quick.threadId };
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
        if (!this.deps.decider) throw new Error('区切りの AI 判断が要るが、このデプロイは AI を使わない（0050）');
        const { raw, by } = await this.deps.decider.decide(plan.request);
        decided = finalizeIngest(ctx, plan.request, raw, by);
      }
      return {
        events: [sigEvent, ...decided.events],
        result: { status: 'threaded', signalId: payload.signalId, ...decided.outcome },
      };
    }, (ctx) => {
      // 返事待ちの段の見方（awaitingThread と同じ: こちらからの送信は見ない、グループの会話は全部、ほかは送り主）
      const ds = ctx.dir.dataSource(inbound.dataSourceId);
      const conversation =
        ds?.kind === 'service' ? { ours: isOurs(ctx.dir, ds, inbound.from, ctx.now), group: isGroup(ds, { anchors: inbound.anchors ?? {} }) } : { ours: false, group: true };
      return this.workingSet(threadingRequest(inbound, ctx.now, this.deps.policy, conversation));
    });
  }

  /** 状態の写し（Jira の課題・PR の状態）。変わった項目だけを ThreadMirrored で写す（0031） */
  async mirror(inbound: InboundMirror): Promise<MirrorResult> {
    return this.run<MirrorResult>((p, ctx) => {
      const plan = planMirror(p, ctx, inbound);
      if (plan.kind === 'no_thread') return { events: [], result: { status: 'no_thread', threadKey: plan.threadKey } };
      if (plan.kind === 'unchanged') return { events: [], result: { status: 'unchanged', threadId: plan.threadId } };
      return { events: plan.events, result: { status: 'mirrored', threadId: plan.threadId, newThread: plan.newThread, fields: plan.fields } };
    }, () => this.workingSet(mirrorRequest(inbound)));
  }

  /**
   * コネクタがまとめて読んだもの（重なりつきの見回りなど）を、順に取り込む。すでに取り込んだシグナル（sourceRef が索引にあるもの）は、
   * 1 件ずつの取り込みに回す前に 1 回の照会で落とす（判定は prepareInbound の duplicate と同じ。0046）。状態の写しはそのまま回す
   */
  async ingestItems(items: readonly InboundItem[]): Promise<(IngestResult | MirrorResult)[]> {
    const known = new Map<string, Set<string>>();
    const store = this.deps.repo.projections;
    if (store.knownSourceRefs) {
      const byDs = new Map<string, string[]>();
      for (const it of items) if (!isMirror(it)) byDs.set(it.dataSourceId, [...(byDs.get(it.dataSourceId) ?? []), it.sourceRef]);
      for (const [ds, refs] of byDs) known.set(ds, await store.knownSourceRefs(ds, refs));
    }
    const results: (IngestResult | MirrorResult)[] = [];
    for (const it of items) {
      if (!isMirror(it) && known.get(it.dataSourceId)?.has(it.sourceRef)) continue;
      results.push(await this.ingestItem(it));
    }
    return results;
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
    return this.run(
      (p, ctx) => {
        const events = planOverdue(ctx.dir, p, ctx.now);
        return { events, result: events.length };
      },
      // 返事期待の期限を過ぎた候補のスレッドだけ読む（0046 の未決 3）。追いつきが要るときは全件
      (ctx) => {
        const store = this.deps.repo.projections;
        return this.scoped(store.overdueSet ? () => store.overdueSet!(ctx.now) : null);
      },
    );
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

  async listThreads(userId: string, opts: { filter?: ThreadFilter; dataSourceId?: string; since?: string; limit?: number; candidates?: boolean } = {}) {
    const { viewer, dir } = await this.viewer(userId);
    // 見えるリストのスレッドの行だけ。open 系の絞り込みは開いているものだけ（0047 の決定 2）
    const filter = opts.filter ?? 'open';
    const dataSourceIds = opts.dataSourceId ? viewer.dataSourceIds.filter((d) => d === opts.dataSourceId) : viewer.dataSourceIds;
    const store = this.deps.repo.projections;
    const req = { dataSourceIds, openOnly: filter !== 'all' && filter !== 'mine', candidates: opts.candidates };
    const { p } = await this.scoped(store.listScope ? () => store.listScope!(req) : null);
    return listThreads(dir, viewer, p, opts);
  }

  async getThread(userId: string, threadId: string, opts: { since?: string } = {}) {
    const { viewer, dir } = await this.viewer(userId);
    const { p } = await this.threadScope({ threadIds: [threadId], links: true, candidates: true });
    const view = getThreadView(dir, viewer, p, threadId, opts);
    if (!view) throw new DomainError('not_found', `thread ${threadId} not found`);
    return view;
  }

  /** メモ（経過の記録）を個人リストのスレッドに書く（0039 の決定 2）。返すのはそのスレッド */
  async addNote(userId: string, input: { threadId: string; body: string; author?: Author }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: addNote(p, viewer, ctx, input).events, result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  async claimThread(userId: string, input: { threadId: string; userId: string | null; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: claimThread(p, viewer, ctx.dir, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  /** 名指しを外す（0038 の決定 3・4） */
  async acknowledge(userId: string, input: { threadId: string; untilSignalId?: string; addresses?: AddressRef[]; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: acknowledgeAttention(p, viewer, ctx.dir, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  /** 複数のスレッドの自分への名指しを、それぞれの最新のシグナルまでまとめて外す。外したスレッドの数を返す */
  async acknowledgeMany(userId: string, input: { threadIds: string[]; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    const acknowledged = await this.run((p, ctx) => {
      const events = [...new Set(input.threadIds)].flatMap((threadId) => acknowledgeAttention(p, viewer, ctx.dir, { threadId, reason: input.reason }));
      return { events, result: events.length };
    }, () => this.threadScope({ threadIds: [...new Set(input.threadIds)] }));
    return { acknowledged };
  }

  async linkThreads(userId: string, input: { threadId: string; otherThreadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p) => ({ events: linkThreads(p, viewer, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId, input.otherThreadId] }));
    return this.getThread(userId, input.threadId);
  }

  async unlinkThreads(userId: string, input: { threadId: string; otherThreadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p) => ({ events: unlinkThreads(p, viewer, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId, input.otherThreadId] }));
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
    }, (ctx) => this.recordScope(input, ctx));
    return this.getThread(userId, threadId);
  }

  /**
   * 送信の記録の範囲（0047 の決定 1）: 取り込みと同じ索引の引き方（送信の ID・アンカー）で引いた範囲と、返事の置き先・元のスレッド。
   * 2 つを同じ lastSeq で読めなければ全件
   */
  private async recordScope(input: RecordSentInput, ctx: CoreContext): Promise<{ p: Projections; partial: boolean }> {
    const anchors = { ...(input.anchors ?? {}), messageId: input.sentRef, threadKey: input.anchors?.threadKey ?? input.sentRef };
    const base = threadingRequest(
      { dataSourceId: input.dataSourceId, sourceRef: `sent:${input.sentRef}`, anchors, from: { channel: 'email', value: '' } },
      ctx.now,
      this.deps.policy,
      { ours: true, group: false },
    );
    const lookup = { ...base, window: null };
    const ids = [input.replyToThreadId, input.sourceThreadId].filter((x): x is string => !!x);
    const a = await this.workingSet(lookup);
    const b = await this.threadScope({ threadIds: ids });
    if (!a.partial || !b.partial || a.p.lastSeq !== b.p.lastSeq) return a.partial ? { p: await this.state(), partial: false } : a;
    // 2 つの範囲を合わせる（どちらも保存済みの投影の部分。同じ ID は同じ行）
    const p: Projections = {
      lastSeq: a.p.lastSeq,
      threads: { ...a.p.threads, ...b.p.threads },
      signals: { ...a.p.signals, ...b.p.signals },
      index: { sourceRefs: { ...a.p.index.sourceRefs }, messageIds: { ...a.p.index.messageIds } },
    };
    return { p, partial: true };
  }

  async dismissThread(userId: string, input: { threadId: string; reason: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: dismissThread(p, viewer, ctx.dir, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  async reopenThread(userId: string, input: { threadId: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: reopenThread(p, viewer, ctx.dir, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  /** 件名を変える（0050 の決定 4） */
  async retitleThread(userId: string, input: { threadId: string; title: string; reason?: string }) {
    const { viewer } = await this.viewer(userId);
    await this.run((p, ctx) => ({ events: retitleThread(p, viewer, ctx.dir, input), result: undefined }), () => this.threadScope({ threadIds: [input.threadId] }));
    return this.getThread(userId, input.threadId);
  }

  async moveSignal(userId: string, input: { signalId: string; to: MoveTarget; reason: string }) {
    const { viewer } = await this.viewer(userId);
    const threadId = await this.run((p, ctx) => {
      const { events, threadId } = moveSignal(p, viewer, ctx, input);
      return { events, result: threadId };
    }, () => this.threadScope({ threadIds: input.to.kind === 'existing' ? [input.to.threadId] : [], signalIds: [input.signalId] }));
    return this.getThread(userId, threadId);
  }

  async listLists(userId: string) {
    const { viewer, dir } = await this.viewer(userId);
    return listLists(dir, viewer);
  }

  /** 本人の「参加中のリスト」の画面の材料（0048）。見えるリストと、その開いているトピック。User を作らない（画面を開いただけでは名乗らない） */
  async myLists(userId: string) {
    const { viewer, dir } = await this.viewer(userId);
    // 呼び方のない人の Contact は、名前がアドレスそのまま（Teams の ID など）で作られている（people.ts）。画面には出さず、名前なしにする
    const displayName = (r: { userId: string; contactId: string | null }) => {
      const own = dir.user(r.userId)?.name;
      if (own) return own;
      const c = r.contactId ? dir.contact(r.contactId) : undefined;
      if (!c || dir.addressesOfContact(c.id).some((a) => a.value === c.name)) return '';
      return c.name;
    };
    const lists = listLists(dir, viewer).map((l) => {
      const ds = dir.dataSource(l.dataSource.id);
      return { ...l, readers: l.readers.map((r) => ({ ...r, name: displayName(r) })), shared: ds?.kind === 'service' && !!ds.shared };
    });
    // 画面は結び候補を出さないので、キーの索引を読まない（0052）
    const threads = lists.length > 0 ? await this.listThreads(userId, { filter: 'open', candidates: false }) : [];
    return { name: dir.user(userId)?.name ?? '', lists, threads };
  }

  /**
   * 本人の画面のトピックの詳細の材料（0051）。見えなければ null。名前はここで解決し、画面には文字列だけを渡す。
   * User を作らない（myLists と同じ）
   */
  async threadPage(userId: string, threadId: string) {
    const { viewer, dir } = await this.viewer(userId);
    if (viewer.dataSourceIds.length === 0) return null;
    const { p } = await this.threadScope({ threadIds: [threadId], links: true, candidates: false });
    const view = getThreadView(dir, viewer, p, threadId);
    if (!view) return null;
    const userName = (id: string | null | undefined) => (id ? dir.user(id)?.name || '(呼び方なし)' : '');
    const addressName = (ref: AddressRef) => {
      const cid = dir.contactIdOfAddress(ref);
      const c = cid ? dir.contact(cid) : undefined;
      if (!c) return ref.value;
      return (c.userId ? dir.user(c.userId)?.name : '') || c.name || ref.value;
    };
    const t = view.thread;
    const assigneeNames = t.assignee
      ? [...t.assignee.userIds.map(userName), ...t.assignee.contactIds.map((id) => contactName(dir, id) || id), ...t.assignee.addresses.map((a) => a.value)]
      : [];
    const counterparts = [...t.counterpartContactIds.map((id) => contactName(dir, id)).filter((n) => n !== ''), ...t.counterpartAddresses.map((a) => a.value)];
    const titleOf = (id: string) => (id === t.id ? null : (view.linked.find((l) => l.threadId === id)?.title ?? null));
    const entries = view.timeline.map((e) => {
      const base = { at: e.at, kind: e.kind, fromLinked: titleOf(e.threadId) };
      if (e.signal) {
        const s = e.signal;
        return {
          ...base,
          signal: { direction: s.direction, from: addressName(s.from), to: s.to.map(addressName), subject: s.subject, body: s.body, attachments: s.attachments.length },
        };
      }
      if (e.note) return { ...base, note: { body: e.note.body, author: e.note.author.kind === 'agent' ? `${e.note.author.name}(エージェント)` : userName(e.actorUserId) } };
      return { ...base, text: entryText(e, userName, (id) => titleOf(id) ?? p.threads[id]?.title ?? null) };
    });
    const dsName = (id: string) => dir.dataSource(id)?.name ?? id;
    const linked = view.linked.map((l) => ({ id: l.threadId, title: l.title, listName: dsName(l.dataSourceId), myTurn: l.myTurn, dismissed: l.dismissed }));
    const ds = dir.dataSource(t.dataSourceId);
    return { view, shared: ds?.kind === 'service' && !!ds.shared, assigneeNames, counterparts, linked, entries };
  }

  async getList(userId: string, listId: string) {
    const { viewer, dir } = await this.viewer(userId);
    const view = getListView(dir, viewer, listId);
    if (!view) throw new DomainError('not_found', `list ${listId} not found`);
    return view;
  }
}

/** Contact の名前。名前がアドレスそのまま（呼び方のない人。people.ts）なら空 */
function contactName(dir: Directory, contactId: string): string {
  const c = dir.contact(contactId);
  if (!c) return '';
  if (c.userId) {
    const own = dir.user(c.userId)?.name;
    if (own) return own;
  }
  return dir.addressesOfContact(c.id).some((a) => a.value === c.name) ? '' : c.name;
}

/** 本人の画面のタイムラインの、シグナルとメモ以外の 1 行（0051） */
function entryText(e: TimelineEntry, userName: (id: string | null | undefined) => string, threadTitle: (id: string) => string | null): string {
  const who = userName(e.actorUserId);
  const by = who ? `${who}が` : '';
  switch (e.kind) {
    case 'claimed':
      return e.userId ? (e.userId === e.actorUserId ? `${by}担当した` : `${by}${userName(e.userId)}を担当にした`) : `${by}担当を外した`;
    case 'acknowledged':
      return `${by}アテンションを外した`;
    case 'dismissed':
      return `${by}片付けた${e.reason ? `(${e.reason})` : ''}`;
    case 'reopened':
      return `${by}再開した`;
    case 'retitled':
      return `${by}件名を「${e.title ?? ''}」にした`;
    case 'linked':
    case 'unlinked': {
      const other = e.otherThreadId ? threadTitle(e.otherThreadId) : null;
      return `${by}${other ? `「${other}」を` : 'トピックを'}${e.kind === 'linked' ? '関連づけた' : '関連づけから外した'}`;
    }
    case 'mirrored': {
      const f = e.fields ?? {};
      const parts = [
        f.closed === true ? '完了' : f.closed === false ? '未完了に戻った' : null,
        f.statusLabel ? `状態「${f.statusLabel}」` : null,
        f.title ? `件名「${f.title}」` : null,
        f.due !== undefined ? (f.due ? `期限 ${f.due}` : '期限なし') : null,
        f.holders !== undefined ? '担当者の変更' : null,
      ].filter((s): s is string => s !== null);
      return `ソースの変更${parts.length > 0 ? `: ${parts.join('、')}` : ''}`;
    }
    case 'overdue':
      return '返事の期限を過ぎた';
    default:
      return e.kind;
  }
}
