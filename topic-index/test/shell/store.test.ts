import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, draft, foldChanges, planMasterEdit } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { memoryRepo } from '../../src/store/memory';
import { ConcurrencyError, type Repo } from '../../src/store/types';
import { localD1 } from '../../scripts/lib/d1';
import { answer, email, EventLog, ingestPure, makeCtx, seed } from '../helpers/world';

// メモリ実装と D1 実装（Miniflare）に同じ契約テストを当てる

const AT = '2026-10-16T09:00:00.000Z';
const dismissed = (threadId: string) => draft('ThreadDismissed', { threadId, actorUserId: 'u', reason: 'r' });
let closeDb: (() => Promise<void>) | undefined;
const impls: [string, () => Promise<Repo>][] = [
  ['memory', async () => memoryRepo()],
  [
    'd1',
    async () => {
      const { db, close } = await localD1();
      closeDb = close;
      return d1Repo(db);
    },
  ],
];

describe.each(impls)('Repo 契約（%s）', (_name, make) => {
  let repo: Repo;
  beforeAll(async () => {
    repo = await make();
  });
  afterAll(async () => {
    await closeDb?.();
    closeDb = undefined;
  });

  it('append した列が read でそのまま戻る（seq は 1 から）', async () => {
    expect(await repo.events.read()).toEqual([]);
    const a = await repo.events.append(0, [dismissed('x'), draft('ThreadReopened', { threadId: 'x', actorUserId: 'u' })], AT);
    const b = await repo.events.append(2, [dismissed('y')], AT);
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(b[0]!.seq).toBe(3);
    expect(await repo.events.read()).toEqual([...a, ...b]);
    expect(await repo.events.read(1)).toEqual([a[1], b[0]]);
    expect(await repo.events.read(3)).toEqual([]);
  });

  it('期待した seq と違えば ConcurrencyError（楽観ロック）', async () => {
    await expect(repo.events.append(0, [dismissed('x')], AT)).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(repo.events.append(5, [dismissed('x')], AT)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(await repo.events.append(3, [], AT)).toEqual([]);
    expect((await repo.events.read()).length).toBe(3);
  });

  it('不正な payload は append できない', async () => {
    await expect(repo.events.append(3, [{ type: 'ThreadDismissed', payload: {} } as never], AT)).rejects.toThrow();
    expect((await repo.events.read()).length).toBe(3);
  });

  it('投影は保存・読み出しで同じものが戻り、clear で消える', async () => {
    const log = new EventLog();
    const ctx = makeCtx(AT);
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    ingestPure(log, ctx, email({ from: 'ad@x', sourceRef: 'r3' }), () => answer({ needs_response: false, confidence: 0.99 }));
    const p = log.state();
    await repo.projections.save(p);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(p));
    // 上書き保存も同じ
    await repo.projections.save(p);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(p));
    await repo.projections.clear();
    expect(await repo.projections.load()).toBeNull();
  });

  it('差分の保存は、変わったスレッドとシグナルだけを書いて丸ごとの保存と同じものになる', async () => {
    const log = new EventLog();
    const ctx = makeCtx(AT);
    ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }), () => answer({ title: '雨漏り' }));
    ingestPure(log, ctx, email({ from: 'ad@x', sourceRef: 'r2' }), () => answer({ needs_response: false }));
    const before = log.state();
    // 空からも差分で書ける
    await repo.projections.save(before, foldChanges(log.events).changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(before));

    const n = log.events.length;
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'r3', anchors: { inReplyTo: '<m1>' } }));
    log.push([dismissed(Object.keys(before.threads).sort()[1]!)], AT);
    const { projections, changes } = foldChanges(log.events.slice(n), before);
    expect(changes.signalIds).toHaveLength(1); // 前からあるシグナルは書き直さない
    await repo.projections.save(projections, changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(log.state()));
    await repo.projections.clear();
  });

  it('1 文に収まらない行数も書ける（D1 はバインド変数が 1 文 100 個まで）', async () => {
    const before = (await repo.events.read()).length;
    const many = Array.from({ length: 30 }, (_, i) => dismissed(`m${i}`));
    const stored = await repo.events.append(before, many, AT);
    expect(stored.map((e) => e.seq)).toEqual(many.map((_, i) => before + i + 1));
    expect((await repo.events.read(before)).length).toBe(30);
    // 先に誰かが書いていれば、何行あっても 1 行も入らない
    await expect(repo.events.append(before, many, AT)).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await repo.events.read()).length).toBe(before + 30);

    const log = new EventLog();
    const ctx = makeCtx(AT);
    for (let i = 0; i < 40; i++) ingestPure(log, ctx, email({ from: `c${i}@example.com`, sourceRef: `r${i}` }), () => answer({ title: `件 ${i}` }));
    const p = log.state();
    await repo.projections.save(p);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(p));
    await repo.projections.clear();
    await repo.projections.save(p, foldChanges(log.events).changes);
    expect(canonicalJson(await repo.projections.load())).toBe(canonicalJson(p));
    await repo.projections.clear();
  });

  it('マスタを丸ごと入れ替えて読み出せる', async () => {
    await repo.master.replaceSeed(seed);
    expect(await repo.master.loadSeed()).toEqual(seed);
  });

  it('H3 マスタの差分を当てると、読み出したマスタはその場で書き換えたものと同じで、変更の記録が残る（0030 の 5）', async () => {
    await repo.master.replaceSeed(seed);
    const { after, changes } = planMasterEdit(seed, (d) => {
      d.contacts.push({ id: 'p_frank', name: 'Frank', externalRefs: {} });
      d.addresses.push({ id: 'a_frank', channel: 'email', value: 'frank@example.com', contactId: 'p_frank' });
      d.contacts.find((c) => c.id === 'p_carol')!.name = 'Carol（田中ビル）';
      d.listMembers = d.listMembers.filter((m) => !(m.listId === 'l_line' && m.userId === 'u_bob'));
    });
    expect(changes.map((c) => [c.kind, c.key, c.before === null ? 'add' : c.after === null ? 'remove' : 'update'])).toEqual([
      ['contacts', 'p_carol', 'update'],
      ['contacts', 'p_frank', 'add'],
      ['addresses', 'a_frank', 'add'],
      ['listMembers', 'l_line|u_bob', 'remove'],
    ]);
    await repo.master.applyChanges(changes, { at: AT, actorUserId: 'u_alice', reason: '名寄せ' });
    expect(await repo.master.loadSeed()).toEqual(after);
    const log = await repo.master.changeLog();
    expect(log.map((r) => [r.kind, r.key, r.actorUserId, r.reason])).toEqual(changes.map((c) => [c.kind, c.key, 'u_alice', '名寄せ']));
    expect(log[0]).toMatchObject({ at: AT, before: { name: 'Carol（顧客）' }, after: { name: 'Carol（田中ビル）' } });
  });
});
