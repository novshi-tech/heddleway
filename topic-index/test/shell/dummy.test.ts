import { describe, expect, it } from 'vitest';
import { DummyConnector, MemoryDummyBackend } from '../../src/connectors/dummy/connector';
import { D1DummyBackend } from '../../src/connectors/dummy/d1-backend';
import type { InboundSignal } from '../../src/domain';
import { localD1 } from '../../scripts/lib/d1';
import { dir } from '../helpers/world';

const sig = (sourceRef: string, dataSourceId = 'ds_support'): InboundSignal => ({
  dataSourceId,
  channel: 'email',
  from: { channel: 'email', value: 'a@x' },
  to: [],
  body: 'b',
  sourceRef,
});

describe.each([
  ['memory', async () => new MemoryDummyBackend()],
  ['d1', async () => new D1DummyBackend((await localD1()).db)],
])('DummyConnector（%s）', (_n, make) => {
  it('pull はデータソースごとに、キューから一度だけ返す', async () => {
    const backend = await make();
    const c = new DummyConnector('email', backend);
    await backend.enqueue(sig('1'));
    await backend.enqueue(sig('2', 'ds_alice'));
    await backend.enqueue(sig('3'));
    expect((await c.pull(dir.dataSource('ds_support')!, null)).items.map((s) => ('sourceRef' in s ? s.sourceRef : ''))).toEqual(['1', '3']);
    expect((await c.pull(dir.dataSource('ds_support')!, null)).items).toEqual([]);
    expect((await c.pull(dir.dataSource('ds_alice')!, null)).items.map((s) => ('sourceRef' in s ? s.sourceRef : ''))).toEqual(['2']);
  });
});
