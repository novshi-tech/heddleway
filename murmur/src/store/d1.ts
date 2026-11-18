import { and, asc, desc, eq, gte, gt, inArray, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  emptyProjections,
  indexOfSignals,
  parseEvent,
  signalKeysOf,
  pendingNamedKeys,
  crossKeysOfSignals,
  type ThreadScopeRequest,
  type ListScopeRequest,
  addressKey,
  threadColumns,
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
  type WorkingSetRequest,
  indexKey,
} from '../domain';
import { deepFreeze } from './freeze';
import * as schema from './schema';
import { ConcurrencyError, type EventStore, type MasterChangeRecord, type MasterStore, type ProjectionStore, type Repo } from './types';

// D1 実装（0021）。本番は Worker の D1 バインディング、テストは Miniflare の D1 で同じコードを通す。
// D1 には対話的なトランザクションがない。原子的にまとめられるのは batch() だけ（1 文でも失敗すれば全体が戻る）。
// バインド変数は 1 文あたり 100 個までなので、複数行の挿入は行の列数で割って分ける。

export type Db = DrizzleD1Database & { $client: D1Database };

const MAX_PARAMS = 100;

/** IN (...) に並べる ID の数（バインド変数の上限の内側） */
function chunkIds(ids: readonly string[], size = 90): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

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

/** projection_meta.idx に書く空の索引（列は 0046 より前のコードのために残す。schema.ts） */
const EMPTY_INDEX: Projections['index'] = { sourceRefs: {}, messageIds: {} };

/**
 * isolate の中の写し（投影とマスタ）。D1 のバインディングごとに 1 つ。
 * 投影は全件を読むと行数ぶん rows_read を食う（取り込みの 1 件ごと・API の 1 回ごとに読むので、見回りだけで 1 日数百万行になる）。
 * 写しを持っていれば、確かめるのは projection_meta の 1 行だけにし、足りないイベントは呼び手（state()）が追記から追いつく。
 * 写しは凍らせて、コピーせずにそのまま返す（呼び手は読むだけ。fold は自分でコピーしてから畳む。書き換えれば TypeError）
 */
interface IsolateCache {
  /** イベントを lastSeq まで畳んだ投影（保存できたかに関わらず、イベントからの正しい fold） */
  projections?: Projections;
  /** マスタと、読んだときの変更の記録の最大の id */
  seed?: { version: number; seed: Seed };
}

const caches = new WeakMap<object, IsolateCache>();

function cacheOf(db: Db): IsolateCache {
  const key = db.$client as object;
  let c = caches.get(key);
  if (!c) caches.set(key, (c = {}));
  return c;
}

/** 写しから追いつくイベントがこれより多ければ、全件を読み直す（追いつくほうが重い） */
const MAX_CATCH_UP = 500;

