import { z } from 'zod';
import type { CoreContext } from './context';
import { sameValue, type Directory } from './directory';
import type { Channel, ServiceDataSource } from './entities';
import { DomainError } from './errors';
import { draft, type AddressRef, type Anchors, type DraftEvent, type FileRef, type PayloadOf, type ThreadChoice, type ThreadedBy } from './events';
import { indexKey, type Projections, type SignalRecord, type Thread } from './projections';
import { addressKey, comparePos, sameAddress } from './comm';
import { commView, directionOf, isOurs } from './sides';
import { awaitingNamesOf } from './turn';

// Ingest の判断部分（純関数）。AI の呼び出しそのものはシェル（src/ingest/）が行う。
// 判断はスレッドの区切りと「返事や対応を求めているか」だけ（計画 v2 の Ingest）。業務の知識は使わない。
//
//   prepareInbound → planIngest
//     → 構造で決まり、AI の判断が要らなければ（観測された送信）イベントまで作る
//     → そうでなければ IngestRequest をシェルの Decider へ → finalizeIngest

/** コネクタが正規化した 1 件のメッセージ。どのデータソースとして取得したかを必ず持つ */
export interface InboundSignal {
  dataSourceId: string;
  channel: Channel;
  from: AddressRef;
  to: AddressRef[];
  subject?: string;
  body: string;
  anchors?: Anchors;
  attachments?: FileRef[];
  sourceRef: string;
  /** 観測時刻（コネクタが知っていれば）。シェルの時計より優先しない。参考値 */
  occurredAt?: string;
}

export type SignalPayload = PayloadOf<'SignalObserved'>;

export type Prepared =
  | { kind: 'duplicate'; signalId: string }
  | { kind: 'merged'; signalId: string; threadId: string | null }
  /** ours: 取り込む時点のマスタで、こちらからのシグナルか（判断にだけ使い、イベントには残さない。0030） */
  | { kind: 'signal'; payload: SignalPayload; dataSource: ServiceDataSource; ours: boolean };

/**
 * 重複排除と向きの判定。
 * - source_ref がそのデータソースで既出なら弾く
 * - from がこちら（窓口のアドレスか読者の Contact のアドレス）なら観測された送信。判断にだけ使う
 * - messageId が記録した送信の sent_ref と一致すれば統合する（記録が先に届いた順。H5）。
 *   シグナルは 1 本のままで、イベントは出さない
 */
export function prepareInbound(p: Projections, ctx: CoreContext, inbound: InboundSignal): Prepared {
  const ds = ctx.dir.dataSource(inbound.dataSourceId);
  if (!ds || ds.kind !== 'service') {
    throw new DomainError('invalid', `data source ${inbound.dataSourceId} is not a service data source`);
  }
  if (ds.channel !== inbound.channel) throw new DomainError('invalid', `data source ${ds.id} is ${ds.channel}, not ${inbound.channel}`);

  const existing = p.index.sourceRefs[indexKey(ds.id, inbound.sourceRef)];
  if (existing) return { kind: 'duplicate', signalId: existing };
  const ours = isOurs(ctx.dir, ds, inbound.from, ctx.now);
  const mid = inbound.anchors?.messageId;
  const recorded = mid ? p.signals[p.index.messageIds[indexKey(ds.id, mid)] ?? ''] : undefined;
  if (recorded?.recorded) return { kind: 'merged', signalId: recorded.signalId, threadId: recorded.threadId };

  const payload: SignalPayload = {
    signalId: ctx.newId('sig'),
    dataSourceId: ds.id,
    channel: inbound.channel,
    from: inbound.from,
    to: inbound.to,
    subject: inbound.subject,
    body: inbound.body,
    anchors: inbound.anchors ?? {},
    attachments: inbound.attachments ?? [],
    sourceRef: inbound.sourceRef,
  };
  return { kind: 'signal', payload, dataSource: ds, ours };
}

export function signalEvent(payload: SignalPayload): DraftEvent {
  return draft('SignalObserved', payload);
}

/**
 * 「返事や対応を求めているか」は Claude の答えをそのまま使う（confidence は監査用に残すだけ）。
 * 閾値で「求めている」に倒すと挙動が読めなくなるので入れない（2026-10-21 直樹）
 */
