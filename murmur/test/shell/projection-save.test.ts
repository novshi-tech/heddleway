import { afterAll, describe, expect, it } from 'vitest';
import { connectTaskList, fold, type InboundMirror } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { localD1 } from '../../scripts/lib/d1';
import { makeService } from '../helpers/service';
import { seed } from '../helpers/world';

// 投影の保存は追記のあとに別々に着く（追記した書き手の保存、読み取りの追いつきの保存）。
// 古い版を持つ書き手の保存が遅れて着いても、保存済みの投影を戻さない（lastSeq が戻ると、先に進んだ行が残ったまま
// 同じイベントをもう一度畳み、スレッドを作るイベントなら「already exists」で投影が読めなくなる）

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const impls: [string, () => Promise<Repo>][] = [
  ['memory', async () => memoryRepo()],
  [
    'd1',
    async () => {
      const { db, close } = await localD1();
      closers.push(close);
      return d1Repo(db);
    },
  ],
];

describe.each(impls)('H1 投影の保存は単調（%s）', (_n, make) => {
  it('遅れて着いた古い保存は捨てる。そのあとも書けて、投影はイベントからの作り直しと一致する', async () => {
    const base = await make();
    // 最初の保存（1 つめの書き手のもの）を止めておき、あとで着かせる
    let late: (() => Promise<void>) | null = null;
    let saves = 0;
    const repo: Repo = {
      ...base,
      projections: {
        load: () => base.projections.load(),
        clear: () => base.projections.clear(),
        save: async (p, c) => {
          if (++saves === 1) {
            late = () => base.projections.save(p, c);
            return;
          }
          return base.projections.save(p, c);
        },
      },
    };
    const made = await makeService(seed, { repo });
    const { result } = await made.service.changeMaster('u_bob', 'To Do をつなぐ', (d, c) =>
      connectTaskList(d, c, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', address: 'bob.todo@ubs.example', listId: 'L', listName: 'Murmur' }),
    );
    const ds = result.dataSource.id;
    const mirror = (key: string): InboundMirror => ({
      kind: 'mirror',
      dataSourceId: ds,
      channel: 'todo',
      threadKey: key,
      fields: { closed: false, holders: ['bob.todo@ubs.example'], title: key, statusLabel: 'Murmur', due: null },
      sourceRef: key,
    });
    await made.service.mirror(mirror('A')); // この保存が遅れる
    await made.service.mirror(mirror('B')); // 読み取りの追いつき（A の分）をして B を書く
    await late!(); // A の書き手の古い保存が、いまごろ着く
    await made.service.mirror(mirror('C'));

    const state = await made.service.state();
    expect(Object.values(state.threads).map((t) => t.sourceKey).sort()).toEqual(['A', 'B', 'C']);
    expect(state.lastSeq).toBe((await base.events.read()).length);
    expect(state).toEqual(fold(await base.events.read()));
    await made.service.rebuild();
    expect(await made.service.state()).toEqual(state);
  });
});
