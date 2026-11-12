import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  emptyProjections,
  parseEvent,
  rowKey,
  Seed,
  SEED_KINDS,
  type MasterChange,
  type SeedKind,
  type DomainEvent,
  type DraftEvent,
  type ProjectionChanges,
  type Projections,
  type SignalRecord,
  type Thread,
} from '../domain';
import * as schema from './schema';
import { ConcurrencyError, type EventStore, type MasterChangeRecord, type MasterStore, type ProjectionStore, type Repo } from './types';

// D1 実装（0021）。本番は Worker の D1 バインディング、テストは Miniflare の D1 で同じコードを通す。
// D1 には対話的なトランザクションがない。原子的にまとめられるのは batch() だけ（1 文でも失敗すれば全体が戻る）。
// バインド変数は 1 文あたり 100 個までなので、複数行の挿入は行の列数で割って分ける。

export type Db = DrizzleD1Database & { $client: D1Database };

const MAX_PARAMS = 100;

function chunks<T>(rows: readonly T[], paramsPerRow: number, reserved = 0): T[][] {
  const size = Math.max(1, Math.floor((MAX_PARAMS - reserved) / paramsPerRow));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** batch() は空でない組を要求するので、空なら何もしない */
async function batch(db: Db, items: BatchItem<'sqlite'>[]): Promise<unknown[]> {
  if (items.length === 0) return [];
  return db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (String((e as { message?: string }).message ?? '').includes('UNIQUE constraint failed')) return true;
  }
  return false;
}

export class D1EventStore implements EventStore {
  constructor(private readonly db: Db) {}

  /**
   * 各文は「最後の seq が期待どおりなら挿入する」。batch は 1 つのトランザクションなので、
   * 最初の文が 0 行なら他の書き込みが先にあった（楽観ロック）。続く文も同じ条件で 0 行になる
   */
  async append(expectedLastSeq: number, drafts: readonly DraftEvent[], at: string): Promise<DomainEvent[]> {
    if (drafts.length === 0) return [];
    const rows = drafts.map((d, i) => ({ seq: expectedLastSeq + i + 1, type: d.type, payload: d.payload, at }));
    // 書く前に検証する（不正な payload を残さない）
    const stored = rows.map((r) => parseEvent(r));
    // drizzle の batch はパラメータ付きの生 SQL を扱えないので、ここだけ D1 の API を直に使う
    const d1 = this.db.$client;
    const statements = chunks(rows, 4, 1).map((part) =>
      d1
        .prepare(
          `INSERT INTO events (seq, type, payload, at) SELECT column1, column2, column3, column4 FROM (VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}) WHERE (SELECT coalesce(max(seq), 0) FROM events) = ?`,
        )
        .bind(...part.flatMap((r) => [r.seq, r.type, JSON.stringify(r.payload), r.at]), part[0]!.seq - 1),
    );
    try {
      const [first] = await d1.batch(statements);
      if (first?.meta.changes === 0) throw new ConcurrencyError(expectedLastSeq);
    } catch (err) {
      if (err instanceof ConcurrencyError) throw err;
      if (isUniqueViolation(err)) throw new ConcurrencyError(expectedLastSeq);
      throw err;
    }
    return stored;
  }

  async read(afterSeq = 0): Promise<DomainEvent[]> {
    const rows = await this.db.select().from(schema.events).where(gt(schema.events.seq, afterSeq)).orderBy(asc(schema.events.seq));
    return rows.map((r) => parseEvent(r));
  }
}

const META_ID = 1;

