import { and, eq } from 'drizzle-orm';
import type { InboundItem } from '../../domain';
import type { Db } from '../../store/d1';
import { dummyQueue } from '../../store/schema';
import type { DummyBackend } from './connector';

/** Worker 上で動かすときのダミー上流（D1 のテーブルに置く） */
export class D1DummyBackend implements DummyBackend {
  constructor(private readonly db: Db) {}

  async enqueue(item: InboundItem) {
    await this.db.insert(dummyQueue).values({ dataSourceId: item.dataSourceId, message: item });
  }

  /** 取り出しと消費済みの印を 1 文で行う（RETURNING の順は決まらないので積んだ順に並べ直す） */
  async take(dataSourceId: string) {
    const rows = await this.db
      .update(dummyQueue)
      .set({ consumed: true })
      .where(and(eq(dummyQueue.dataSourceId, dataSourceId), eq(dummyQueue.consumed, false)))
      .returning();
    return rows.sort((a, b) => a.id - b.id).map((r) => r.message as InboundItem);
  }
}