export interface IngestPolicy {
  /** 区切りの AI 判断に渡す「直近のスレッド」の本数 */
  recentThreadLimit: number;
  /** AI に渡す候補を探す窓（日）。最後のシグナルがこれより古いスレッドは候補に出ない（0046 の決定 4） */
  candidateWindowDays: number;
  /** 窓の中でも、新しい順にこの本数までしか読まない（0046 の決定 4） */
  candidateWindowLimit: number;
}

export const DEFAULT_POLICY: IngestPolicy = { recentThreadLimit: 5, candidateWindowDays: 30, candidateWindowLimit: 200 };

// ---- 区切り（上から順に） ----

export type Threading =
  | { kind: 'existing'; threadId: string; by: 'anchor' | 'awaiting'; reason: string }
  | { kind: 'new'; by: 'anchor' | 'no_match'; reason: string }
  | { kind: 'choose'; candidates: Candidate[] };

/**
 * ソースの区切り（課題キーなど）のスレッド。同じデータソースで、その threadKey を持つシグナルのスレッド。
 * なければ、sent_ref がそのキーの記録した送信（起票）のスレッド
 */
export function threadOfSourceKey(p: Projections, dataSourceId: string, key: string, exceptSignalId?: string): string | null {
  const keyed = Object.values(p.signals)
    .filter((s) => s.dataSourceId === dataSourceId && s.threadId !== null && s.signalId !== exceptSignalId && s.anchors.threadKey === key)
    .sort((x, y) => y.seq - x.seq)[0];
  if (keyed) return keyed.threadId;
  const sid = p.index.messageIds[indexKey(dataSourceId, key)];
  const s = sid && sid !== exceptSignalId ? p.signals[sid] : undefined;
  if (s?.threadId) return s.threadId;
  // 写しでできたスレッド（まだシグナルがない。0031 の 8）
  return Object.values(p.threads).find((t) => t.dataSourceId === dataSourceId && t.sourceKey === key)?.id ?? null;
}

/** 1. アンカー。同じデータソースの中だけを見る。ソースの区切り（threadKey）は一致しなくても「新しい」に決まる */
export function resolveAnchors(p: Projections, sig: SignalPayload): Threading | null {
  const a = sig.anchors;
  const threaded = Object.values(p.signals).filter(
    (s) => s.dataSourceId === sig.dataSourceId && s.threadId !== null && s.signalId !== sig.signalId,
  );
  const latest = (xs: SignalRecord[]) => [...xs].sort((x, y) => y.seq - x.seq)[0];
  const byMessageId = (id: string) => {
    const sid = p.index.messageIds[indexKey(sig.dataSourceId, id)];
    const s = sid ? p.signals[sid] : undefined;
    return s?.threadId ? s : undefined;
  };

  if (a.threadKey) {
    const threadId = threadOfSourceKey(p, sig.dataSourceId, a.threadKey, sig.signalId);
    return threadId
      ? { kind: 'existing', threadId, by: 'anchor', reason: `ソースの区切り ${a.threadKey}` }
      : { kind: 'new', by: 'anchor', reason: `ソースの区切り ${a.threadKey} の最初のシグナル` };
  }
  if (a.inReplyTo) {
    const s = byMessageId(a.inReplyTo);
    if (s) return { kind: 'existing', threadId: s.threadId!, by: 'anchor', reason: `In-Reply-To ${a.inReplyTo}` };
  }
  if (a.quotedMessageId) {
    const s = byMessageId(a.quotedMessageId);
    if (s) return { kind: 'existing', threadId: s.threadId!, by: 'anchor', reason: `引用 ${a.quotedMessageId}` };
  }
  if (a.threadTs) {
    const s = latest(threaded.filter((x) => x.anchors.messageId === a.threadTs || x.anchors.threadTs === a.threadTs));
    if (s) return { kind: 'existing', threadId: s.threadId!, by: 'anchor', reason: `同じスレッド thread_ts=${a.threadTs}` };
  }
  return null;
}

/**
 * シグナルの会話がグループか。会話の種類を持つシグナル（Teams のチャット。0044）はそれで、ほかはデータソースの group で決める
 * （1 つのデータソースに 1 対 1 とグループの会話が混ざるリストがあるため）
 */
export function isGroup(ds: ServiceDataSource, sig: Pick<SignalPayload, 'anchors'>): boolean {
  return sig.anchors.conversationGroup ?? ds.group;
}

