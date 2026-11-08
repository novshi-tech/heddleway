import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { canonicalJson, deriveComm, emptyProjections, fold, foldChanges, type DomainEvent } from '../src/domain';
import { d1Repo } from '../src/store/d1';
import { localD1 } from '../scripts/lib/d1';
import { FsRecordingStore } from '../scripts/lib/recordings';
import { addMetrics, emptyMetrics, ingestMetrics, listScenarios, loadScenario, runScenario, sha256, verifyScenario } from '../scripts/lib/scenario';

// 4 シナリオを end-to-end で回す。仮説ごとにテスト名へ番号を付ける。

const names = listScenarios();

describe.each(names)('シナリオ %s', (name) => {
  const scenario = loadScenario(name);

  it(`expected.json と一致する（${scenario.config.hypotheses.join(' ')}）`, async () => {
    const run = await runScenario(scenario);
    const v = await verifyScenario(run);
    expect(v.errors).toEqual([]);
  });

  it('H1 投影を全削除してリプレイしてもスレッドの投影のハッシュが一致し、D1 でも同じになる', async () => {
    const mem = await runScenario(scenario);
    const memHash = await sha256(canonicalJson((await mem.service.state()).threads));
    const rebuilt = await mem.service.rebuild();
    expect(await sha256(canonicalJson(rebuilt.threads))).toBe(memHash);

    const { db, close } = await localD1();
    try {
      const d1 = await runScenario(scenario, { repo: d1Repo(db) });
      const d1State = await d1.service.state();
      expect(await sha256(canonicalJson(d1State.threads))).toBe(memHash);
      await d1.repo.projections.clear();
      const d1Rebuilt = await d1.service.state();
      expect(await sha256(canonicalJson(d1Rebuilt.threads))).toBe(memHash);
      expect(canonicalJson(d1Rebuilt)).toBe(canonicalJson(d1State));
    } finally {
      await close();
    }
  });

  it('H1 fold は決定的（同じイベント列から何度でも同じ投影、1 件ずつ畳んでも同じ）', async () => {
    const run = await runScenario(scenario);
    const events = await run.repo.events.read();
    const whole = canonicalJson(fold(events));
    expect(canonicalJson(fold(events))).toBe(whole);
    const stepwise = events.reduce((p, e) => fold([e], p), emptyProjections());
    expect(canonicalJson(stepwise)).toBe(whole);
  });

  it('H1 fold の差分は、base から実際に変わったスレッド・シグナル・索引を必ず含む（差分だけ保存しても投影が欠けない）', async () => {
    const run = await runScenario(scenario);
    const events = await run.repo.events.read();
    let base = emptyProjections();
    // 1 件ずつと、2 件ずつ（1 回の操作で複数のイベントを書くのと同じ）の両方で確かめる
    for (const size of [1, 2]) {
      base = emptyProjections();
      for (let i = 0; i < events.length; i += size) {
        const { projections: next, changes } = foldChanges(events.slice(i, i + size), base);
        const changed = <T,>(a: Record<string, T>, b: Record<string, T>) =>
          Object.keys(b).filter((id) => canonicalJson(a[id] ?? null) !== canonicalJson(b[id]));
        expect(changes.threadIds).toEqual(expect.arrayContaining(changed(base.threads, next.threads)));
        expect(changes.signalIds).toEqual(expect.arrayContaining(changed(base.signals, next.signals)));
        if (canonicalJson(base.index) !== canonicalJson(next.index)) expect(changes.index).toBe(true);
        base = next;
      }
      expect(canonicalJson(base)).toBe(canonicalJson(fold(events)));
    }
  });

  it('H1 fold は 1 段: 各スレッドの投影は、そのスレッドに綴じたものだけから決まる', async () => {
    const run = await runScenario(scenario);
    const p = await run.service.state();
    const events = await run.repo.events.read();
    for (const t of Object.values(p.threads)) {
      // スレッドのログだけから名指しと担当する操作が同じに導出できる（0038）
      const { attention, dismissed, ownerUserId } = deriveComm(t.log);
      expect({ attention, dismissed, ownerUserId }).toEqual({ attention: t.attention, dismissed: t.dismissed, ownerUserId: t.ownerUserId });
      // 他のスレッドだけに関わるイベントを抜いて畳んでも、このスレッドの投影は変わらない
      // （seq は抜けがあってよい。単調であればよい）
      const mine = events.filter((e) => touches(e, t.id, events));
      expect(canonicalJson(fold(mine, emptyProjections()).threads[t.id])).toBe(canonicalJson(t));
    }
  });
});

