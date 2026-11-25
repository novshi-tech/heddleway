import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, connectTaskList, fold, foldChanges, type InboundMirror } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { localD1 } from '../../scripts/lib/d1';
import { makeService } from '../helpers/service';
import { answer, email, EventLog, ingestPure, makeCtx, seed } from '../helpers/world';

// 投影の差分の保存は「土台 ≤ 保存済みの lastSeq < 新しい lastSeq」のときだけ当てる（保存がなければ保存済みは 0）。
// 空（消した直後）の保存先に、古い土台からの差分が着いても、差分の行だけで lastSeq を進めない（残りのスレッドが作り直されない）。
// 弾かれた保存は何も書かない（D1 は行の挿入にも条件を掛ける）。作り直しは保存先を空にせず、丸ごとの保存 1 回で入れ替える

const AT = '2026-10-16T09:00:00.000Z';
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

interface Impl {
  repo: Repo;
  /** 保存先に実際にある行数と lastSeq（D1 は SQL で直に数える） */
  raw(): Promise<{ threads: number; signals: number; lastSeq: number | null }>;
}

const impls: [string, () => Promise<Impl>][] = [
  [
    'memory',
    async () => {
      const repo = memoryRepo();
      return {
        repo,
        raw: async () => {
          const p = await repo.projections.load();
          return { threads: Object.keys(p?.threads ?? {}).length, signals: Object.keys(p?.signals ?? {}).length, lastSeq: p?.lastSeq ?? null };
        },
      };
    },
  ],
  [
    'd1',
    async () => {
      const { db, close } = await localD1();
      closers.push(close);
      const count = async (sql: string) => (await db.$client.prepare(sql).first<{ n: number | null }>())!.n;
      return {
        repo: d1Repo(db),
        raw: async () => ({
          threads: (await count('SELECT count(*) AS n FROM threads'))!,
          signals: (await count('SELECT count(*) AS n FROM signals'))!,
          lastSeq: await count('SELECT max(last_seq) AS n FROM projection_meta'),
        }),
      };
    },
  ],
];