/** スレッドのシグナルのうち、相手として sig と同じ人とやりとりしたものがあるか（グループのチャネルはチャネル全体） */
function withSameCounterpart(dir: Directory, p: Projections, ds: ServiceDataSource, t: Thread, sig: SignalPayload, ours: boolean): boolean {
  if (isGroup(ds, sig)) return true;
  const theirs = ours ? sig.to : [sig.from];
  const has = (refs: AddressRef[], r: AddressRef) => refs.some((x) => x.channel === r.channel && sameValue(x.value, r.value));
  return t.signalIds.some((id) => {
    const s = p.signals[id]!;
    return theirs.some((r) => (directionOf(dir, s) === 'inbound' ? has([s.from], r) : has(s.to, r)));
  });
}

/**
 * 2. 同じ相手で、こちらが返事を待っているスレッドが 1 本だけなら、そのスレッド（受信だけ）。
 * 返事を待っている = こちらから送ったシグナルで名指しした読者でない相手の名指しが残っていて、その相手がまだそのスレッドで発言していない（0038）。
 * 発言したかは区切りの判断にだけ使う（名指しは発言では外れない）。グループのチャネルはどの相手でも、ほかはその送り主への名指し
 */
export function awaitingThread(dir: Directory, p: Projections, ds: ServiceDataSource, sig: SignalPayload, ours: boolean): Thread | null {
  if (ours) return null;
  const waiting = threadsOf(p, ds.id, sig).filter((t) => {
    if (t.closedAtSource) return false;
    // こちらから送ったシグナルで待っている相手のうち、名指しのあとにまだ発言していない人
    const unanswered = awaitingNamesOf(dir, t).filter(
      (n) => !t.log.some((e) => e.kind === 'signal' && e.from !== undefined && sameAddress(e.from, n.address) && comparePos(e, n.last) > 0),
    );
    if (isGroup(ds, sig)) return unanswered.length > 0;
    return unanswered.some((n) => addressKey(n.address) === addressKey(sig.from));
  });
  return waiting.length === 1 ? waiting[0]! : null;
}

/** 3. の候補: 相手（グループならチャネル）の直近のスレッド。片付けたものは入れない */
export function recentThreads(dir: Directory, p: Projections, ds: ServiceDataSource, sig: SignalPayload, ours: boolean, limit: number): Thread[] {
  return threadsOf(p, ds.id, sig)
    .filter((t) => withSameCounterpart(dir, p, ds, t, sig, ours))
    .sort((a, b) => {
      const x = lastActivity(dir, p, a);
      const y = lastActivity(dir, p, b);
      return x < y ? 1 : x > y ? -1 : a.id < b.id ? -1 : 1;
    })
    .slice(0, limit);
}

/**
 * 区切りの 2 段め・3 段めの候補になるスレッド。片付けたもの・シグナルのないものは入れない。
 * シグナルに会話（Anchors.conversationId。0044）があれば、同じ会話のシグナルを持つスレッドだけ
 */
function threadsOf(p: Projections, dataSourceId: string, sig: SignalPayload): Thread[] {
  const conversation = sig.anchors.conversationId;
  return Object.values(p.threads).filter(
    (t) =>
      t.dataSourceId === dataSourceId &&
      !t.dismissed &&
      t.signalIds.length > 0 &&
      (conversation === undefined || t.signalIds.some((id) => p.signals[id]?.anchors.conversationId === conversation)),
  );
}

function lastActivity(dir: Directory, p: Projections, t: Thread): string {
  const v = commView(dir, t);
  const a = v.lastInboundAt ?? '';
  const b = v.lastOutboundAt ?? '';
  return a > b ? a : b;
}

export function planThreading(
  dir: Directory,
  p: Projections,
  ds: ServiceDataSource,
  sig: SignalPayload,
  ours: boolean,
  policy: IngestPolicy,
): Threading {
  const anchored = resolveAnchors(p, sig);
  if (anchored) return anchored;
  const waiting = awaitingThread(dir, p, ds, sig, ours);
  if (waiting) {
    return { kind: 'existing', threadId: waiting.id, by: 'awaiting', reason: 'こちらが返事を待っているスレッドが 1 本だけ' };
  }
  const recent = recentThreads(dir, p, ds, sig, ours, policy.recentThreadLimit);
  if (recent.length === 0) return { kind: 'new', by: 'no_match', reason: 'アンカーも返事待ちも直近のスレッドもない' };
  return { kind: 'choose', candidates: recent.map((t) => toCandidate(dir, p, t)) };
}

// ---- AI 判断の入出力 ----