export class D1ProjectionStore implements ProjectionStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<Projections | null> {
    const cache = cacheOf(this.db);
    const cached = cache.projections;
    if (cached) {
      // 保存済みの lastSeq だけを見る。写しより先に進んでいれば、写しを返して呼び手が追記から追いつく
      //（差分の保存は「土台 ≤ 保存済み < 新しい lastSeq」なので、古い土台からの保存も正しく書くか弾かれる）。
      // 保存先が消された・戻った（作り直し・seed）なら写しを捨てる
      const [meta] = await this.db.select({ lastSeq: schema.projectionMeta.lastSeq }).from(schema.projectionMeta).where(eq(schema.projectionMeta.id, META_ID));
      if (meta && meta.lastSeq >= cached.lastSeq && meta.lastSeq - cached.lastSeq <= MAX_CATCH_UP) return cached;
      cache.projections = undefined;
    }
    const p = await this.loadAll();
    if (p) cache.projections = deepFreeze(p);
    return p;
  }

  private async loadAll(): Promise<Projections | null> {
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
    for (const r of threads) p.threads[r.id] = r.data as Thread;
    for (const r of signals) p.signals[r.id] = r.data as SignalRecord;
    // 索引はシグナルから作り直す（fold が積むのと同じ。meta.idx は読まない。0046 の決定 2）
    p.index = indexOfSignals(Object.values(p.signals));
    return p;
  }

  async save(p: Projections, changes?: ProjectionChanges, opts?: { partial?: boolean }): Promise<void> {
    if (changes) await this.saveChanges(p, changes);
    else await this.saveAll(p);
    // 作業範囲の上で畳んだもの（0046）は全件ではないので、写しにしない（写しは次の load で追記から追いつく）
    if (opts?.partial) return;
    // 保存が弾かれても p はイベントからの正しい fold なので、写しを進めてよい（p は呼び手の手を離れるので、その場で凍らせる）
    const cache = cacheOf(this.db);
    if (!cache.projections || p.lastSeq >= cache.projections.lastSeq) cache.projections = deepFreeze(p);
  }

  /**
   * 取り込みの作業範囲（0046 の決定 1）。意味は selectWorkingSet と同じ。往復は 3 回まで:
   * (1) lastSeq・索引の行・写しの区切りのスレッド・名指しの残るスレッド・窓のスレッド、
   * (2) 索引が指すシグナル、(3) それらのスレッドのうちまだ読んでいないものと、読んだスレッドの全シグナル
   */
  async workingSet(req: WorkingSetRequest): Promise<Projections | null> {
    const ds = req.dataSourceId;
    const T = schema.threads;
    const K = schema.signalKeys;
    // 要るクエリだけ投げる（条件を偽にしても、並べ替えや走査で行を読むことがある）
    const reads: BatchItem<'sqlite'>[] = [this.db.select({ lastSeq: schema.projectionMeta.lastSeq }).from(schema.projectionMeta).where(eq(schema.projectionMeta.id, META_ID))];
    const tags: ('keys' | 'threads')[] = [];
    // 索引は種類ごとに value IN (…) で引く（主キー (data_source_id, kind, value) で引ける形。OR で並べると走査になる）
    const byKind = new Map<string, string[]>();
    for (const k of req.keys) byKind.set(k.kind, [...(byKind.get(k.kind) ?? []), k.value]);
    for (const [kind, values] of byKind) {
      reads.push(this.db.select().from(K).where(and(eq(K.dataSourceId, ds), eq(K.kind, kind), inArray(K.value, values))));
      tags.push('keys');
    }
    if (req.sourceKeys.length > 0) {
      reads.push(this.db.select().from(T).where(and(eq(T.dataSourceId, ds), inArray(T.sourceKey, req.sourceKeys))));
      tags.push('threads');
    }
    if (req.awaiting === 'all') {
      reads.push(this.db.select().from(T).where(and(eq(T.dataSourceId, ds), eq(T.namedPending, true))));
      tags.push('threads');
    } else if (req.awaiting) {
      const named = this.db
        .select({ id: schema.threadNamed.threadId })
        .from(schema.threadNamed)
        .where(and(eq(schema.threadNamed.dataSourceId, ds), eq(schema.threadNamed.addressKey, addressKey(req.awaiting.address))));
      reads.push(this.db.select().from(T).where(inArray(T.id, named)));
      tags.push('threads');
    }
    if (req.window) {
      reads.push(
        this.db
          .select()
          .from(T)
          .where(and(eq(T.dataSourceId, ds), gte(T.lastSignalAt, req.window.since)))
          .orderBy(desc(T.lastSignalAt), asc(T.id))
          .limit(req.window.limit),
      );
      tags.push('threads');
    }
    const [metas, ...rest] = (await batch(this.db, reads)) as [{ lastSeq: number }[], ...unknown[][]];
    const keys = rest.flatMap((rows, i) => (tags[i] === 'keys' ? (rows as (typeof K.$inferSelect)[]) : []));
    const threadRowsRead = rest.flatMap((rows, i) => (tags[i] === 'threads' ? (rows as (typeof T.$inferSelect)[]) : []));
    const meta = metas[0];
    if (!meta) return null;
    const out = emptyProjections();
    out.lastSeq = meta.lastSeq;
    for (const r of threadRowsRead) out.threads[r.id] = r.data as Thread;

    const keySignalIds = [...new Set(keys.map((k) => k.signalId))];
    for (const part of chunkIds(keySignalIds)) {
      for (const r of await this.db.select().from(schema.signals).where(inArray(schema.signals.id, part))) out.signals[r.id] = r.data as SignalRecord;
    }
    for (const k of keys) {
      if (!out.signals[k.signalId]) continue;
      if (k.kind === 'sourceRef') out.index.sourceRefs[indexKey(ds, k.value)] = k.signalId;
      if (k.kind === 'messageId') out.index.messageIds[indexKey(ds, k.value)] = k.signalId;
    }
    const missing = [...new Set(keySignalIds.map((id) => out.signals[id]?.threadId).filter((t): t is string => !!t && !out.threads[t]))];
    const threadIds = [...new Set([...Object.keys(out.threads), ...missing])];
    const more: BatchItem<'sqlite'>[] = [];
    for (const part of chunkIds(missing)) more.push(this.db.select().from(T).where(inArray(T.id, part)));
    for (const part of chunkIds(threadIds)) more.push(this.db.select().from(schema.signals).where(inArray(schema.signals.threadId, part)));
    const results = (await batch(this.db, more)) as { id: string; data: unknown; threadId?: string | null }[][];
    const missingParts = chunkIds(missing).length;
    results.forEach((rows, i) => {
      for (const r of rows) {
        if (i < missingParts) out.threads[r.id] = r.data as Thread;
        else out.signals[r.id] = r.data as SignalRecord;
      }
    });
    return out;
  }

  /** 期限の見回りの作業範囲（selectOverdueSet と同じ意味。reply_due の索引で引く） */
  async overdueSet(before: string): Promise<Projections | null> {
    const T = schema.threads;
    const [metas, rows] = await this.db.batch([
      this.db.select({ lastSeq: schema.projectionMeta.lastSeq }).from(schema.projectionMeta).where(eq(schema.projectionMeta.id, META_ID)),
      this.db.select().from(T).where(sql`${T.replyDue} IS NOT NULL AND ${T.replyDue} < ${before}`),
    ]);
    const meta = metas[0];
    if (!meta) return null;
    const out = emptyProjections();
    out.lastSeq = meta.lastSeq;
    for (const r of rows) out.threads[r.id] = r.data as Thread;
    // 期限超過を畳むとスレッドを保存し直す（キーの行はシグナルから作る）ので、シグナルも読む
    await this.addSignalsOf(out, Object.keys(out.threads));
    return out;
  }

  /** スレッドのシグナルを全部読み足す */
  private async addSignalsOf(out: Projections, threadIds: readonly string[]): Promise<void> {
    const parts = chunkIds([...new Set(threadIds)]);
    const results = (await batch(this.db, parts.map((ids) => this.db.select().from(schema.signals).where(inArray(schema.signals.threadId, ids))))) as {
      id: string;
      data: unknown;
    }[][];
    for (const r of results.flat()) out.signals[r.id] = r.data as SignalRecord;
  }

  /** スレッドの行を ID で読む（まだ範囲にないものだけ） */
  private async addThreads(out: Projections, ids: readonly string[]): Promise<string[]> {
    const want = [...new Set(ids)].filter((id) => !out.threads[id]);
    const results = (await batch(this.db, chunkIds(want).map((part) => this.db.select().from(schema.threads).where(inArray(schema.threads.id, part))))) as {
      id: string;
      data: unknown;
    }[][];
    for (const r of results.flat()) out.threads[r.id] = r.data as Thread;
    return want.filter((id) => out.threads[id]);
  }

  /** キーを共有するスレッド（thread_keys）。返すのは key → スレッドの ID */
  private async threadsWithKeys(keys: readonly string[]): Promise<{ threadId: string; key: string }[]> {
    const K = schema.threadKeys;
    const results = (await batch(
      this.db,
      chunkIds([...new Set(keys)]).map((part) => this.db.select({ threadId: K.threadId, key: K.key }).from(K).where(inArray(K.key, part))),
    )) as { threadId: string; key: string }[][];
    return results.flat();
  }

  private async keysOfThreads(ids: readonly string[]): Promise<{ threadId: string; key: string }[]> {
    const K = schema.threadKeys;
    const results = (await batch(
      this.db,
      chunkIds([...new Set(ids)]).map((part) => this.db.select({ threadId: K.threadId, key: K.key }).from(K).where(inArray(K.threadId, part))),
    )) as { threadId: string; key: string }[][];
    return results.flat();
  }

  private async meta(): Promise<number | null> {
    const [m] = await this.db.select({ lastSeq: schema.projectionMeta.lastSeq }).from(schema.projectionMeta).where(eq(schema.projectionMeta.id, META_ID));
    return m ? m.lastSeq : null;
  }

  /** 詳細と操作の範囲（0047 の決定 1。意味は selectThreadScope） */
  async threadScope(req: ThreadScopeRequest): Promise<Projections | null> {
    const lastSeq = await this.meta();
    if (lastSeq === null) return null;
    const out = emptyProjections();
    out.lastSeq = lastSeq;
    const primary = new Set(req.threadIds);
    const sigIds = [...new Set(req.signalIds ?? [])];
    if (sigIds.length > 0) {
      const results = (await batch(this.db, chunkIds(sigIds).map((ids) => this.db.select().from(schema.signals).where(inArray(schema.signals.id, ids))))) as {
        id: string;
        threadId: string | null;
        data: unknown;
      }[][];
      for (const r of results.flat()) {
        out.signals[r.id] = r.data as SignalRecord;
        if (r.threadId) primary.add(r.threadId);
      }
    }
    const found = await this.addThreads(out, [...primary]);
    if (req.links) await this.addThreads(out, found.flatMap((id) => out.threads[id]!.links.map((l) => l.threadId)));
    if (req.candidates) {
      const mine = (await this.keysOfThreads(found)).map((r) => r.key);
      await this.addThreads(out, (await this.threadsWithKeys(mine)).map((r) => r.threadId));
    }
    await this.addSignalsOf(out, Object.keys(out.threads));
    return out;
  }

  /** 一覧の範囲（0047 の決定 2。意味は selectListScope）。シグナルは読まず、キーを添える */
  async listScope(req: ListScopeRequest): Promise<Projections | null> {
    const lastSeq = await this.meta();
    if (lastSeq === null) return null;
    const out = emptyProjections();
    out.lastSeq = lastSeq;
    out.keys = {};
    const T = schema.threads;
    const results = (await batch(
      this.db,
      chunkIds(req.dataSourceIds).map((ds) =>
        this.db
          .select()
          .from(T)
          .where(req.openOnly ? and(inArray(T.dataSourceId, ds), eq(T.isOpen, true)) : inArray(T.dataSourceId, ds)),
      ),
    )) as { id: string; data: unknown }[][];
    const listed = results.flat().map((r) => r.id);
    for (const r of results.flat()) out.threads[r.id] = r.data as Thread;
    await this.addThreads(out, listed.flatMap((id) => out.threads[id]!.links.map((l) => l.threadId)));
    const listedSet = new Set(listed);
    const mineRows = await this.keysOfThreads(listed);
    for (const id of listed) out.keys[id] = [];
    for (const r of mineRows) out.keys[r.threadId]!.push(r.key);
    const shared = await this.threadsWithKeys(mineRows.map((r) => r.key));
    await this.addThreads(out, shared.map((r) => r.threadId));
    for (const r of shared) if (!listedSet.has(r.threadId)) out.keys[r.threadId] = [...(out.keys[r.threadId] ?? []), r.key];
    for (const id of Object.keys(out.threads)) out.keys[id] = [...new Set(out.keys[id] ?? [])].sort();
    return out;
  }

  async knownSourceRefs(dataSourceId: string, refs: readonly string[]): Promise<Set<string>> {
    const K = schema.signalKeys;
    const parts = chunkIds([...new Set(refs)]);
    const results = (await batch(
      this.db,
      parts.map((values) => this.db.select({ value: K.value }).from(K).where(and(eq(K.dataSourceId, dataSourceId), eq(K.kind, 'sourceRef'), inArray(K.value, values)))),
    )) as { value: string }[][];
    return new Set(results.flat().map((r) => r.value));
  }

  private async saveAll(p: Projections): Promise<void> {
    await batch(this.db, [
      ...this.deleteAll(),
      this.db.insert(schema.projectionMeta).values({ id: META_ID, lastSeq: p.lastSeq, idx: EMPTY_INDEX }),
      ...this.threadRows(p, Object.keys(p.threads)).map((rows) => this.db.insert(schema.threads).values(rows)),
      ...this.signalRows(p, Object.keys(p.signals)).map((rows) => this.db.insert(schema.signals).values(rows)),
      ...this.keyRows(p, Object.keys(p.signals)).map((rows) => this.db.insert(schema.signalKeys).values(rows)),
      ...this.namedRows(p, Object.keys(p.threads)).map((rows) => this.db.insert(schema.threadNamed).values(rows)),
      ...this.crossKeyRows(p, Object.keys(p.threads)).map((rows) => this.db.insert(schema.threadKeys).values(rows)),
    ]);
  }

  /**
   * 変わったスレッドとシグナルだけを upsert する（スレッドもシグナルも消えないので、消す行はない）。
   * 差分の保存は「土台 ≤ 保存済みの lastSeq < 新しい lastSeq」のときだけ書く（meta がなければ保存済みは 0）。
   * 書き込みは追記のあと（読み取りの追いつきも）別々に着くので、次の 2 つを守る:
   * - 古い版を持つ書き手の保存が遅れて着いて lastSeq が戻ると、先に進んだ行が残ったまま同じイベントをもう一度畳むことになる
   *   （スレッドを作るイベントなら「already exists」で投影が読めなくなる）
   * - 消した直後の空の保存先に、古い土台からの差分が着くと、差分の行だけで lastSeq が進み、残りのスレッドは作り直されない
   * 条件は行の挿入にも掛ける（`ON CONFLICT DO UPDATE` の WHERE は更新しか守らない）ので、各文は
   * `INSERT … SELECT … FROM (VALUES …) WHERE <条件> ON CONFLICT … DO UPDATE …` の形にする（WHERE があるので、
   * SQLite が ON を結合の条件と読み違えない）。条件は同じ batch（1 つのトランザクション）の中で保存済みの lastSeq を見て決め、
   * meta は最後に書く（どの文も書き換える前の lastSeq を見る）。弾かれた保存は何も書かない
   */
  private async saveChanges(p: Projections, changes: ProjectionChanges): Promise<void> {
    // lastSeq は整数（シェルが数える）。バインド変数を使わず、100 個の上限に数えない
    const base = Math.trunc(changes.baseSeq);
    const next = Math.trunc(p.lastSeq);
    const stored = `coalesce((SELECT last_seq FROM projection_meta WHERE id = ${META_ID}), 0)`;
    const cond = `${stored} >= ${base} AND ${stored} < ${next}`;
    // drizzle の batch はパラメータ付きの生 SQL を扱えないので、ここだけ D1 の API を直に使う（追記と同じ）
    const d1 = this.db.$client;
    const statements = [
      ...this.threadRows(p, changes.threadIds).map((rows) =>
        d1
          .prepare(
            `INSERT INTO threads (id, data_source_id, data, source_key, last_signal_at, named_pending, reply_due, is_open) SELECT column1, column2, column3, column4, column5, column6, column7, column8 FROM (VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}) WHERE ${cond} ON CONFLICT (id) DO UPDATE SET data_source_id = excluded.data_source_id, data = excluded.data, source_key = excluded.source_key, last_signal_at = excluded.last_signal_at, named_pending = excluded.named_pending, reply_due = excluded.reply_due, is_open = excluded.is_open`,
          )
          .bind(...rows.flatMap((r) => [r.id, r.dataSourceId, JSON.stringify(r.data), r.sourceKey, r.lastSignalAt, r.namedPending ? 1 : 0, r.replyDue, r.isOpen ? 1 : 0])),
      ),
      ...this.signalRows(p, changes.signalIds).map((rows) =>
        d1
          .prepare(
            `INSERT INTO signals (id, data_source_id, thread_id, data) SELECT column1, column2, column3, column4 FROM (VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}) WHERE ${cond} ON CONFLICT (id) DO UPDATE SET data_source_id = excluded.data_source_id, thread_id = excluded.thread_id, data = excluded.data`,
          )
          .bind(...rows.flatMap((r) => [r.id, r.dataSourceId, r.threadId, JSON.stringify(r.data)])),
      ),
      // 索引の行（0046 の決定 2）。同じ値は seq の大きいシグナルを指す（fold の上書きと同じ）
      ...this.keyRows(p, changes.signalIds).map((rows) =>
        d1
          .prepare(
            `INSERT INTO signal_keys (data_source_id, kind, value, signal_id, seq) SELECT column1, column2, column3, column4, column5 FROM (VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}) WHERE ${cond} ON CONFLICT (data_source_id, kind, value) DO UPDATE SET signal_id = excluded.signal_id, seq = excluded.seq WHERE excluded.seq >= signal_keys.seq`,
          )
          .bind(...rows.flatMap((r) => [r.dataSourceId, r.kind, r.value, r.signalId, r.seq])),
      ),
      // 外していない名指しの行（0046 の決定 3）。変わったスレッドの行を入れ替える
      ...chunkIds(changes.threadIds).map((ids) =>
        d1.prepare(`DELETE FROM thread_named WHERE thread_id IN (${ids.map(() => '?').join(', ')}) AND ${cond}`).bind(...ids),
      ),
      ...this.namedRows(p, changes.threadIds).map((rows) =>
        d1
          .prepare(
            `INSERT INTO thread_named (thread_id, address_key, data_source_id) SELECT column1, column2, column3 FROM (VALUES ${rows.map(() => '(?, ?, ?)').join(', ')}) WHERE ${cond} ON CONFLICT DO NOTHING`,
          )
          .bind(...rows.flatMap((r) => [r.threadId, r.addressKey, r.dataSourceId])),
      ),
      // アンカーのキーの行（0047 の決定 3）。変わったスレッドの行を入れ替える
      ...chunkIds(changes.threadIds).map((ids) =>
        d1.prepare(`DELETE FROM thread_keys WHERE thread_id IN (${ids.map(() => '?').join(', ')}) AND ${cond}`).bind(...ids),
      ),
      ...this.crossKeyRows(p, changes.threadIds).map((rows) =>
        d1
          .prepare(
            `INSERT INTO thread_keys (thread_id, key, data_source_id) SELECT column1, column2, column3 FROM (VALUES ${rows.map(() => '(?, ?, ?)').join(', ')}) WHERE ${cond} ON CONFLICT DO NOTHING`,
          )
          .bind(...rows.flatMap((r) => [r.threadId, r.key, r.dataSourceId])),
      ),
      d1
        .prepare(`INSERT INTO projection_meta (id, last_seq, idx) SELECT ${META_ID}, ${next}, ? WHERE ${cond} ON CONFLICT (id) DO UPDATE SET last_seq = excluded.last_seq`)
        .bind(JSON.stringify(EMPTY_INDEX)),
    ];
    await d1.batch(statements);
  }

  async clear(): Promise<void> {
    cacheOf(this.db).projections = undefined;
    await batch(this.db, this.deleteAll());
  }

  private deleteAll() {
    return [this.db.delete(schema.projectionMeta), this.db.delete(schema.threads), this.db.delete(schema.signals), this.db.delete(schema.signalKeys), this.db.delete(schema.threadNamed), this.db.delete(schema.threadKeys)];
  }

  private threadRows(p: Projections, ids: readonly string[]) {
    return chunks(
      ids.map((id) => {
        const t = p.threads[id]!;
        return { id, dataSourceId: t.dataSourceId, data: t, ...threadColumns(t) };
      }),
      8,
    );
  }

  /** 変わったスレッドのアンカーのキーの行。キーはスレッドのシグナルから作るので、範囲にそのシグナルがなければ書けない（例外にする） */
  private crossKeyRows(p: Projections, threadIds: readonly string[]) {
    return chunks(
      threadIds.flatMap((id) => {
        const t = p.threads[id]!;
        const missing = t.signalIds.filter((s) => !p.signals[s]);
        if (missing.length > 0) throw new Error(`thread ${id}: signals ${missing.join(', ')} are not in the saved range`);
        return crossKeysOfSignals(p, t).map((key) => ({ threadId: t.id, key, dataSourceId: t.dataSourceId }));
      }),
      3,
    );
  }

  private namedRows(p: Projections, threadIds: readonly string[]) {
    return chunks(
      threadIds.flatMap((id) => {
        const t = p.threads[id]!;
        return pendingNamedKeys(t).map((k) => ({ threadId: t.id, addressKey: k, dataSourceId: t.dataSourceId }));
      }),
      3,
    );
  }

  private keyRows(p: Projections, signalIds: readonly string[]) {
    // 同じ値は seq の大きいシグナルだけ残す（1 つの文に同じ主キーを 2 度入れない）
    const latest = new Map<string, { dataSourceId: string; kind: string; value: string; signalId: string; seq: number }>();
    for (const id of signalIds) {
      const s = p.signals[id]!;
      for (const k of signalKeysOf(s)) {
        const key = `${s.dataSourceId}\n${k.kind}\n${k.value}`;
        const prev = latest.get(key);
        if (!prev || s.seq > prev.seq) latest.set(key, { dataSourceId: s.dataSourceId, kind: k.kind, value: k.value, signalId: s.signalId, seq: s.seq });
      }
    }
    return chunks([...latest.values()], 5);
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

  /**
   * マスタの書き換えは必ず変更の記録に 1 行足す（applyChanges）ので、記録の最大の id（主キーの末尾なので 1 行）を版にして写しを確かめる。
   * 記録を残さない入れ替え（replaceSeed）は、同じ isolate なら写しを捨て、別のプロセス（seed のスクリプト）なら記録も消すので版が変わる
   */
  async loadSeed(): Promise<Seed> {
    const cache = cacheOf(this.db);
    const [row] = await this.db.select({ version: sql<number | null>`max(${schema.masterChanges.id})` }).from(schema.masterChanges);
    const version = row?.version ?? 0;
    if (cache.seed && cache.seed.version === version) return cache.seed.seed;
    const rows = await this.db.select().from(schema.master).orderBy(asc(schema.master.kind), asc(schema.master.ord));
    const raw: Record<string, unknown[]> = Object.fromEntries(SEED_KINDS.map((k) => [k, []]));
    for (const r of rows) raw[r.kind]?.push(r.data);
    const seed = deepFreeze(Seed.parse(raw));
    cache.seed = { version, seed };
    return seed;
  }

  async replaceSeed(seed: Seed): Promise<void> {
    cacheOf(this.db).seed = undefined;
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
