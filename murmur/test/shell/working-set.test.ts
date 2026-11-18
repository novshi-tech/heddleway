import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  DEFAULT_POLICY,
  dedupeRequest,
  fold,
  mirrorRequest,
  selectListScope,
  selectOverdueSet,
  selectThreadScope,
  selectWorkingSet,
  threadingRequest,
  type WorkingSetRequest,
} from '../../src/domain';
import { drizzle } from 'drizzle-orm/d1';
import { MurmurService } from '../../src/app/service';
import { d1Repo, type Db } from '../../src/store/d1';
import { localD1, localD1Raw } from '../../scripts/lib/d1';
import { listScenarios, loadScenario, runScenario } from '../../scripts/lib/scenario';

// 0046 の決定 1: D1 の作業範囲は、全件の投影から selectWorkingSet で選んだものと同じ。
// シナリオを D1 で回したあと、どのシグナルについても（重複排除・区切り・写しの依頼で）両方を比べる

describe.each(listScenarios())('H1 作業範囲（D1）は selectWorkingSet と同じ（%s）', (name) => {
  it('全シグナルの依頼で一致する（窓の広さを変えても）', async () => {
    const { db, close } = await localD1();
    try {
      const run = await runScenario(loadScenario(name), { repo: d1Repo(db) });
      const full = fold(await run.repo.events.read());
      const signals = Object.values(full.signals);
      const latestAt = signals.map((s) => s.at).sort().at(-1)!;
      const reqs: WorkingSetRequest[] = [];
      for (const s of signals) {
        reqs.push(dedupeRequest(s));
        // 窓は 3 通り: 既定、ほぼ全部（10 年）、狭い（1 日・上限 2 本）
        // 返事待ちの見方は 3 通り: 1 対 1 の受信（送り主で引く）、グループ（全部）、こちらからの送信（読まない）
        for (const conversation of [{ ours: false, group: false }, { ours: false, group: true }, { ours: true, group: false }]) {
          reqs.push(threadingRequest(s, latestAt, DEFAULT_POLICY, conversation));
          reqs.push(threadingRequest(s, latestAt, { ...DEFAULT_POLICY, candidateWindowDays: 3650 }, conversation));
          reqs.push(threadingRequest(s, latestAt, { ...DEFAULT_POLICY, candidateWindowDays: 1, candidateWindowLimit: 2 }, conversation));
        }
        // 名指しされたアドレス（送り主として来たとき）でも引く
        for (const r of s.to) reqs.push(threadingRequest({ ...s, from: r }, latestAt, DEFAULT_POLICY, { ours: false, group: false }));
        if (s.anchors.threadKey) reqs.push(mirrorRequest({ dataSourceId: s.dataSourceId, threadKey: s.anchors.threadKey }));
      }
      for (const t of Object.values(full.threads)) if (t.sourceKey) reqs.push(mirrorRequest({ dataSourceId: t.dataSourceId, threadKey: t.sourceKey }));
      // 当たらない値
      reqs.push(mirrorRequest({ dataSourceId: signals[0]!.dataSourceId, threadKey: 'NOPE-1' }));
      expect(reqs.length).toBeGreaterThan(10);
      // 詳細・操作と一覧の範囲（0047）も、selectThreadScope・selectListScope と一致する
      for (const t of Object.values(full.threads)) {
        for (const req of [{ threadIds: [t.id] }, { threadIds: [t.id], links: true, candidates: true }, { threadIds: [], signalIds: t.signalIds.slice(0, 1), links: true }]) {
          expect(canonicalJson(await run.repo.projections.threadScope!(req)), JSON.stringify(req)).toBe(canonicalJson(selectThreadScope(full, req)));
        }
      }
      const allDs = [...new Set(Object.values(full.threads).map((t) => t.dataSourceId))];
      for (const dataSourceIds of [allDs, allDs.slice(0, 1), []]) {
        for (const openOnly of [true, false]) {
          const req = { dataSourceIds, openOnly };
          expect(canonicalJson(await run.repo.projections.listScope!(req)), JSON.stringify(req)).toBe(canonicalJson(selectListScope(full, req)));
        }
      }
      // 期限の見回りの作業範囲も、いくつかの時刻で selectOverdueSet と一致する
      const dues = Object.values(full.threads).map((t) => t.replyExpectedBy).filter((x): x is string => !!x).sort();
      for (const before of ['1970-01-01T00:00:00.000Z', ...dues, '2999-01-01T00:00:00.000Z']) {
        expect(canonicalJson(await run.repo.projections.overdueSet!(before)), before).toBe(canonicalJson(selectOverdueSet(full, before)));
      }
      for (const req of reqs) {
        const got = await run.repo.projections.workingSet!(req);
        expect(canonicalJson(got), JSON.stringify(req)).toBe(canonicalJson(selectWorkingSet(full, req)));
      }
    } finally {
      await close();
    }
  });
});

