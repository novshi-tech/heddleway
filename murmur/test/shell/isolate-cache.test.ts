import { drizzle } from 'drizzle-orm/d1';
import { afterAll, describe, expect, it } from 'vitest';
import { MurmurService } from '../../src/app/service';
import { connectTaskList, fold, renameUser, type InboundMirror } from '../../src/domain';
import { d1Repo, type Db } from '../../src/store/d1';
import { localD1Raw } from '../../scripts/lib/d1';
import { makeService } from '../helpers/service';
import { seed } from '../helpers/world';

// isolate の中の写し（投影とマスタ）。全件を読むのは isolate で初めてのときと、保存先が消された・戻ったときだけで、
// ほかの isolate が先に進めた分はイベントから追いつく（D1 の rows_read を、呼ぶ回数ではなく増えた分だけにする）

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** 同じ D1 を別のバインディング（別の isolate）として見せ、投影とマスタを全件読む文を数える（drizzle の batch は 1 文を 2 回 prepare するので、回数ではなく増えたかを見る） */
function isolate(d1: D1Database) {
  const counts = { projections: 0, master: 0 };
  const wrapped = new Proxy(d1, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'prepare')
        return (query: string) => {
          if (/^\s*select\b[^]*\bfrom\s+"?signals"?(?![_\w])/i.test(query)) counts.projections++;
          if (/^\s*select\b[^]*\bfrom\s+"?master"?(?![_\w])/i.test(query)) counts.master++;
          return target.prepare(query);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
  return { repo: d1Repo(drizzle(wrapped) as Db), counts };
}

describe('H1 isolate の中の写し（D1）', () => {
  it('2 回目からは全件を読まない。ほかの isolate が進めた分・マスタの書き換え・消された保存先にも追いつく', async () => {
    const { d1, close } = await localD1Raw();
    closers.push(close);
    const a = isolate(d1);
    const b = isolate(d1);
    const made = await makeService(seed, { repo: a.repo });
    const svcA = made.service;
    const svcB = new MurmurService({ ...made.service.deps, repo: b.repo });

    const { result } = await svcA.changeMaster('u_bob', 'To Do をつなぐ', (d, c) =>
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

    await svcA.mirror(mirror('A'));
    await svcA.mirror(mirror('A')); // 変わらない（重複）
    const afterFirst = { ...a.counts };
    await svcA.mirror(mirror('A2'));
    await svcA.state();
    expect(a.counts).toEqual(afterFirst); // A の 2 回目からは全件を読まない

    await svcB.mirror(mirror('B')); // ほかの isolate が先に進める
    await svcB.changeMaster('u_bob', '名前を付ける', (d) => renameUser(d, 'u_bob', 'ボブ'));
    const beforeCatchUp = { ...a.counts };
    await svcA.mirror(mirror('C'));
    expect(a.counts.projections).toBe(beforeCatchUp.projections); // 投影はイベントから追いつく
    expect(a.counts.master).toBeGreaterThan(beforeCatchUp.master); // マスタは版が変わったので読み直す
    expect((await svcA.directory()).seed.users.find((u) => u.id === 'u_bob')?.name).toBe('ボブ');

    const events = await a.repo.events.read();
    const state = await svcA.state();
    expect(Object.values(state.threads).map((t) => t.sourceKey).sort()).toEqual(['A', 'A2', 'B', 'C']);
    expect(state).toEqual(fold(events));
    expect(await svcB.state()).toEqual(state);

    // 保存先が消されたら（作り直し・seed）、写しを捨てて読み直し、イベントから作る
    await b.repo.projections.clear();
    const loadsBefore = a.counts.projections;
    expect(await svcA.state()).toEqual(fold(events));
    expect(a.counts.projections).toBeGreaterThan(loadsBefore);
  });

  it('返した投影を書き換えても、写しは変わらない', async () => {
    const { d1, close } = await localD1Raw();
    closers.push(close);
    const a = isolate(d1);
    const made = await makeService(seed, { repo: a.repo });
    const first = await made.service.state();
    first.lastSeq = 999;
    first.threads['thr_x'] = {} as never;
    const second = await made.service.state();
    expect(second.lastSeq).not.toBe(999);
    expect(second.threads['thr_x']).toBeUndefined();
    const seedA = await made.service.directory();
    seedA.seed.users.length = 0;
    expect((await made.service.directory()).seed.users.length).toBeGreaterThan(0);
  });
});