export interface Candidate {
  threadId: string;
  title: string;
  recent: { at: string; direction: 'inbound' | 'outbound'; from: string; excerpt: string }[];
}

function toCandidate(dir: Directory, p: Projections, t: Thread): Candidate {
  const recent = t.signalIds
    .slice(-3)
    .map((id) => p.signals[id]!)
    .map((s) => ({ at: s.at, direction: directionOf(dir, s), from: s.from.value, excerpt: s.body.slice(0, 160) }));
  return { threadId: t.id, title: t.title, recent };
}

/**
 * - choose: 候補のどれかの続きか、新しいスレッドかを選ぶ
 * - new: 新しいスレッドに決まっている。件名を書く
 * - fixed: 既存のスレッドに決まっている。0038 から AI を呼ばない（型とプロンプトは記録を取り直すまで残す）
 * プロンプトと構造化出力の needs_response は、記録（H6 の再生）を取り直すまで残す。答えは使わない（0038 の未決 2）
 */
export type IngestMode = 'choose' | 'new' | 'fixed';

export interface IngestRequest {
  mode: IngestMode;
  signal: SignalPayload;
  /** 取り込む時点のマスタで、こちらからのシグナルか */
  ours: boolean;
  dataSource: { id: string; name: string; description: string; channel: Channel; group: boolean };
  threading: Threading;
  /** fixed のときの決まったスレッド */
  thread?: Candidate;
  candidates: Candidate[];
}

export type IngestPlan =
  | { kind: 'decided'; events: DraftEvent[]; outcome: IngestOutcome }
  | { kind: 'needs_decision'; request: IngestRequest };

export interface IngestOutcome {
  threadId: string;
  newThread: boolean;
  by: ThreadedBy;
}

/**
 * 区切りを決め、AI の判断が要らなければイベントまで作る（0038）。AI を呼ぶのは、受信で、区切りを選ぶとき（choose）と、
 * 新しいスレッドの件名を書くとき（new）だけ。アンカーでスレッドが決まる連絡（fixed）とこちらからのシグナルは AI を呼ばない。
 * 「返事や対応を求めているか」は判断しない（名指しは宛先で決まる）
 */
export function planIngest(
  p: Projections,
  ctx: CoreContext,
  ds: ServiceDataSource,
  sig: SignalPayload,
  policy: IngestPolicy,
): IngestPlan {
  const ours = isOurs(ctx.dir, ds, sig.from, ctx.now);
  const threading = planThreading(ctx.dir, p, ds, sig, ours, policy);
  if (threading.kind === 'existing' || (ours && threading.kind === 'new')) {
    const choice: ThreadChoice =
      threading.kind === 'existing'
        ? { kind: 'existing', threadId: threading.threadId }
        : { kind: 'new', threadId: ctx.newId('thr'), title: defaultTitle(sig) };
    return {
      kind: 'decided',
      events: [
        draft('SignalThreaded', {
          signalId: sig.signalId,
          thread: choice,
          by: threading.by,
          confidence: 1,
          reason: threading.reason,
        }),
      ],
      outcome: { threadId: choice.threadId, newThread: choice.kind === 'new', by: threading.by },
    };
  }
  const mode: IngestMode = threading.kind === 'choose' ? 'choose' : 'new';
  return {
    kind: 'needs_decision',
    request: {
      mode,
      signal: sig,
      ours,
      dataSource: { id: ds.id, name: ds.name, description: ds.description, channel: ds.channel, group: isGroup(ds, sig) },
      threading,
      candidates: threading.kind === 'choose' ? threading.candidates : [],
    },
  };
}

export function defaultTitle(sig: Pick<SignalPayload, 'subject' | 'body'>): string {
  return sig.subject?.trim() || sig.body.slice(0, 40);
}