describe('H1 冷えた isolate でも、取り込みは投影の全件を読まない（0046）', () => {
  it('重複・写しの「変わっていない」・新しいメッセージのどれでも、threads と signals の全件の select がない', async () => {
    const { d1, close } = await localD1Raw();
    try {
      const run = await runScenario(loadScenario('development'), { repo: d1Repo(drizzle(d1) as Db) });
      // 別のバインディング（冷えた isolate）で、全件の select（WHERE のない threads・signals）を数える
      const full: string[] = [];
      const cold = new Proxy(d1, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === 'prepare')
            return (query: string) => {
              if (/^\s*select\b[^]*\bfrom\s+"?(threads|signals)"?(?![_\w])(?![^]*\bwhere\b)/i.test(query)) full.push(query);
              return target.prepare(query);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as D1Database;
      const service = new MurmurService({ ...run.service.deps, repo: d1Repo(drizzle(cold) as Db) });
      const p = fold(await run.repo.events.read());
      const s = Object.values(p.signals).find((x) => !x.recorded)!;
      const inbound = { dataSourceId: s.dataSourceId, channel: s.channel, from: s.from, to: s.to, subject: s.subject, body: s.body, anchors: s.anchors, sourceRef: s.sourceRef };
      expect(await service.ingest(inbound)).toMatchObject({ status: 'duplicate', signalId: s.signalId });
      const mirrored = Object.values(p.threads).find((t) => t.sourceKey && t.source);
      if (mirrored) {
        const src = mirrored.source!;
        const r = await service.mirror({
          kind: 'mirror',
          dataSourceId: mirrored.dataSourceId,
          channel: p.signals[mirrored.signalIds[0] ?? '']?.channel ?? 'jira',
          threadKey: mirrored.sourceKey!,
          fields: { closed: mirrored.closedAtSource, holders: src.holders, title: mirrored.title, statusLabel: src.statusLabel, due: src.due },
          sourceRef: 'probe',
        });
        expect(r.status).toBe('unchanged');
      }
      // 新しいメッセージ（同じ相手の続き。区切りは AI まで行くこともある）
      const fresh = await service.ingest({ ...inbound, sourceRef: `${s.sourceRef}#new`, anchors: s.anchors.messageId ? { inReplyTo: s.anchors.messageId } : {} });
      expect(fresh.status).toBe("threaded");
      expect(full).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('H1 まとめて読んだものは、取り込み済みを 1 回の照会で落としてから取り込む（0046）', () => {
  it.each(['memory', 'd1'] as const)('%s: 取り込み済みは 1 件ずつの取り込みに回らず、新しいものだけが取り込まれる', async (kind) => {
    const { d1, close } = await localD1Raw();
    try {
      const run = await runScenario(loadScenario('development'), kind === 'd1' ? { repo: d1Repo(drizzle(d1) as Db) } : {});
      const p = fold(await run.repo.events.read());
      const old = Object.values(p.signals).filter((x) => !x.recorded);
      const inbound = old.map((s) => ({ dataSourceId: s.dataSourceId, channel: s.channel, from: s.from, to: s.to, subject: s.subject, body: s.body, anchors: s.anchors, sourceRef: s.sourceRef }));
      const s0 = old[0]!;
      const fresh = { ...inbound[0]!, sourceRef: `${s0.sourceRef}#fresh`, anchors: s0.anchors.messageId ? { inReplyTo: s0.anchors.messageId } : {} };
      const calls: string[] = [];
      const orig = run.service.ingestItem.bind(run.service);
      run.service.ingestItem = async (it) => {
        calls.push(it.sourceRef);
        return orig(it);
      };
      const results = await run.service.ingestItems([...inbound, fresh]);
      expect(calls).toEqual([fresh.sourceRef]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ status: 'threaded' });
      // 2 回目は全部取り込み済み
      calls.length = 0;
      expect(await run.service.ingestItems([...inbound, fresh])).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });
});