export class D1ProjectionStore implements ProjectionStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<Projections | null> {
    // 1 往復で読む（Worker と DB の距離が往復の回数分効く）
    const [metas, threads, signals] = await this.db.batch([
      this.db.select().from(schema.projectionMeta).where(eq(schema.projectionMeta.id, META_ID)),
      this.db.select().from(schema.threads),
      this.db.select().from(schema.signals),
    ]);
    const meta = metas[0];
    if (!meta) return null;
    const p = emptyProjections();
    p.lastSeq = meta.lastSeq;
    p.index = meta.idx as Projections['index'];
    for (const r of threads) p.threads[r.id] = r.data as Thread;
    for (const r of signals) p.signals[r.id] = r.data as SignalRecord;
    return p;
  }

  async save(p: Projections, changes?: ProjectionChanges): Promise<void> {
    if (changes) return this.saveChanges(p, changes);
    await batch(this.db, [
      ...this.deleteAll(),
      this.db.insert(schema.projectionMeta).values({ id: META_ID, lastSeq: p.lastSeq, idx: p.index }),
      ...this.threadRows(p, Object.keys(p.threads)).map((rows) => this.db.insert(schema.threads).values(rows)),
      ...this.signalRows(p, Object.keys(p.signals)).map((rows) => this.db.insert(schema.signals).values(rows)),
    ]);
  }

  /**
   * 変わったスレッドとシグナルだけを upsert する（スレッドもシグナルも消えないので、消す行はない）。
   * 保存は単調: 保存済みの lastSeq 以下の投影は何も書かない。書き込みは追記のあと（読み取りの追いつきも）別々に着くので、
   * 古い版を持つ書き手の保存が遅れて着くと、lastSeq が戻り、先に進んだ行が残ったまま同じイベントをもう一度畳むことになる
   * （スレッドを作るイベントなら「already exists」で投影が読めなくなる）。守る条件は同じ batch（1 つのトランザクション）の中で、
   * 保存済みの lastSeq を見て決める。meta は最後に書く（行の条件が書き換える前の lastSeq を見るため）
   */
  private async saveChanges(p: Projections, changes: ProjectionChanges): Promise<void> {
    const meta = { id: META_ID, lastSeq: p.lastSeq, idx: p.index };
    // lastSeq は整数（シェルが数える）。バインド変数を使わず、100 個の上限に数えない
    const newer = sql.raw(`coalesce((SELECT last_seq FROM projection_meta WHERE id = ${META_ID}), -1) < ${Math.trunc(p.lastSeq)}`);
    await batch(this.db, [
      ...this.threadRows(p, changes.threadIds).map((rows) =>
        this.db
          .insert(schema.threads)
          .values(rows)
          .onConflictDoUpdate({ target: schema.threads.id, set: { dataSourceId: sql`excluded.data_source_id`, data: sql`excluded.data` }, setWhere: newer }),
      ),
      ...this.signalRows(p, changes.signalIds).map((rows) =>
        this.db
          .insert(schema.signals)
          .values(rows)
          .onConflictDoUpdate({
            target: schema.signals.id,
            set: { dataSourceId: sql`excluded.data_source_id`, threadId: sql`excluded.thread_id`, data: sql`excluded.data` },
            setWhere: newer,
          }),
      ),
      this.db
        .insert(schema.projectionMeta)
        .values(meta)
        .onConflictDoUpdate({
          target: schema.projectionMeta.id,
          set: changes.index ? { lastSeq: meta.lastSeq, idx: meta.idx } : { lastSeq: meta.lastSeq },
          setWhere: sql`excluded.last_seq > projection_meta.last_seq`,
        }),
    ]);
  }

  async clear(): Promise<void> {
    await batch(this.db, this.deleteAll());
  }

  private deleteAll() {
    return [this.db.delete(schema.projectionMeta), this.db.delete(schema.threads), this.db.delete(schema.signals)];
  }

  private threadRows(p: Projections, ids: readonly string[]) {
    return chunks(
      ids.map((id) => ({ id, dataSourceId: p.threads[id]!.dataSourceId, data: p.threads[id]! })),
      3,
    );
  }

  private signalRows(p: Projections, ids: readonly string[]) {
    return chunks(
      ids.map((id) => {
        const s = p.signals[id]!;
        return { id, dataSourceId: s.dataSourceId, threadId: s.threadId, data: s };
      }),
      4,
    );
  }
}

export class D1MasterStore implements MasterStore {
  constructor(private readonly db: Db) {}

  async loadSeed(): Promise<Seed> {
    const rows = await this.db.select().from(schema.master).orderBy(asc(schema.master.kind), asc(schema.master.ord));
    const raw: Record<string, unknown[]> = Object.fromEntries(SEED_KINDS.map((k) => [k, []]));
    for (const r of rows) raw[r.kind]?.push(r.data);
    return Seed.parse(raw);
  }

  async replaceSeed(seed: Seed): Promise<void> {
    const rows = SEED_KINDS.flatMap((kind) => (seed[kind] as unknown[]).map((data, ord) => ({ kind, key: rowKey(kind, data), ord, data })));
    await batch(this.db, [this.db.delete(schema.master), ...chunks(rows, 4).map((part) => this.db.insert(schema.master).values(part))]);
  }

  /** 差分と変更の記録を 1 つの batch で書く（どちらかが失敗すれば両方戻る） */
  async applyChanges(changes: readonly MasterChange[], meta: { at: string; actorUserId: string | null; reason?: string }): Promise<void> {
    if (changes.length === 0) return;
    const items: BatchItem<'sqlite'>[] = [];
    for (const c of changes) {
      const where = and(eq(schema.master.kind, c.kind), eq(schema.master.key, c.key));
      if (c.after === null) items.push(this.db.delete(schema.master).where(where));
      else if (c.before !== null) items.push(this.db.update(schema.master).set({ data: c.after }).where(where));
      else {
        items.push(
          this.db.insert(schema.master).values({
            kind: c.kind,
            key: c.key,
            ord: sql`(SELECT COALESCE(MAX(ord), -1) + 1 FROM master WHERE kind = ${c.kind})`,
            data: c.after,
          }),
        );
      }
    }
    const log = changes.map((c) => ({ at: meta.at, actorUserId: meta.actorUserId, reason: meta.reason ?? null, kind: c.kind, key: c.key, before: c.before, after: c.after }));
    items.push(...chunks(log, 7).map((part) => this.db.insert(schema.masterChanges).values(part)));
    await batch(this.db, items);
  }

  async changeLog(): Promise<MasterChangeRecord[]> {
    const rows = await this.db.select().from(schema.masterChanges).orderBy(asc(schema.masterChanges.id));
    return rows.map((r) => ({ ...r, kind: r.kind as SeedKind, before: r.before ?? null, after: r.after ?? null }));
  }
}

export function d1Repo(db: Db): Repo {
  return { events: new D1EventStore(db), projections: new D1ProjectionStore(db), master: new D1MasterStore(db) };
}
