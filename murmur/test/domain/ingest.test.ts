import { describe, expect, it } from 'vitest';
import {
  commView,
  AI_INGEST_JSON_SCHEMA,
  AiIngestDecision,
  buildIngestPrompt,
  DEFAULT_POLICY,
  DomainError,
  draft,
  finalizeIngest,
  INGEST_SYSTEM_PROMPT,
  prepareInbound,
  type IngestRequest,
} from '../../src/domain';
import { answer, dir, email, view, EventLog, ingestPure, line, makeCtx } from '../helpers/world';

// Ingest の判断（区切り + 返事や対応を求めているか）。H6

describe('prepareInbound', () => {
  it('H6 source_ref の重複排除はデータソースごと', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1' }), () => answer());
    expect(prepareInbound(log.state(), ctx, email({ from: 'carol@example.com', sourceRef: 'r1' }))).toEqual({ kind: 'duplicate', signalId: 'sig_1' });
    // 別のデータソースの同じキーは別物（同じメールを 2 人がそれぞれつないだ場合など）
    expect(prepareInbound(log.state(), ctx, email({ dataSourceId: 'ds_alice', from: 'carol@example.com', sourceRef: 'r1', to: ['alice@ubs.example'] })).kind).toBe('signal');
  });

  it('H6 こちらからかは取り込む時点のマスタで決め（判断にだけ使う）、イベントはアドレスだけを持つ（0030）', () => {
    const p = new EventLog().state();
    const ctx = makeCtx();
    const out = prepareInbound(p, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'r1' }));
    expect(out).toMatchObject({ kind: 'signal', ours: true });
    expect(out.kind === 'signal' && Object.keys(out.payload)).not.toContain('direction');
    const inb = prepareInbound(p, ctx, email({ from: 'stranger@example.com', sourceRef: 'r2' }));
    expect(inb).toMatchObject({ kind: 'signal', ours: false });
    // 読者（Alice）の個人アドレスからなら、support@ のデータソースでもこちら
    const staff = prepareInbound(p, ctx, email({ from: 'alice@ubs.example', sourceRef: 'r3' }));
    expect(staff).toMatchObject({ kind: 'signal', ours: true });
  });

  it('H3 取り込めるのは外のサービスのデータソースだけ', () => {
    const p = new EventLog().state();
    const ctx = makeCtx();
    const bad = (over: Partial<Parameters<typeof email>[0]>) => () => prepareInbound(p, ctx, email({ from: 'a@x', sourceRef: 'r', ...over }));
    expect(bad({ dataSourceId: 'ds_nope' })).toThrow(DomainError);
    expect(bad({ dataSourceId: 'ds_slack' })).toThrow(/is slack, not email/);
  });
});