/** To Do のタスク 3 本（A・B・C）を 1 つずつ写したイベント列を持つサービス */
async function threeTasks(impl: Impl, wrap?: (repo: Repo) => Repo) {
  const made = await makeService(seed, { repo: wrap ? wrap(impl.repo) : impl.repo });
  const { result } = await made.service.changeMaster('u_bob', 'To Do をつなぐ', (d, c) =>
    connectTaskList(d, c, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', address: 'bob.todo@ubs.example', listId: 'L', listName: 'Murmur' }),
  );
  const mirror = (key: string): InboundMirror => ({
    kind: 'mirror',
    dataSourceId: result.dataSource.id,
    channel: 'todo',
    threadKey: key,
    fields: { closed: false, holders: ['bob.todo@ubs.example'], title: key, statusLabel: 'Murmur', due: null },
    sourceRef: key,
  });
  await made.service.mirror(mirror('A'));
  const afterA = (await impl.repo.events.read()).length;
  await made.service.mirror(mirror('B'));
  await made.service.mirror(mirror('C'));
  const events = await impl.repo.events.read();
  // A の記録のあとに B・C だけを畳んだ、古い土台（A まで）からの差分。A のスレッドは差分に入らない
  const stale = foldChanges(events.slice(afterA), fold(events.slice(0, afterA)));
  expect(stale.changes.baseSeq).toBe(afterA);
  expect(stale.changes.threadIds).toHaveLength(2);
  expect(events.length).toBeGreaterThan(afterA + 1);
  return { ...made, events, afterA, stale, all: fold(events) };
}

describe.each(impls)('H1 投影の差分の保存は土台を守る（%s）', (_n, make) => {
  it('消した直後の空の保存先に古い土台からの差分が着いても弾く（保存先は空のまま）。そのあとの state() が全部作り直す', async () => {
    const impl = await make();
    const w = await threeTasks(impl);
    await impl.repo.projections.clear();
    await impl.repo.projections.save(w.stale.projections, w.stale.changes); // 遅れて着いた古い土台の差分
    expect(await impl.repo.projections.load()).toBeNull();
    expect(await impl.raw()).toEqual({ threads: 0, signals: 0, lastSeq: null });

    const state = await w.service.state();
    expect(state).toEqual(w.all);
    expect(Object.keys(state.threads)).toHaveLength(3);
    expect(await impl.repo.projections.load()).toEqual(w.all);
  });

  it('土台が保存済みより先の差分は、保存先が空でなくても弾く。何も書かない（新しい行も入らない）', async () => {
    const impl = await make();
    const w = await threeTasks(impl);
    // 保存先は A までの完全な投影。C だけの差分（土台は B まで）は、B が保存先にないので当てられない
    const upToB = fold(w.events.slice(0, w.events.length - 1));
    await impl.repo.projections.clear();
    await impl.repo.projections.save(fold(w.events.slice(0, w.afterA)));
    const before = await impl.raw();
    expect(before).toMatchObject({ threads: 1, lastSeq: w.afterA });
    const last = foldChanges(w.events.slice(-1), upToB);
    expect(last.changes.baseSeq).toBeGreaterThan(w.afterA);
    expect(last.changes.threadIds.length).toBeGreaterThan(0);
    await impl.repo.projections.save(last.projections, last.changes);
    expect(await impl.raw()).toEqual(before);
    expect(await impl.repo.projections.load()).toEqual(fold(w.events.slice(0, w.afterA)));
    expect(await w.service.state()).toEqual(w.all);
  });

  it('作り直し（rebuild）の途中で古い土台の差分が着いても、保存先は空にならず、部分的にもならない', async () => {
    const impl = await make();
    let late: (() => Promise<void>) | null = null;
    let seen: unknown = 'not-run';
    const w = await threeTasks(impl, (repo) => ({
      ...repo,
      events: {
        append: (e, d, at) => repo.events.append(e, d, at),
        read: async (after) => {
          const run = late;
          late = null;
          if (run) {
            // イベントを読んだ書き手が、保存の前に、別の書き手の保存が着く
            seen = await repo.projections.load();
            await run();
          }
          return repo.events.read(after);
        },
      },
    }));
    // 保存先は最後の 1 件の手前までの完全な投影（lastSeq < 差分の新しい lastSeq）
    await impl.repo.projections.save(fold(w.events.slice(0, w.events.length - 1)));
    late = () => impl.repo.projections.save(w.stale.projections, w.stale.changes);
    const rebuilt = await w.service.rebuild();
    expect(seen).not.toBeNull(); // 作り直しの間、保存先は空にならない
    expect(rebuilt).toEqual(w.all);
    expect(await impl.repo.projections.load()).toEqual(w.all);
    expect(await impl.raw()).toMatchObject({ threads: 3, lastSeq: w.all.lastSeq });
  });

  it('形が古い投影の作り直し（state）も、保存先を空にしない。途中で着いた古い土台の差分は部分的な投影を残さない', async () => {
    const impl = await make();
    let late: (() => Promise<void>) | null = null;
    let seen: unknown = 'not-run';
    const w = await threeTasks(impl, (repo) => ({
      ...repo,
      events: {
        append: (e, d, at) => repo.events.append(e, d, at),
        read: async (after) => {
          const run = late;
          late = null;
          if (run) {
            seen = await repo.projections.load();
            await run();
          }
          return repo.events.read(after);
        },
      },
    }));
    // 形が古い投影（名指しがない）を、最後の 1 件の手前の lastSeq で置く
    const old = fold(w.events.slice(0, w.events.length - 1));
    for (const t of Object.values(old.threads)) delete (t as { attention?: unknown }).attention;
    await impl.repo.projections.save(old);
    late = () => impl.repo.projections.save(w.stale.projections, w.stale.changes);
    expect(await w.service.state()).toEqual(w.all);
    expect(seen).not.toBeNull();
    expect(await impl.repo.projections.load()).toEqual(w.all);
  });

  it('弾かれた保存は書き手を失敗させない。次の state() が保存済みの lastSeq から追いつく（畳み直しは起きない）', async () => {
    const impl = await make();
    let refuse = false;
    const saves: number[] = [];
    const w = await threeTasks(impl, (repo) => ({
      ...repo,
      projections: {
        load: () => repo.projections.load(),
        clear: () => repo.projections.clear(),
        save: async (p, c) => {
          saves.push(p.lastSeq);
          if (refuse) return; // 保存が弾かれたのと同じ（何も書かない）
          return repo.projections.save(p, c);
        },
      },
    }));
    refuse = true;
    await w.service.mirror({
      kind: 'mirror',
      dataSourceId: Object.values(w.all.threads)[0]!.dataSourceId,
      channel: 'todo',
      threadKey: 'D',
      fields: { closed: false, holders: ['bob.todo@ubs.example'], title: 'D', statusLabel: 'Murmur', due: null },
      sourceRef: 'D',
    });
    refuse = false;
    const stored = (await impl.repo.projections.load())!.lastSeq;
    expect(stored).toBe(w.all.lastSeq); // D の保存は届いていない
    const state = await w.service.state();
    expect(state.lastSeq).toBe((await impl.repo.events.read()).length);
    expect(Object.keys(state.threads)).toHaveLength(4);
    expect(await impl.repo.projections.load()).toEqual(state);
    expect(state).toEqual(fold(await impl.repo.events.read()));
  });
});

describe.each(impls)('H1 投影の差分の保存: ふつうの順序（%s）', (_n, make) => {
  // ID は ctx が数えるので、1 つの EventLog には 1 つの ctx を使い続ける
  const ctxs = new WeakMap<EventLog, ReturnType<typeof makeCtx>>();
  const build = (count: number, log = new EventLog(), from = 0) => {
    const ctx = ctxs.get(log) ?? makeCtx(AT);
    ctxs.set(log, ctx);
    for (let i = from; i < from + count; i++) ingestPure(log, ctx, email({ from: `c${i}@example.com`, sourceRef: `r${i}` }), () => answer({ title: `件 ${i}` }));
    return log;
  };

  it('空からの最初の保存、続く差分、同じ lastSeq の保存（何もしない）', async () => {
    const { repo } = await make();
    const log = build(2);
    const first = log.state();
    await repo.projections.save(first, foldChanges(log.events).changes); // 土台 0
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(first));

    const n = log.events.length;
    build(1, log, 2);
    const second = foldChanges(log.events.slice(n), first);
    expect(second.changes.baseSeq).toBe(n);
    await repo.projections.save(second.projections, second.changes); // 連続
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(log.state()));

    // 同じ lastSeq の保存は何も書かない（中身が違っても上書きしない）
    const tampered = structuredClone(second.projections);
    for (const id of second.changes.threadIds) tampered.threads[id]!.title = '書き換え';
    await repo.projections.save(tampered, second.changes);
    await repo.projections.save(second.projections, second.changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(log.state()));
  });

  it('古い土台から計算した新しい差分が、先へ進んだ完全な保存先に着いても、fold(全部) に収束する', async () => {
    const { repo } = await make();
    const log = build(2);
    const m = log.events.length;
    const baseM = log.state();
    build(2, log, 2);
    const k = log.events.length;
    const baseK = log.state();
    build(2, log, 4);
    const all = log.state();
    // 保存先は K までの完全な投影。M から N までの差分（M ≤ K < N）が着く
    await repo.projections.save(baseK);
    const late = foldChanges(log.events.slice(m), baseM);
    expect(late.changes.baseSeq).toBe(m);
    expect(m).toBeLessThan(k);
    await repo.projections.save(late.projections, late.changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(all));
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(fold(log.events)));
  });

  it('1 文に収まらない行数の差分（スレッドもシグナルも 1 文の行数を超える）も、空からも土台つきでも書ける', async () => {
    const { repo, raw } = await make();
    const log = build(10);
    const before = log.state();
    await repo.projections.save(before, foldChanges(log.events).changes);
    const n = log.events.length;
    build(80, log, 10); // 1 文あたりの行数（スレッド 33・シグナル 25）を超える
    const next = foldChanges(log.events.slice(n), before);
    expect(next.changes.threadIds.length).toBeGreaterThan(66);
    expect(next.changes.signalIds.length).toBeGreaterThan(50);
    await repo.projections.save(next.projections, next.changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(log.state()));
    expect(await raw()).toMatchObject({ threads: 90, signals: 90 });

    await repo.projections.clear();
    await repo.projections.save(log.state(), foldChanges(log.events).changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(log.state()));
  });
});
