import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MurmurService, type IngestResult, type MirrorResult } from '../../src/app/service';
import { DummyConnector, MemoryDummyBackend } from '../../src/connectors/dummy/connector';
import type { Connectors } from '../../src/connectors/types';
import {
  canonicalJson,
  DEFAULT_POLICY,
  deriveViewer,
  Directory,
  getThreadView,
  listThreads,
  Seed,
  seedProblems,
  summarizeThread,
  ThreadedBy,
  visibleSignals,
  type AiIngestDecision,
  type IngestRequest,
  type Projections,
} from '../../src/domain';
import { createApp } from '../../src/http/app';
import { AiDecider, type Decider } from '../../src/ingest/deciders';
import { RecordReplayLlm, type LlmClient } from '../../src/ingest/llm';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { InboundMirrorBody, InboundSignalBody } from '../../src/api/schemas';
import { counterIds, ManualClock } from './clock';
import { FsRecordingStore } from './recordings';

// シナリオ（fixtures/<name>/）を流し込んで最後まで回し、expected.json と比べる。

export const FIXTURES_DIR = join(import.meta.dirname, '../../fixtures');

export const ScenarioConfig = z.object({
  title: z.string(),
  hypotheses: z.array(z.string()),
  /** desk-checked = 机上シミュレーション済み、draft = スタンドで回す前の下書き、stand-recorded = スタンド主導の記録を固めたもの */
  status: z.enum(['desk-checked', 'draft', 'stand-recorded']),
  notes: z.string().optional(),
});

const Bind = z.record(z.string(), z.string());

/** スタンドの操作（HTTP API と同じ入力）。ステップ 3 までの分 */
export const Tool = z.enum([
  'me',
  'list_threads',
  'get_thread',
  'dismiss_thread',
  'reopen_thread',
  'move_signal',
  'get_list',
  'add_note',
  'claim_thread',
  'link_threads',
  'unlink_threads',
  'record_sent',
  'acknowledge',
]);
export type Tool = z.infer<typeof Tool>;