describe('区切り（H6）', () => {
  it('H6 1. アンカー（In-Reply-To）は同じデータソースの中だけで解決し、AI を呼ばない（0038）', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    const first = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
    expect(first.outcome).toEqual({ threadId: 'thr_2', newThread: true, by: 'no_match' });
    expect(first.request?.mode).toBe('new');

    const reply = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    expect(reply.request).toBeUndefined();
    expect(reply.outcome).toEqual({ threadId: 'thr_2', newThread: false, by: 'anchor' });
    expect(log.state().signals[reply.signalId!]!.threadedBy).toBe('anchor');

    // 別のデータソースに同じ Message-ID への返信が来ても、そのデータソースのスレッドには入らない
    const other = ingestPure(
      log,
      ctx,
      email({ dataSourceId: 'ds_alice', from: 'carol@example.com', to: ['alice@ubs.example'], sourceRef: 'r3', anchors: { inReplyTo: '<m1>' } }),
      () => answer(),
    );
    expect(other.outcome).toMatchObject({ newThread: true, by: 'no_match' });
  });

  it('H6 1. thread_ts と LINE の引用もアンカー', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l1', anchors: { messageId: 'm1' } }), () => answer());
    const quoted = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l2', anchors: { messageId: 'm2', quotedMessageId: 'm1' } }));
    expect(quoted.outcome).toMatchObject({ threadId: 'thr_2', by: 'anchor' });

    const slack = new EventLog();
    const sctx = { ...makeCtx() };
    const msg = (sourceRef: string, anchors: Record<string, string>) => ({
      dataSourceId: 'ds_slack',
      channel: 'slack' as const,
      from: { channel: 'slack' as const, value: 'T_UBS/U_EVE' },
      to: [],
      body: 'x',
      anchors,
      sourceRef,
    });
    ingestPure(slack, sctx, msg('a', { messageId: 'C/1.0' }), () => answer());
    const inThread = ingestPure(slack, sctx, msg('b', { messageId: 'C/2.0', threadTs: 'C/1.0' }));
    expect(inThread.outcome).toMatchObject({ threadId: 'thr_2', by: 'anchor' });
  });

  it('H6 1. ソースの区切り（threadKey）は一致すればそのスレッド、一致しなければ新しいスレッドに決まる（AI は件名だけ）', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    const k = (sourceRef: string, threadKey: string) => email({ from: 'jira@x', sourceRef, anchors: { threadKey } });
    const a = ingestPure(log, ctx, k('j1', 'DEV-12'), (req) => {
      expect(req.mode).toBe('new');
      return answer({ needs_response: false, confidence: 0.9 });
    });
    expect(a.outcome).toMatchObject({ newThread: true, by: 'anchor' });
    // 同じ送り主の直近のスレッドがあっても、別のキーなら新しいスレッド
    const b = ingestPure(log, ctx, k('j2', 'DEV-30'), (req) => {
      expect(req.mode).toBe('new');
      return answer({ needs_response: false, confidence: 0.9 });
    });
    expect(b.outcome).toMatchObject({ newThread: true, by: 'anchor' });
    const c = ingestPure(log, ctx, k('j3', 'DEV-12'));
    expect(c.outcome).toMatchObject({ threadId: a.outcome!.threadId, by: 'anchor' });
  });

  it('H6 2. 同じ相手で返事を待っているスレッドが 1 本だけなら、そのスレッド（v1 の s02 の取り違えの対策）', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    // 欠勤の連絡と、別の人への打診
    const abs = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l1' }), () => answer({ title: '欠勤' }));
    const ask = ingestPure(log, ctx, line({ from: '@ubs', to: 'U_dave', sourceRef: 'l2', body: '代わりに入れますか？' }));
    expect(ask.outcome).toMatchObject({ newThread: true, by: 'no_match' });
    // U_dave は Contact に解決できないので、アドレスのまま名指しに載る（0030・0038）
    expect(view(log.state(), ask.outcome!.threadId).attention.named).toMatchObject([{ address: { channel: 'line', value: 'U_dave' }, userId: null, contactId: null }]);

    // Dave（未知のアドレス）の返事は、Dave を待っている打診のスレッドに入る
    const yes = ingestPure(log, ctx, line({ from: 'U_dave', sourceRef: 'l3', body: '入れます' }));
    expect(yes.outcome).toMatchObject({ threadId: ask.outcome!.threadId, by: 'awaiting' });
    expect(log.state().threads[abs.outcome!.threadId]!.signalIds).toHaveLength(1);
  });

  it('H6 2. 返事を待っているスレッドが 2 本あれば決めず、AI に候補として渡す', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    ingestPure(log, ctx, line({ from: '@ubs', to: 'U_carol', sourceRef: 'l1', body: '打診 1' }));
    ingestPure(log, ctx, line({ from: '@ubs', to: 'U_carol', sourceRef: 'l2', body: '打診 2' }), (req) => {
      expect(req.mode).toBe('choose');
      return answer({ thread: 'new', title: '打診 2' });
    });
    const r = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l3', body: 'どちらも大丈夫です' }), (req) => {
      expect(req.mode).toBe('choose');
      expect(req.candidates.map((c) => c.threadId).sort()).toEqual(['thr_2', 'thr_4']);
      return answer({ thread: 'existing', thread_id: 'thr_4', needs_response: false, confidence: 0.9 });
    });
    expect(r.outcome).toMatchObject({ threadId: 'thr_4', by: 'ai' });
  });

  it('H6 3. 候補は同じ相手の直近のスレッド（片付けたものは除く、本数は設定値）。4. 当たらなければ新しいスレッド', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    const t = (n: number) => `2026-10-16T${String(9 + n).padStart(2, '0')}:00:00.000Z`;
    for (let i = 0; i < 4; i++) {
      ctx.setNow(t(i));
      ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: `c${i}` }), (req) => {
        expect(req.candidates).toHaveLength(Math.min(i, 2));
        return answer({ thread: 'new', title: `件 ${i}` });
      }, { ...DEFAULT_POLICY, recentThreadLimit: 2 });
    }
    // 別の相手のスレッドは候補にならない
    ctx.setNow(t(5));
    const other = ingestPure(log, ctx, email({ from: 'info@dave.example', sourceRef: 'd1' }), (req) => {
      expect(req.mode).toBe('new');
      return answer();
    });
    expect(other.outcome).toMatchObject({ by: 'no_match', newThread: true });

    // 片付けたスレッドは候補から外れる。直近の順に並ぶ
    const threads = Object.values(log.state().threads).filter((x) => commView(dir, x).counterpartContactIds.includes('p_carol'));
    log.push([draft('ThreadDismissed', { threadId: threads.at(-1)!.id, actorUserId: 'u_alice', reason: 'x' })], t(6));
    ctx.setNow(t(7));
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'c9' }), (req) => {
      expect(req.candidates.map((c) => c.title)).toEqual(['件 2', '件 1', '件 0']);
      return answer({ thread: 'existing', thread_id: req.candidates[0]!.threadId });
    });
  });

  it('H6 グループのチャネルは「同じ相手」がチャネル全体になる', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    const msg = (sourceRef: string, from: string) => ({
      dataSourceId: 'ds_slack',
      channel: 'slack' as const,
      from: { channel: 'slack' as const, value: from },
      to: [],
      body: 'x',
      sourceRef,
    });
    ingestPure(log, ctx, msg('a', 'T_X/U_1'), () => answer());
    ingestPure(log, ctx, msg('b', 'T_X/U_2'), (req) => {
      expect(req.dataSource.group).toBe(true);
      expect(req.candidates).toHaveLength(1);
      return answer({ thread: 'existing', thread_id: req.candidates[0]!.threadId });
    });
  });

  it('H6 観測された送信は構造で決まれば AI を呼ばない。候補があれば区切りだけ AI に聞く', () => {
    const log = new EventLog();
    const ctx = makeCtx();
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer());
    const reply = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    expect(reply.outcome).toEqual({ threadId: 'thr_2', newThread: false, by: 'anchor' });
    // 候補があれば区切りだけ AI に聞き、返事の needs_response は捨てる
    const more = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'r3' }), (req) => {
      expect(req.mode).toBe('choose');
      expect(buildIngestPrompt(req)).toContain('"direction": "sent_by_us"');
      return answer({ thread: 'existing', thread_id: 'thr_2', needs_response: true });
    });
    expect(more.outcome).toEqual({ threadId: 'thr_2', newThread: false, by: 'ai' });
  });
});

