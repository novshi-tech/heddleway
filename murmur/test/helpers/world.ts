import {
  DEFAULT_POLICY,
  Directory,
  Seed,
  deriveViewer,
  emptyProjections,
  finalizeIngest,
  fold,
  planIngest,
  planMirror,
  prepareInbound,
  signalEvent,
  summarizeThread,
  type AiIngestDecision,
  type CoreContext,
  type DomainEvent,
  type DraftEvent,
  type InboundSignal,
  type IngestOutcome,
  type IngestRequest,
  type MirrorFields,
  type Projections,
} from '../../src/domain';

/**
 * コアのユニットテスト用の小さな世界。
 * 1 デプロイ = 1 チーム（UBS）:
 *   ds_support   support@（組織の資格情報、読者は Alice と Bob）
 *   ds_alice     Alice の個人のメールボックス（読者は Alice だけ）
 *   ds_line      LINE 公式アカウント（組織、読者は Bob だけ）
 *   ds_tasks_*   タスクのリスト（Alice と Bob の個人リスト。状態を持つソース。0039）
 *   ds_slack     Slack の #general（グループ、組織の資格情報、読者は Eve だけ。Eve はタスクのリストを持たない）
 * u_mallory: ゲートウェイの User だが、このデプロイに Contact がない（チームの外）
 */
/** 窓口のアドレス（Contact に属さない。0030） */
const SUPPORT = { channel: 'email' as const, value: 'support@ubs.example' };
const OA = { channel: 'line' as const, value: '@ubs' };
const SLACK = { channel: 'slack' as const, value: 'T_UBS/C_GENERAL' };

export const seed = Seed.parse({
  users: [
    { id: 'u_alice', name: 'Alice' },
    { id: 'u_bob', name: 'Bob' },
    { id: 'u_eve', name: 'Eve' },
    { id: 'u_mallory', name: 'Mallory（チームの外）' },
  ],
  contacts: [
    { id: 'p_alice', name: 'Alice', userId: 'u_alice' },
    { id: 'p_bob', name: 'Bob', userId: 'u_bob' },
    { id: 'p_carol', name: 'Carol（顧客）' },
    { id: 'p_dave', name: 'Dave 工務店' },
    { id: 'p_eve', name: 'Eve', userId: 'u_eve' },
  ],
  addresses: [
    { id: 'a_alice', channel: 'email', value: 'alice@ubs.example', contactId: 'p_alice' },
    { id: 'a_carol', channel: 'email', value: 'carol@example.com', contactId: 'p_carol' },
    { id: 'a_dave', channel: 'email', value: 'info@dave.example', contactId: 'p_dave' },
    {
      id: 'a_dave_old',
      channel: 'email',
      value: 'old@dave.example',
      contactId: 'p_dave',
      validTo: '2026-01-01T00:00:00.000Z',
    },
    { id: 'a_carol_line', channel: 'line', value: 'U_carol', contactId: 'p_carol' },
    { id: 'a_eve', channel: 'slack', value: 'T_UBS/U_EVE', contactId: 'p_eve' },
  ],
  credentialRefs: [
    { id: 'c_support', principal: { kind: 'team' }, address: SUPPORT },
    { id: 'c_alice', principal: { kind: 'user', userId: 'u_alice' }, address: { channel: 'email', value: 'alice@ubs.example' } },
    { id: 'c_oa', principal: { kind: 'team' }, address: OA },
    { id: 'c_slack', principal: { kind: 'team' }, address: SLACK },
    { id: 'c_tasks_alice', principal: { kind: 'user', userId: 'u_alice' }, address: { channel: 'todo', value: 'alice@ubs.example' } },
    { id: 'c_tasks_bob', principal: { kind: 'user', userId: 'u_bob' }, address: { channel: 'todo', value: 'bob@ubs.example' } },
  ],
  dataSources: [
    { kind: 'service', id: 'ds_support', channel: 'email', name: 'support@', credentialRefId: 'c_support', selfAddresses: [SUPPORT] },
    { kind: 'service', id: 'ds_alice', channel: 'email', name: 'Alice のメールボックス', credentialRefId: 'c_alice' },
    { kind: 'service', id: 'ds_line', channel: 'line', name: 'LINE 公式アカウント', credentialRefId: 'c_oa', selfAddresses: [OA] },
    {
      kind: 'service',
      id: 'ds_tasks_alice',
      channel: 'todo',
      name: 'Alice のタスク',
      credentialRefId: 'c_tasks_alice',
      selfAddresses: [{ channel: 'todo', value: 'alice@ubs.example' }],
    },
    { kind: 'service', id: 'ds_tasks_bob', channel: 'todo', name: 'Bob のタスク', credentialRefId: 'c_tasks_bob', selfAddresses: [{ channel: 'todo', value: 'bob@ubs.example' }] },
    {
      kind: 'service',
      id: 'ds_slack',
      channel: 'slack',
      name: '#general',
      credentialRefId: 'c_slack',
      selfAddresses: [SLACK],
      group: true,
    },
  ],
  lists: [
    { id: 'l_support', dataSourceId: 'ds_support' },
    { id: 'l_alice', dataSourceId: 'ds_alice' },
    { id: 'l_line', dataSourceId: 'ds_line' },
    { id: 'l_tasks_alice', dataSourceId: 'ds_tasks_alice' },
    { id: 'l_tasks_bob', dataSourceId: 'ds_tasks_bob' },
    { id: 'l_slack', dataSourceId: 'ds_slack' },
  ],
  listMembers: [
    { listId: 'l_support', userId: 'u_alice' },
    { listId: 'l_support', userId: 'u_bob' },
    { listId: 'l_alice', userId: 'u_alice' },
    { listId: 'l_line', userId: 'u_bob' },
    { listId: 'l_tasks_alice', userId: 'u_alice' },
    { listId: 'l_tasks_bob', userId: 'u_bob' },
    { listId: 'l_slack', userId: 'u_eve' },
  ],
});