export const Step = z.union([
  z.object({
    id: z.string(),
    at: z.string(),
    signal: z.record(z.string(), z.unknown()),
    bind: Bind.optional(),
    note: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    at: z.string(),
    action: z.object({ tool: Tool, as: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
    /**
     * record_sent のとき、ダミー上流がその送信を観測された送信として次の pull で返す（記録 → 観測の順。H5）。
     * 観測 → 記録の順は、signal の行を先に書く
     */
    echo: z.boolean().optional(),
    bind: Bind.optional(),
    note: z.string().optional(),
  }),
  /** 状態の写し（ダミーの Jira の課題・タスクのサービスのタスクの更新）。kind は省いてよい。bind は写したスレッド（threadId） */
  z.object({
    id: z.string(),
    at: z.string(),
    mirror: z.record(z.string(), z.unknown()),
    bind: Bind.optional(),
    note: z.string().optional(),
  }),
  z.object({ id: z.string(), at: z.string(), cron: z.literal(true), note: z.string().optional() }),
]);
export type Step = z.infer<typeof Step>;

/**
 * シグナルごとの正解ラベル（H6）。thread は "new"（新しいスレッド）か "$<束縛名>"（既存のスレッド）。
 * by を書けば区切りの根拠も確かめる。needsResponse（返事や対応を求めているか）は 0038 でやめた。残っていても読まない
 */
export const Label = z.union([
  z.object({ duplicate: z.literal(true) }),
  z.object({
    thread: z.string(),
    needsResponse: z.boolean().nullable().optional(),
    by: ThreadedBy.optional(),
    title: z.string().optional(),
  }),
]);
export type Label = z.infer<typeof Label>;

const ThreadExpectation = z
  .object({
    /** 担当（0038。summarizeThread の assignee） */
    assignee: z.unknown(),
    /** 名指しが残っているアドレスの値（リスト宛ては含めない） */
    named: z.array(z.string()),
    /** リスト宛ての名指しが残っている読者 */
    listReaders: z.array(z.string()),
    triage: z.boolean(),
    awaiting: z.boolean(),
    dismissed: z.boolean(),
    dataSourceId: z.string(),
    title: z.string(),
    counterpartContactIds: z.array(z.string()),
    lastInboundAt: z.string().nullable(),
    lastOutboundAt: z.string().nullable(),
    activeSinceDismissed: z.boolean(),
    signalCount: z.number(),
    replyExpectedBy: z.string().nullable(),
    overdue: z.boolean(),
    closedAtSource: z.boolean(),
    source: z.unknown(),
    /** 結んだスレッド（"$<束縛名>"）と経路 */
    links: z.record(z.string(), z.enum(['sent', 'anchor', 'manual'])),
  })
  .partial()
  .strict();

const VisibilityCheck = z.union([
  z.object({
    as: z.string(),
    thread: z.string(),
    access: z.enum(['full']).nullable(),
    mustContain: z.array(z.string()).default([]),
    mustNotContain: z.array(z.string()).default([]),
    /** Viewer から見たクエリ層の導出（myTurn・derivedBall・linkedActiveSinceDismissed など）。"$<束縛名>" は置き換える */
    item: z.record(z.string(), z.unknown()).optional(),
    /** 結び候補のスレッド（"$<束縛名>"） */
    candidates: z.array(z.string()).optional(),
  }),
  z.object({ as: z.string(), signals: z.number() }),
  z.object({
    as: z.string(),
    threads: z.object({
      filter: z.enum(['my_turn', 'mine', 'open', 'awaiting', 'overdue', 'triage', 'all']).default('open'),
      dataSource: z.string().optional(),
    }),
    expect: z.array(z.string()),
  }),
  z.object({ ghostContact: z.string() }),
]);
type VisibilityCheck = z.infer<typeof VisibilityCheck>;

export const Expected = z.object({
  ingest: z.record(z.string(), Label),
  checkpoints: z
    .array(
      z.object({
        after: z.string(),
        threads: z.record(z.string(), ThreadExpectation).default({}),
        /** その時点の見え方（visibility と同じ形） */
        views: z.array(VisibilityCheck).default([]),
      }),
    )
    .default([]),
  final: z
    .object({
      threads: z.record(z.string(), ThreadExpectation).default({}),
      threadCount: z.number().optional(),
      eventCounts: z.record(z.string(), z.number()).default({}),
    })
    .default({ threads: {}, eventCounts: {} }),
  visibility: z.array(VisibilityCheck).default([]),
});
export type Expected = z.infer<typeof Expected>;

export interface Scenario {
  name: string;
  dir: string;
  config: z.infer<typeof ScenarioConfig>;
  seed: Seed;
  steps: Step[];
  expected: Expected;
}

export function listScenarios(): string[] {
  return ['repair-estimate', 'development', 'absence', 'complaint'].filter((n) => existsSync(join(FIXTURES_DIR, n)));
}

export function loadScenario(name: string): Scenario {
  const dir = join(FIXTURES_DIR, name);
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const steps = read('signals.jsonl')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l, i) => {
      try {
        return Step.parse(JSON.parse(l));
      } catch (e) {
        throw new Error(`${name}/signals.jsonl line ${i + 1}: ${(e as Error).message}`);
      }
    });
  const seed = Seed.parse(JSON.parse(read('seed.json')));
  const problems = seedProblems(seed);
  if (problems.length) throw new Error(`${name}/seed.json: ${problems.join(' / ')}`);
  return {
    name,
    dir,
    config: ScenarioConfig.parse(JSON.parse(read('scenario.json'))),
    seed,
    steps,
    expected: Expected.parse(JSON.parse(read('expected.json'))),
  };
}

// ---- 実行 ----