/**
 * そのスレッドに関わるイベントか。そのスレッドに一度でも入ったシグナルの置き先の判断は全部残し、
 * そのシグナルが一時的に置かれた他のスレッドと、結んだ相手のスレッドは、作った判断だけ残す（移し替えの元・リンクの端として存在が要るため）
 */
function touches(e: DomainEvent, threadId: string, all: readonly DomainEvent[]): boolean {
  const threadedOf = (signalId: string) =>
    all.filter((x): x is Extract<DomainEvent, { type: 'SignalThreaded' }> => x.type === 'SignalThreaded' && x.payload.signalId === signalId);
  const ours = new Set(
    all.flatMap((x) => (x.type === 'SignalThreaded' && x.payload.thread.threadId === threadId ? [x.payload.signalId] : [])),
  );
  const partners = all.flatMap((x) =>
    x.type === 'ThreadLinked' && (x.payload.a === threadId || x.payload.b === threadId) ? [x.payload.a, x.payload.b] : [],
  );
  const visited = new Set([...[...ours].flatMap((id) => threadedOf(id).map((x) => x.payload.thread.threadId)), ...partners]);
  switch (e.type) {
    case 'SignalObserved':
    case 'OutboundRecorded':
      return true; // シグナルの観測と記録は置き先を決める前提（索引）なので全部残す
    case 'SignalThreaded':
      return ours.has(e.payload.signalId) || (e.payload.thread.kind === 'new' && visited.has(e.payload.thread.threadId));
    case 'ThreadDismissed':
    case 'ThreadReopened':
    case 'ThreadClaimed':
    case 'ThreadNoted':
    case 'ThreadMirrored':
    case 'ReplyOverdue':
    case 'AttentionAcknowledged':
      return e.payload.threadId === threadId;
    case 'ThreadLinked':
      return e.payload.a === threadId || e.payload.b === threadId;
  }
}

// ---- H6 ----

describe('H6 Ingest', () => {
  it('H6 構造で決まった区切りはすべて正解ラベルと一致し、どのシグナルもどこかのスレッドに入る', async () => {
    for (const name of names) {
      const run = await runScenario(loadScenario(name));
      const m = ingestMetrics(run);
      expect(m.structural.correct).toBe(m.structural.total);
      const p = await run.service.state();
      for (const s of Object.values(p.signals)) expect(s.threadId).not.toBeNull();
      const events = await run.repo.events.read();
      for (const e of events) if (e.type === 'SignalThreaded') expect(e.payload.reason.trim()).not.toBe('');
    }
  });

  const withRecordings = names.filter((n) => new FsRecordingStore(join(loadScenario(n).dir, 'recordings')).count() > 0);

  it.skipIf(withRecordings.length < names.length)(
    'H6 Claude の判断（再生モード）が目標値を超える: アンカー込み 90%、AI 判断のみ 80%',
    async () => {
      const total = emptyMetrics();
      for (const name of withRecordings) {
        const run = await runScenario(loadScenario(name), { decider: { kind: 'ai', mode: 'replay', model: 'claude-sonnet-5-5' } });
        addMetrics(total, ingestMetrics(run));
      }
      expect(total.correct / total.total).toBeGreaterThanOrEqual(0.9);
      expect(total.ai.correct / total.ai.total).toBeGreaterThanOrEqual(0.8);
    },
  );
});