describe('finalizeIngest（AI 出力の検証）', () => {
  const log = new EventLog();
  const ctx = makeCtx();
  ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1' }), () => answer({ title: '雨漏り' }));
  const capture = (): IngestRequest => {
    let req!: IngestRequest;
    ingestPure(new EventLog(), makeCtx(), email({ from: 'x@y', sourceRef: 'z' }), (r) => ((req = r), answer()));
    return req;
  };

  it('H6 候補にないスレッドを選んだら新しいスレッドに倒し、理由に残す', () => {
    const req = { ...capture(), mode: 'choose' as const, threading: { kind: 'choose' as const, candidates: [] }, candidates: [] };
    const r = finalizeIngest(ctx, req, answer({ thread: 'existing', thread_id: 'thr_x', title: '件名' }), 'ai');
    expect(r.outcome).toMatchObject({ newThread: true, by: 'ai' });
    const e = r.events[0]!;
    expect(e.type === 'SignalThreaded' && e.payload).toMatchObject({ thread: { kind: 'new', title: '件名' } });
    expect(e.type === 'SignalThreaded' && e.payload.reason).toMatch(/候補外/);
  });

  it('H6 「求めているか」（needs_response）の答えは使わない。null を書く（0038）', () => {
    const req = capture();
    const low = finalizeIngest(ctx, req, answer({ needs_response: false, confidence: 0.3 }), 'ai');
    const e = low.events[0]!;
    expect(e.type === 'SignalThreaded' && e.payload).toMatchObject({ confidence: 0.3, needsResponse: null });
    expect(low.outcome).not.toHaveProperty('needsResponse');
  });

  it('H6 件名は AI の title、なければ件名か本文の先頭', () => {
    const req = capture();
    const r = finalizeIngest(ctx, req, answer({ title: '  ' }), 'ai');
    const e = r.events[0]!;
    expect(e.type === 'SignalThreaded' && e.payload.thread).toMatchObject({ kind: 'new', title: '本文' });
  });
});

describe('プロンプト', () => {
  it('H6 プロンプトは固定で、業務の知識（リスト名・担当・振り分け先）を持たない', () => {
    expect(INGEST_SYSTEM_PROMPT).not.toMatch(/list_id|担当者を選|リストを選/);
    const log = new EventLog();
    const r = ingestPure(log, makeCtx(), email({ from: 'carol@example.com', sourceRef: 'r1', subject: '件名' }), () => answer());
    const prompt = JSON.parse(buildIngestPrompt(r.request!));
    expect(Object.keys(prompt).sort()).toEqual(['data_source', 'mode', 'signal']);
    expect(prompt.signal).toMatchObject({ direction: 'received', subject: '件名' });
  });

  it('H6 構造化出力の JSON Schema は API が受け付ける形（enum は単一の型と組む）で、zod のスキーマと同じ値を通す', () => {
    for (const [name, prop] of Object.entries(AI_INGEST_JSON_SCHEMA.properties)) {
      const p = prop as { type?: unknown; enum?: unknown };
      if (p.enum) expect(typeof p.type, name).toBe('string');
    }
    expect(AI_INGEST_JSON_SCHEMA.required).toEqual(Object.keys(AiIngestDecision.shape));
    expect(AI_INGEST_JSON_SCHEMA.properties.thread.anyOf).toEqual([{ type: 'string', enum: ['existing', 'new'] }, { type: 'null' }]);
  });
});