export type DeciderMode = { kind: 'hint' } | { kind: 'ai'; mode: 'replay' | 'record' | 'rerecord'; live?: LlmClient; model: string };

export interface StepRecord {
  step: Step;
  ingest?: IngestResult;
  mirror?: MirrorResult;
  response?: { status: number; body: unknown };
  cron?: { ingested: (IngestResult | MirrorResult)[]; overdue: number };
  /** AI 判断の confidence（AI を呼んだときだけ） */
  confidence?: number;
}

export interface Run {
  scenario: Scenario;
  service: MurmurService;
  repo: Repo;
  bindings: Record<string, string>;
  records: StepRecord[];
  checkpointErrors: string[];
  backend: MemoryDummyBackend;
}

/** AI の代わりに正解ラベルで答える（AI なしでシナリオを回すため） */
class HintDecider implements Decider {
  current: { stepId: string; label?: Label } = { stepId: '' };
  constructor(private readonly resolve: (s: string) => string) {}
  async decide(req: IngestRequest): Promise<{ raw: AiIngestDecision; by: 'human' }> {
    const label = this.current.label;
    if (!label || 'duplicate' in label) throw new Error(`step ${this.current.stepId}: AI 判断が必要だが expected.json に正解ラベルがない`);
    const base = { reason: `fixture hint (${this.current.stepId})`, confidence: 1, needs_response: null };
    if (req.mode === 'fixed') return { raw: { ...base, thread: null, thread_id: null, title: null }, by: 'human' };
    if (req.mode === 'new' || label.thread === 'new') {
      return { raw: { ...base, thread: 'new', thread_id: null, title: label.title ?? null }, by: 'human' };
    }
    return { raw: { ...base, thread: 'existing', thread_id: this.resolve(label.thread), title: null }, by: 'human' };
  }
}

/** AI 判断の confidence を拾うための包み */
class ObservedDecider implements Decider {
  last: number | undefined;
  constructor(private readonly inner: Decider) {}
  async decide(req: IngestRequest) {
    const r = await this.inner.decide(req);
    this.last = r.raw.confidence;
    return r;
  }
}