/** Claude の構造化出力のスキーマ */
export const AiIngestDecision = z.object({
  thread: z.enum(['existing', 'new']).nullable(),
  thread_id: z.string().nullable(),
  title: z.string().nullable(),
  needs_response: z.boolean().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type AiIngestDecision = z.infer<typeof AiIngestDecision>;

/**
 * Decider の出力を検証して SignalThreaded にする。
 * - 候補にないスレッドを選んだら新しいスレッドに倒す
 * - 「求めているか」（needs_response）の答えは使わない（0038）
 */
export function finalizeIngest(
  ctx: CoreContext,
  request: IngestRequest,
  raw: AiIngestDecision,
  decidedBy: 'ai' | 'human',
): { events: DraftEvent[]; outcome: IngestOutcome } {
  const sig = request.signal;
  const th = request.threading;
  const notes: string[] = [];
  const title = raw.title?.trim() || defaultTitle(sig);

  let choice: ThreadChoice;
  let by: ThreadedBy;
  if (th.kind === 'existing') {
    choice = { kind: 'existing', threadId: th.threadId };
    by = th.by;
    notes.push(th.reason);
  } else if (th.kind === 'new') {
    choice = { kind: 'new', threadId: ctx.newId('thr'), title };
    by = th.by;
    notes.push(th.reason);
  } else {
    by = decidedBy;
    const picked = raw.thread === 'existing' ? th.candidates.find((c) => c.threadId === raw.thread_id) : undefined;
    if (picked) choice = { kind: 'existing', threadId: picked.threadId };
    else {
      choice = { kind: 'new', threadId: ctx.newId('thr'), title };
      if (raw.thread === 'existing') notes.push(`[続き先 ${raw.thread_id ?? '(なし)'} が候補外のため新しいスレッド]`);
    }
  }

  const reason = [...notes, raw.reason.trim()].filter((x) => x).join(' ') || '(理由なし)';
  return {
    events: [
      draft('SignalThreaded', {
        signalId: sig.signalId,
        thread: choice,
        by,
        confidence: raw.confidence,
        reason,
      }),
    ],
    outcome: { threadId: choice.threadId, newThread: choice.kind === 'new', by },
  };
}

// ---- プロンプト（固定。業務の知識を持たない、0008） ----

export const INGEST_SYSTEM_PROMPT = `あなたは連絡の索引の Ingest 判断係です。
データソース（メールボックス・チャット・LINE など）で観測された 1 件のメッセージ（シグナル）について、次の 2 つだけを判断します。
何をすべきか、誰が担当するかは判断しません。

1. スレッドの区切り（mode が choose のときだけ）
   候補のスレッドのどれかと同じ話題の続きなら thread を "existing" にして、その thread_id を選ぶ。
   別の話題なら thread を "new" にして、短い件名を title に書く。
   区切りの基準は時間ではなく話題。同じ相手でも話題が違えば new にする。
2. 返事や対応を求めているか（needs_response。signal.direction が received のときだけ）
   こちらに返事・回答・対応・確認を求めているなら true。直前の依頼の補足（資料の追加など）は依頼の一部として true。
   お礼だけ、スタンプだけ、了解・承知・承諾の返事、自動の通知、広告・お知らせ、挨拶だけなら false。
   signal.direction が sent_by_us（こちらが送ったもの）なら null にする。

mode が new のとき: スレッドは新しく作られる。thread を "new"、thread_id を null にし、title に短い件名を書き、needs_response を判断する。
mode が fixed のとき: スレッドは決まっている。thread・thread_id・title を null にし、needs_response だけを判断する。

confidence は判断の確からしさ（0〜1）。reason は後で人が監査できるよう具体的に日本語で書く。`;

export function buildIngestPrompt(request: IngestRequest): string {
  const s = request.signal;
  const thread = (c: Candidate) => ({ thread_id: c.threadId, title: c.title, recent: c.recent });
  return JSON.stringify(
    {
      mode: request.mode,
      data_source: {
        name: request.dataSource.name,
        description: request.dataSource.description,
        channel: request.dataSource.channel,
        group: request.dataSource.group,
      },
      signal: {
        direction: request.ours ? 'sent_by_us' : 'received',
        from: s.from.value,
        to: s.to.map((t) => t.value),
        subject: s.subject ?? null,
        body: s.body,
        attachments: s.attachments.map((a) => a.name ?? a.path),
      },
      ...(request.thread ? { thread: thread(request.thread) } : {}),
      ...(request.mode === 'choose' ? { candidates: request.candidates.map(thread) } : {}),
    },
    null,
    2,
  );
}

/** Claude の構造化出力に渡す JSON Schema（AiIngestDecision と同じ形） */
export const AI_INGEST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    // enum と型の配列は同時に書けない（API が受け付けない）ので anyOf に分ける
    thread: { anyOf: [{ type: 'string', enum: ['existing', 'new'] }, { type: 'null' }] },
    thread_id: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    needs_response: { type: ['boolean', 'null'] },
    reason: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['thread', 'thread_id', 'title', 'needs_response', 'reason', 'confidence'],
  additionalProperties: false,
} as const;
