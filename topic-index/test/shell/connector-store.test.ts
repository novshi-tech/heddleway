import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMailbox, Directory, planMasterEdit, seedProblems, type MailboxPlan } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { D1ConnectorState, MemoryConnectorState, type ConnectorStateStore } from '../../src/store/connector-state';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { localD1 } from '../../scripts/lib/d1';
import { counterIds } from '../helpers/service';
import { seed } from '../helpers/world';

// 取り込みの運用の状態とマスタの追記（0024）。メモリ実装と D1 実装（Miniflare）に同じ契約テストを当てる

let close: (() => Promise<void>) | undefined;
const impls: [string, () => Promise<{ state: ConnectorStateStore; repo: Repo }>][] = [
  ['memory', async () => ({ state: new MemoryConnectorState(), repo: memoryRepo() })],
  [
    'd1',
    async () => {
      const d = await localD1();
      close = d.close;
      return { state: new D1ConnectorState(d.db), repo: d1Repo(d.db) };
    },
  ],
];

describe.each(impls)('H3 運用の状態のストア（%s）', (_name, make) => {
  let state: ConnectorStateStore;
  let repo: Repo;
  beforeAll(async () => {
    ({ state, repo } = await make());
  });
  afterAll(async () => {
    await close?.();
    close = undefined;
  });

  it('同意の途中は 1 回だけ取り出せ、古いものは取り出せない', async () => {
    await state.putPending({ state: 's1', userId: 'u', verifier: 'v', credentialId: null, createdAt: '2026-10-30T00:00:00Z' });
    await state.putPending({ state: 's2', userId: 'u', verifier: 'v', credentialId: 'c', createdAt: '2026-10-29T00:00:00Z' });
    expect(await state.takePending('s1', '2026-10-29T23:45:00Z')).toMatchObject({ userId: 'u', verifier: 'v' });
    expect(await state.takePending('s1', '2026-10-29T23:45:00Z')).toBeNull();
    expect(await state.takePending('s2', '2026-10-29T23:45:00Z')).toBeNull();
  });

  it('データソースの状態とサブスクリプションの台帳', async () => {
    const s = { dataSourceId: 'ds', userId: 'u', gatewayCredentialId: 'g', status: 'ok' as const, reason: null, folders: { inbox: { link: 'l', lastReceivedAt: null } }, connectedAt: 't', lastSyncAt: null, lastRetryAt: null };
    await state.putSource(s);
    await state.putSource({ ...s, status: 'broken', reason: 'x' });
    expect(await state.sources()).toEqual([{ ...s, status: 'broken', reason: 'x' }]);
    await state.putSubscription({ id: 'sub1', dataSourceId: 'ds', folder: 'inbox', clientStateHash: 'h', expiresAt: 'e' });
    await state.putSubscription({ id: 'sub2', dataSourceId: 'other', folder: 'inbox', clientStateHash: 'h', expiresAt: 'e' });
    expect((await state.subscriptions('ds')).map((x) => x.id)).toEqual(['sub1']);
    await state.deleteSubscription('sub1');
    expect(await state.subscription('sub1')).toBeNull();
  });

  it('H3 個人の箱をつないだマスタの差分を当てても、seed の順と整合が保たれ、取り込みの経路（connector）も残る', async () => {
    await repo.master.replaceSeed(seed);
    let plan!: MailboxPlan;
    const newId = counterIds();
    const { changes } = planMasterEdit(seed, (d) => {
      plan = connectMailbox(d, { dir: new Directory(d), now: '2026-10-30T00:00:00.000Z', newId }, { userId: 'u_bob', gatewayCredentialId: 'g', displayName: 'Bob', addresses: ['bob@ubs.example'] });
    });
    await repo.master.applyChanges(changes, { at: '2026-10-30T00:00:00.000Z', actorUserId: 'u_bob', reason: 'Outlook をつなぐ' });
    const loaded = await repo.master.loadSeed();
    expect(loaded.dataSources.at(-1)).toEqual(plan.dataSource);
    expect(loaded.dataSources.slice(0, -1)).toEqual(seed.dataSources);
    expect(seedProblems(loaded)).toEqual([]);
  });
});