export async function runScenario(scenario: Scenario, opts: { repo?: Repo; decider?: DeciderMode } = {}): Promise<Run> {
  const repo = opts.repo ?? memoryRepo();
  await repo.master.replaceSeed(scenario.seed);
  const clock = new ManualClock(scenario.steps[0]?.at);
  const backend = new MemoryDummyBackend();
  const connectors: Connectors = Object.fromEntries(
    (['email', 'slack', 'line', 'jira', 'bitbucket'] as const).map((ch) => [ch, new DummyConnector(ch, backend)]),
  );
  const bindings: Record<string, string> = {};

  const resolve = (v: string): string => {
    if (v.startsWith('$')) {
      const b = bindings[v.slice(1)];
      if (b === undefined) throw new Error(`unbound ${v}`);
      return b;
    }
    return v;
  };
  const subst = (v: unknown): unknown =>
    typeof v === 'string' ? resolve(v) : Array.isArray(v) ? v.map(subst) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)])) : v;

  const hint = new HintDecider(resolve);
  const decider: Decider =
    opts.decider?.kind === 'ai'
      ? new AiDecider(
          new RecordReplayLlm(opts.decider.mode, new FsRecordingStore(join(scenario.dir, 'recordings')), opts.decider.live),
          opts.decider.model,
        )
      : hint;
  const observed = new ObservedDecider(decider);

  const service = new MurmurService({ repo, clock, newId: counterIds(), decider: observed, connectors, policy: DEFAULT_POLICY });
  // スタンドと同じ HTTP API を通す（ユーザー識別はテスト用にそのまま User ID）
  const http = createApp({
    service: () => service,
    authenticate: async (token) => token,
    webhookVerify: async () => false,
  });

  const records: StepRecord[] = [];
  const checkpointErrors: string[] = [];
  for (const step of scenario.steps) {
    clock.set(step.at);
    const rec: StepRecord = { step };
    if ('signal' in step) {
      hint.current = { stepId: step.id, label: scenario.expected.ingest[step.id] };
      observed.last = undefined;
      const inbound = InboundSignalBody.parse(subst(step.signal));
      rec.ingest = await service.ingest(inbound);
      rec.confidence = observed.last;
      for (const [alias, path] of Object.entries(step.bind ?? {})) {
        const v = (rec.ingest as Record<string, unknown>)[path];
        if (typeof v !== 'string') throw new Error(`step ${step.id}: ${path} を ${alias} に束縛できない（結果: ${JSON.stringify(rec.ingest)}）`);
        bindings[alias] = v;
      }
    } else if ('action' in step) {
      const input = subst(step.action.input) as Record<string, unknown>;
      rec.response = await callTool(http, step.action.tool, step.action.as, input);
      if (rec.response.status >= 400) {
        throw new Error(`step ${step.id} ${step.action.tool} failed: ${rec.response.status} ${JSON.stringify(rec.response.body)}`);
      }
      if (step.action.tool === 'record_sent' && step.echo) {
        const ds = scenario.seed.dataSources.find((d) => d.id === input.data_source);
        const self = ds?.kind === 'service' ? echoFrom(scenario, ds, step.action.as) : undefined;
        if (!ds || ds.kind !== 'service' || !self) throw new Error(`step ${step.id}: echo の data_source が不正`);
        const sentRef = String(input.sent_ref);
        const body = rec.response.body as { timeline: { signal?: { anchors: Record<string, unknown>; to: { value: string }[]; signalId: string } }[] };
        const sent = body.timeline.find((e) => e.signal?.anchors.messageId === sentRef)?.signal;
        await backend.enqueue({
          dataSourceId: ds.id,
          channel: ds.channel,
          from: { channel: ds.channel, value: self.value },
          to: (sent?.to ?? []).map((t) => ({ channel: ds.channel, value: t.value })),
          subject: input.subject as string | undefined,
          body: String(input.body),
          anchors: { ...(sent?.anchors ?? {}), messageId: sentRef },
          sourceRef: `${ds.channel}:${sentRef}`,
        });
      }
      for (const [alias, path] of Object.entries(step.bind ?? {})) {
        const v = getPath(rec.response.body, path);
        if (typeof v !== 'string') throw new Error(`step ${step.id}: ${path} が文字列でない`);
        bindings[alias] = v;
      }
    } else if ('mirror' in step) {
      rec.mirror = await service.mirror(InboundMirrorBody.parse({ kind: 'mirror', ...(subst(step.mirror) as object) }));
      for (const [alias, path] of Object.entries(step.bind ?? {})) {
        const v = (rec.mirror as Record<string, unknown>)[path];
        if (typeof v !== 'string') throw new Error(`step ${step.id}: ${path} を ${alias} に束縛できない（結果: ${JSON.stringify(rec.mirror)}）`);
        bindings[alias] = v;
      }
    } else {
      hint.current = { stepId: step.id };
      rec.cron = { ingested: await service.pollConnectors(), overdue: await service.checkOverdue() };
    }
    records.push(rec);

    for (const cp of scenario.expected.checkpoints.filter((c) => c.after === step.id)) {
      const p = await service.state();
      checkpointErrors.push(...compareThreads(new Directory(scenario.seed), p, cp.threads, resolve, `checkpoint after ${step.id}`));
      checkpointErrors.push(...checkViews(new Directory(scenario.seed), p, cp.views, resolve, `checkpoint after ${step.id}`));
    }
  }
  return { scenario, service, repo, bindings, records, checkpointErrors, backend };
}