export const dir = new Directory(seed);

/** 投影のスレッドに、クエリ層で解決した通信状態（ボール・相手・未応答。0030）を重ねたもの */
export const view = (p: Projections, id: string, d: Directory = dir) => ({ ...p.threads[id]!, ...summarizeThread(d, p, p.threads[id]!) });
export const alice = deriveViewer(dir, 'u_alice');
export const bob = deriveViewer(dir, 'u_bob');
export const eve = deriveViewer(dir, 'u_eve');
export const mallory = deriveViewer(dir, 'u_mallory');

/** 決定的な ID と時刻 */
export function makeCtx(now = '2026-10-16T09:00:00.000Z'): CoreContext & { setNow(n: string): void } {
  let n = 0;
  const ctx = {
    dir,
    now,
    newId: (prefix: string) => `${prefix}_${++n}`,
    setNow(v: string) {
      ctx.now = v;
    },
  };
  return ctx;
}

/** ドラフトを seq・at 付きのイベントにする */
export class EventLog {
  readonly events: DomainEvent[] = [];

  push(drafts: readonly DraftEvent[], at: string): DomainEvent[] {
    const stored = drafts.map((d, i) => ({ ...d, seq: this.events.length + i + 1, at }) as DomainEvent);
    this.events.push(...stored);
    return stored;
  }

  state(): Projections {
    return fold(this.events, emptyProjections());
  }
}

/** support@ に届いたメール（from を support@ にすれば観測された送信） */
export function email(over: Omit<Partial<InboundSignal>, 'from' | 'to'> & { from: string; sourceRef: string; to?: string[] }): InboundSignal {
  const { from, to, ...rest } = over;
  return {
    dataSourceId: 'ds_support',
    channel: 'email',
    body: '本文',
    ...rest,
    from: { channel: 'email', value: from },
    to: (to ?? ['support@ubs.example']).map((value) => ({ channel: 'email' as const, value })),
  };
}

