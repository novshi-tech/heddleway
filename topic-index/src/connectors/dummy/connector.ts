import type { Channel, DataSource, InboundItem } from '../../domain';
import type { Connector, Cursor } from '../types';

/** ダミー上流の受信キュー。メモリ版と DB 版がある */
export interface DummyBackend {
  enqueue(item: InboundItem): Promise<void>;
  /** データソースの未取得のシグナル・写しを、積んだ順に取り出す */
  take(dataSourceId: string): Promise<InboundItem[]>;
}

/** ダミーコネクタ。pull はキューから返すだけ */
export class DummyConnector implements Connector {
  constructor(
    readonly channel: Channel,
    private readonly backend: DummyBackend,
  ) {}

  async pull(source: DataSource, _cursor: Cursor) {
    const items = await this.backend.take(source.id);
    return { items, cursor: null };
  }
}

export class MemoryDummyBackend implements DummyBackend {
  readonly queue: InboundItem[] = [];

  async enqueue(item: InboundItem) {
    this.queue.push(item);
  }

  async take(dataSourceId: string) {
    const taken: InboundItem[] = [];
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i]!;
      if (item.dataSourceId === dataSourceId) {
        taken.push(item);
        this.queue.splice(i, 1);
      } else i++;
    }
    return taken;
  }
}