async function callTool(http: ReturnType<typeof createApp>, tool: Tool, as: string, input: Record<string, unknown>) {
  const enc = encodeURIComponent;
  const route: Record<Tool, () => [string, string, unknown?]> = {
    me: () => ['GET', '/api/me'],
    list_threads: () => ['GET', `/api/threads?${new URLSearchParams(input as Record<string, string>)}`],
    get_thread: () => ['GET', `/api/threads/${enc(String(input.thread_id))}`],
    dismiss_thread: () => ['POST', `/api/threads/${enc(String(input.thread_id))}/dismiss`, { reason: input.reason }],
    reopen_thread: () => ['POST', `/api/threads/${enc(String(input.thread_id))}/reopen`, { reason: input.reason }],
    move_signal: () => [
      'POST',
      `/api/signals/${enc(String(input.signal_id))}/move`,
      { thread_id: input.thread_id, new_thread_title: input.new_thread_title, reason: input.reason },
    ],
    get_list: () => ['GET', `/api/lists/${enc(String(input.list_id))}`],
    add_note: () => ['POST', '/api/notes', { thread_id: input.thread_id, body: input.body, author: input.author }],
    claim_thread: () => ['POST', `/api/threads/${enc(String(input.thread_id))}/claim`, { user_id: input.user_id, reason: input.reason }],
    link_threads: () => ['POST', `/api/threads/${enc(String(input.thread_id))}/links`, { thread_id: input.other_thread_id, reason: input.reason }],
    unlink_threads: () => ['POST', `/api/threads/${enc(String(input.thread_id))}/unlink`, { thread_id: input.other_thread_id, reason: input.reason }],
    record_sent: () => ['POST', '/api/sent', input],
    acknowledge: () => [
      'POST',
      `/api/threads/${enc(String(input.thread_id))}/acknowledge`,
      { until_signal_id: input.until_signal_id, addresses: input.addresses, reason: input.reason },
    ],
  };
  const [method, path, body] = route[tool]();
  const res = await http.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function compareThreads(
  dir: Directory,
  p: Projections,
  threads: Expected['final']['threads'],
  resolve: (s: string) => string,
  where: string,
): string[] {
  const errors: string[] = [];
  for (const [alias, exp] of Object.entries(threads)) {
    const id = resolve(alias);
    const t = p.threads[id];
    if (!t) {
      errors.push(`${where}: thread ${alias} (${id}) がない`);
      continue;
    }
    const summary = summarizeThread(dir, p, t);
    const actual = summary as unknown as Record<string, unknown>;
    actual.named = summary.attention.named.map((n) => n.address.value).sort();
    actual.listReaders = summary.attention.list?.userIds ?? [];
    actual.links = Object.fromEntries(t.links.map((l) => [l.threadId, l.route]));
    for (const [k, raw] of Object.entries(exp)) {
      const v = k === 'links' ? Object.fromEntries(Object.entries(raw as Record<string, string>).map(([a, r]) => [resolve(a), r])) : raw;
      if (canonicalJson(actual[k]) !== canonicalJson(v)) errors.push(`${where}: ${alias}.${k} = ${canonicalJson(actual[k])}（期待 ${canonicalJson(v)}）`);
    }
  }
  return errors;
}

/** "$<束縛名>" の文字列を深く置き換える */
function substDeep(v: unknown, resolve: (s: string) => string): unknown {
  if (typeof v === 'string') return v.startsWith('$') ? resolve(v) : v;
  if (Array.isArray(v)) return v.map((x) => substDeep(x, resolve));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substDeep(x, resolve)]));
  return v;
}

