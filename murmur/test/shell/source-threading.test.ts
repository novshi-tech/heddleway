import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, Seed } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { localD1 } from '../../scripts/lib/d1';
import { email, line, seed } from '../helpers/world';
import { makeService } from '../helpers/service';

// AI を使わない区切り（0050）を、保存先（メモリと D1）まで通して確かめる。AI は呼ばない（makeService の Decider は呼ばれると失敗する）

const SOURCE = { ...DEFAULT_POLICY, threading: 'source' as const };
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

describe.each(impls)('H6 AI を使わない区切り（%s）', (_name, make) => {
  it('H6 同じソースのスレッドは索引（signal_keys）で引けて続きに入り、違えば新しいスレッド', async () => {
    const { service } = await makeService(seed, { repo: await make(), policy: SOURCE });
    const a = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', subject: '見積', anchors: { messageId: '<m1>', sourceThread: 'conv_a' } }));
    const b = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r2', subject: 'RE: 見積', anchors: { messageId: '<m2>', sourceThread: 'conv_a' } }));
    const c = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r3', subject: '請求', anchors: { messageId: '<m3>', sourceThread: 'conv_b' } }));
    expect(a).toMatchObject({ status: 'threaded', newThread: true, by: 'anchor' });
    expect(b).toMatchObject({ status: 'threaded', newThread: false, by: 'anchor', threadId: a.status === 'threaded' ? a.threadId : '' });
    expect(c).toMatchObject({ status: 'threaded', newThread: true });
  });

  it('H6 スレッドで区切れないリスト（LINE）のシグナルは取り込まない', async () => {
    const lineSeed = Seed.parse({
      ...seed,
      dataSources: seed.dataSources.map((d) => (d.id === 'ds_line' ? { ...d, connector: { kind: 'line', organizationId: 'org_1' } } : d)),
    });
    const { service, repo } = await makeService(lineSeed, { repo: await make(), policy: SOURCE });
    expect(await service.ingest(line({ from: 'U_carol', sourceRef: 'l1', anchors: { messageId: 'm1' } }))).toEqual({ status: 'unsupported', dataSourceId: 'ds_line' });
    expect(await repo.events.read()).toEqual([]);
  });
});
