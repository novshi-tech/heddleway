import { applyMasterChanges, emptyProjections, parseEvent, Seed, type DomainEvent, type DraftEvent, type MasterChange, type ProjectionChanges, type Projections } from '../domain';
import { ConcurrencyError, type EventStore, type MasterChangeRecord, type MasterStore, type ProjectionStore, type Repo } from './types';

/** テスト・CLI 用のインメモリ実装 */
export class MemoryEventStore implements EventStore {
  private events: DomainEvent[] = [];

  async append(expectedLastSeq: number, drafts: readonly DraftEvent[], at: string): Promise<DomainEvent[]> {
    const last = this.events.at(-1)?.seq ?? 0;
    if (last !== expectedLastSeq) throw new ConcurrencyError(expectedLastSeq);
    const stored = drafts.map((d, i) => parseEvent({ seq: last + i + 1, at, type: d.type, payload: structuredClone(d.payload) }));
    this.events = [...this.events, ...stored];
    return stored;
  }

  async read(afterSeq = 0): Promise<DomainEvent[]> {
    return this.events.filter((e) => e.seq > afterSeq).map((e) => structuredClone(e));
  }
}

export class MemoryProjectionStore implements ProjectionStore {
  private saved: Projections | null = null;
  async load() {
    return this.saved ? structuredClone(this.saved) : null;
  }
  /**
   * 差分は保存済みのものに当てる（差分の取りこぼしがあれば、読み出した投影がリプレイと食い違って H1 で見つかる）。
   * 差分の保存は「土台 ≤ 保存済みの lastSeq < 新しい lastSeq」のときだけ当てる（保存がなければ保存済みは 0）:
   * - 古い版を持つ書き手の保存が遅れて着いても、投影を戻さない（新しい lastSeq 以下は捨てる）
   * - 消した直後の空の保存先に、古い土台からの差分が着いても、足りない行のまま lastSeq だけ進めない（土台が保存済みより先なら捨てる）
   * 捨てた保存はエラーにしない。次の state() が保存済みの lastSeq からイベントで追いつく。
   * changes がなければ丸ごと入れ替える（作り直しのとき。入れ替えは 1 度で済み、途中の空の状態はない）
   */
  async save(p: Projections, changes?: ProjectionChanges) {
    if (!changes) {
      this.saved = structuredClone(p);
      return;
    }
    const stored = this.saved?.lastSeq ?? 0;
    if (!(changes.baseSeq <= stored && stored < p.lastSeq)) return;
    const saved = (this.saved ??= emptyProjections());
    saved.lastSeq = p.lastSeq;
    if (changes.index) saved.index = structuredClone(p.index);
    for (const id of changes.threadIds) saved.threads[id] = structuredClone(p.threads[id]!);
    for (const id of changes.signalIds) saved.signals[id] = structuredClone(p.signals[id]!);
  }
  async clear() {
    this.saved = null;
  }
}

export class MemoryMasterStore implements MasterStore {
  private seed: Seed = Seed.parse({
    users: [],
    contacts: [],
    addresses: [],
    lists: [],
    listMembers: [],
    attributeDefs: [],
  });
  async loadSeed() {
    return structuredClone(this.seed);
  }
  private log: MasterChangeRecord[] = [];
  async replaceSeed(seed: Seed) {
    this.seed = structuredClone(seed);
  }
  async applyChanges(changes: readonly MasterChange[], meta: { at: string; actorUserId: string | null; reason?: string }) {
    this.seed = applyMasterChanges(this.seed, changes);
    for (const c of changes) {
      this.log.push({ ...structuredClone(c), id: this.log.length + 1, at: meta.at, actorUserId: meta.actorUserId, reason: meta.reason ?? null });
    }
  }
  async changeLog() {
    return structuredClone(this.log);
  }
}

export function memoryRepo(): Repo {
  return { events: new MemoryEventStore(), projections: new MemoryProjectionStore(), master: new MemoryMasterStore() };
}