/** Viewer ごとの見え方（H3・H8）。最終の visibility とチェックポイントの views で使う */
function checkViews(dir: Directory, p: Projections, checks: readonly VisibilityCheck[], resolve: (s: string) => string, where: string): string[] {
  const errors: string[] = [];
  for (const check of checks) {
    if ('ghostContact' in check) {
      const contact = dir.contact(check.ghostContact);
      if (!contact) errors.push(`${where}: contact ${check.ghostContact} がない`);
      else if (contact.userId) errors.push(`${where}: ${check.ghostContact} はゴーストではない`);
      continue;
    }
    const viewer = deriveViewer(dir, check.as);
    if ('signals' in check) {
      const n = visibleSignals(viewer, p).length;
      if (n !== check.signals) errors.push(`${where}: ${check.as} の見えるシグナル ${n} 件（期待 ${check.signals}）`);
      continue;
    }
    if ('threads' in check) {
      const got = listThreads(dir, viewer, p, { filter: check.threads.filter, dataSourceId: check.threads.dataSource }).map((t) => t.id).sort();
      const want = check.expect.map(resolve).sort();
      if (canonicalJson(got) !== canonicalJson(want)) {
        errors.push(`${where}: ${check.as} の ${check.threads.filter} は ${canonicalJson(got)}（期待 ${canonicalJson(want)}）`);
      }
      continue;
    }
    const view = getThreadView(dir, viewer, p, resolve(check.thread));
    const access = view ? 'full' : null;
    const label = `${where}: ${check.as} → ${check.thread}`;
    if (access !== check.access) errors.push(`${label} は ${access}（期待 ${check.access}）`);
    const json = JSON.stringify(view ?? null);
    for (const s of check.mustContain.map((x) => substDeep(x, resolve) as string)) if (!json.includes(s)) errors.push(`${label} に「${s}」が見えない`);
    for (const s of check.mustNotContain.map((x) => substDeep(x, resolve) as string)) if (json.includes(s)) errors.push(`${label} に「${s}」が見えてしまう`);
    if (view && check.item) {
      const actual = view.thread as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(substDeep(check.item, resolve) as Record<string, unknown>)) {
        if (canonicalJson(actual[k]) !== canonicalJson(v)) errors.push(`${label} の ${k} = ${canonicalJson(actual[k])}（期待 ${canonicalJson(v)}）`);
      }
    }
    if (view && check.candidates) {
      const got = view.thread.linkCandidates.map((c) => c.threadId).sort();
      const want = check.candidates.map(resolve).sort();
      if (canonicalJson(got) !== canonicalJson(want)) errors.push(`${label} の結び候補は ${canonicalJson(got)}（期待 ${canonicalJson(want)}）`);
    }
  }
  return errors;
}

// ---- 検証 ----

export interface Bucket {
  total: number;
  correct: number;
}

export interface IngestMetrics extends Bucket {
  /** 区切りが構造（anchor / awaiting / no_match）で決まったもの */
  structural: Bucket;
  /** 区切りを AI（再生）か正解ラベル（ヒント実行）が選んだもの */
  ai: Bucket;
  mismatches: string[];
  confidences: number[];
}

export function emptyMetrics(): IngestMetrics {
  const b = () => ({ total: 0, correct: 0 });
  return { ...b(), structural: b(), ai: b(), mismatches: [], confidences: [] };
}

export function addMetrics(into: IngestMetrics, m: IngestMetrics): void {
  for (const k of ['structural', 'ai'] as const) {
    into[k].total += m[k].total;
    into[k].correct += m[k].correct;
  }
  into.total += m.total;
  into.correct += m.correct;
  into.mismatches.push(...m.mismatches);
  into.confidences.push(...m.confidences);
}