export function line(over: Omit<Partial<InboundSignal>, 'from' | 'to'> & { from: string; sourceRef: string; to?: string }): InboundSignal {
  const { from, to, ...rest } = over;
  return {
    dataSourceId: 'ds_line',
    channel: 'line',
    body: '本文',
    ...rest,
    from: { channel: 'line', value: from },
    to: [{ channel: 'line', value: to ?? '@ubs' }],
  };
}

/**
 * タスクのリストにタスクを 1 つ作る（タスクのサービスの写し。0039 の決定 3）。返すのはスレッドの ID。
 * key はタスクの ID（省けば件名から作る）。fields で写しの項目を足せる
 */
export function task(
  log: EventLog,
  ctx: CoreContext,
  title: string,
  opts: { dataSourceId?: string; key?: string; fields?: Omit<MirrorFields, 'title'> } = {},
): string {
  const dataSourceId = opts.dataSourceId ?? 'ds_tasks_alice';
  const plan = planMirror(log.state(), ctx, {
    kind: 'mirror',
    dataSourceId,
    channel: 'todo',
    threadKey: opts.key ?? `task:${title}`,
    fields: { title, holders: [dataSourceId === 'ds_tasks_bob' ? 'bob@ubs.example' : 'alice@ubs.example'], ...(opts.fields ?? {}) },
    sourceRef: `todo:${opts.key ?? title}:created`,
  });
  if (plan.kind !== 'mirrored') throw new Error(`task ${title} not created`);
  log.push(plan.events, ctx.now);
  return plan.threadId;
}

/** タスクの写しを更新する（完了・期限・件名など）。key は task の key（省けば task:<件名>） */
export function updateTask(log: EventLog, ctx: CoreContext, key: string, fields: MirrorFields, dataSourceId = 'ds_tasks_alice'): void {
  const plan = planMirror(log.state(), ctx, { kind: 'mirror', dataSourceId, channel: 'todo', threadKey: key, fields, sourceRef: `todo:${key}:${ctx.now}` });
  if (plan.kind === 'mirrored') log.push(plan.events, ctx.now);
}

/** AI の代わりの答え（needs_response は 0038 から使わない） */
export const answer = (over: Partial<AiIngestDecision> = {}): AiIngestDecision => ({
  thread: 'new',
  thread_id: null,
  title: null,
  needs_response: true,
  reason: 'test',
  confidence: 0.9,
  ...over,
});

/** シェルを通さずにコアだけで Ingest を 1 件回す（サービスと同じ手順） */
export function ingestPure(
  log: EventLog,
  ctx: CoreContext,
  inbound: InboundSignal,
  decide: (req: IngestRequest) => AiIngestDecision = () => {
    throw new Error('AI decision not expected');
  },
  policy = DEFAULT_POLICY,
): { duplicate: boolean; events: DomainEvent[]; signalId?: string; outcome?: IngestOutcome; request?: IngestRequest } {
  const p = log.state();
  const prepared = prepareInbound(p, ctx, inbound);
  if (prepared.kind !== 'signal') return { duplicate: true, events: [], signalId: prepared.signalId };
  const sig = signalEvent(prepared.payload);
  const withSignal = fold([{ ...sig, seq: p.lastSeq + 1, at: ctx.now } as DomainEvent], p);
  const plan = planIngest(withSignal, ctx, prepared.dataSource, prepared.payload, policy);
  const decided =
    plan.kind === 'decided' ? plan : finalizeIngest(ctx, plan.request, decide(plan.request), 'ai');
  const events = log.push([sig, ...decided.events], ctx.now);
  return {
    duplicate: false,
    events,
    signalId: prepared.payload.signalId,
    outcome: decided.outcome,
    request: plan.kind === 'needs_decision' ? plan.request : undefined,
  };
}