/** H6: 区切りの、正解ラベルとの一致率（「返事や対応を求めているか」は 0038 でやめた） */
export function ingestMetrics(run: Run): IngestMetrics {
  const m = emptyMetrics();
  const resolve = (s: string) => (s.startsWith('$') ? (run.bindings[s.slice(1)] ?? s) : s);
  for (const rec of run.records) {
    const r = rec.ingest;
    const label = run.scenario.expected.ingest[rec.step.id];
    if (!r || !label) continue;
    m.total++;
    if ('duplicate' in label) {
      if (r.status === 'duplicate') m.correct++;
      else m.mismatches.push(`${rec.step.id}: 期待 duplicate、実際 ${canonicalJson(r)}`);
      continue;
    }
    if (r.status !== 'threaded') {
      m.mismatches.push(`${rec.step.id}: 期待 ${canonicalJson(label)}、実際 ${canonicalJson(r)}`);
      continue;
    }
    const threadOk = label.thread === 'new' ? r.newThread : !r.newThread && r.threadId === resolve(label.thread);
    const byOk = label.by === undefined || label.by === r.by;
    const ok = threadOk && byOk;
    if (ok) m.correct++;
    else m.mismatches.push(`${rec.step.id}: 期待 ${canonicalJson(label)}、実際 ${canonicalJson(r)}`);
    const bucket = r.by === 'anchor' || r.by === 'awaiting' || r.by === 'no_match' ? m.structural : m.ai;
    bucket.total++;
    if (threadOk && byOk) bucket.correct++;
    if (rec.confidence !== undefined) m.confidences.push(rec.confidence);
  }
  return m;
}

export interface Verification {
  errors: string[];
  metrics: IngestMetrics;
  replayHashMatches: boolean;
  threadHash: string;
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** H1: 投影を全削除してイベントからリプレイし、スレッドの投影のハッシュが元と一致するか */
export async function replayCheck(service: MurmurService): Promise<{ before: string; after: string; fullMatch: boolean }> {
  const original = await service.state();
  const before = await sha256(canonicalJson(original.threads));
  const rebuilt = await service.rebuild();
  const after = await sha256(canonicalJson(rebuilt.threads));
  return { before, after, fullMatch: canonicalJson(original) === canonicalJson(rebuilt) };
}

export async function verifyScenario(run: Run): Promise<Verification> {
  const { scenario, service } = run;
  const errors = [...run.checkpointErrors];
  const resolve = (s: string) => {
    if (!s.startsWith('$')) return s;
    const v = run.bindings[s.slice(1)];
    if (!v) throw new Error(`unbound ${s}`);
    return v;
  };
  const p = await service.state();
  const f = scenario.expected.final;
  errors.push(...compareThreads(new Directory(scenario.seed), p, f.threads, resolve, 'final'));
  if (f.threadCount !== undefined && Object.keys(p.threads).length !== f.threadCount) {
    errors.push(`final: スレッド数 ${Object.keys(p.threads).length}（期待 ${f.threadCount}）`);
  }
  const events = await run.repo.events.read();
  for (const [type, n] of Object.entries(f.eventCounts)) {
    const actual = events.filter((e) => e.type === type).length;
    if (actual !== n) errors.push(`final: ${type} が ${actual} 件（期待 ${n}）`);
  }
  // どのシグナルもどこかのスレッドに入っている（取りこぼしがない）
  for (const s of Object.values(p.signals)) if (!s.threadId) errors.push(`signal ${s.signalId} がどのスレッドにもない`);

  // H3・H8 可視性と「自分の番」・結び候補
  errors.push(...checkViews(new Directory(scenario.seed), p, scenario.expected.visibility, resolve, 'visibility'));

  const metrics = ingestMetrics(run);
  errors.push(...metrics.mismatches.map((m) => `ingest: ${m}`));

  const replay = await replayCheck(service);
  const replayOk = replay.before === replay.after && replay.fullMatch;
  if (!replayOk) errors.push(`H1: リプレイ後の投影が一致しない (${replay.before} != ${replay.after})`);

  return { errors, metrics, replayHashMatches: replayOk, threadHash: replay.before };
}

/** echo（観測された送信）の送り主。record_sent と同じく、データソースの窓口、なければ送った人の Contact のアドレス */
export function echoFrom(scenario: Scenario, ds: Extract<Seed['dataSources'][number], { kind: 'service' }>, userId: string): { value: string } | undefined {
  if (ds.selfAddresses[0]) return ds.selfAddresses[0];
  const contact = scenario.seed.contacts.find((c) => c.userId === userId);
  return scenario.seed.addresses.find((a) => a.contactId === contact?.id && a.channel === ds.channel);
}
