import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import { crossKeysOfSignals, fold, indexOfSignals, pendingNamedKeys, signalKeysOf, threadColumns, type Projections } from '../../src/domain';
import { d1Repo, type Db } from '../../src/store/d1';
import { localD1Raw } from '../../scripts/lib/d1';
import { listScenarios, loadScenario, runScenario } from '../../scripts/lib/scenario';

// 0046 の決定 2: 索引（signal_keys）とスレッドの列は、投影（シグナルとスレッドの記録）だけから決まる。
// 差分の保存で書いた行も、マイグレーションで既存の行から埋めた行も、イベントから畳んだ投影から作ったものと一致する

type KeyRow = { data_source_id: string; kind: string; value: string; signal_id: string; seq: number };
type ThreadRow = { id: string; source_key: string | null; last_signal_at: string | null; named_pending: number; reply_due: string | null; is_open: number };
type CrossKeyRow = { thread_id: string; key: string; data_source_id: string };

function expectedKeys(p: Projections): KeyRow[] {
  const latest = new Map<string, KeyRow>();
  for (const s of Object.values(p.signals)) {
    for (const k of signalKeysOf(s)) {
      const key = `${s.dataSourceId}\n${k.kind}\n${k.value}`;
      const prev = latest.get(key);
      if (!prev || s.seq > prev.seq) latest.set(key, { data_source_id: s.dataSourceId, kind: k.kind, value: k.value, signal_id: s.signalId, seq: s.seq });
    }
  }
  return sortKeys([...latest.values()]);
}

const sortKeys = (rows: KeyRow[]) => [...rows].sort((a, b) => `${a.data_source_id}\n${a.kind}\n${a.value}`.localeCompare(`${b.data_source_id}\n${b.kind}\n${b.value}`));

type NamedRow = { thread_id: string; address_key: string; data_source_id: string };

async function rows(d1: D1Database) {
  const keys = (await d1.prepare('SELECT data_source_id, kind, value, signal_id, seq FROM signal_keys').all<KeyRow>()).results;
  const threads = (await d1.prepare('SELECT id, source_key, last_signal_at, named_pending, reply_due, is_open FROM threads ORDER BY id').all<ThreadRow>()).results;
  const named = (await d1.prepare('SELECT thread_id, address_key, data_source_id FROM thread_named ORDER BY thread_id, address_key').all<NamedRow>()).results;
  const crossKeys = (await d1.prepare('SELECT thread_id, key, data_source_id FROM thread_keys').all<CrossKeyRow>()).results.sort((a, b) =>
    `${a.thread_id}\n${a.key}`.localeCompare(`${b.thread_id}\n${b.key}`),
  );
  return { keys: sortKeys(keys), threads, named, crossKeys };
}

/** 0004 のうち、既存の行から列と索引を埋める文（「0046:」の注記より後ろ） */
function backfillStatements(): string[] {
  const read = (file: string, marker: string) => {
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle', file), 'utf8');
    return sql.slice(sql.indexOf(marker)).split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
  };
  return [...read('0004_ingest_working_set.sql', '-- 0046:'), ...read('0005_reply_due.sql', '-- 0046 の未決 3'), ...read('0006_query_scopes.sql', '-- 0047:')];
}

describe.each(listScenarios())('H1 索引の行とスレッドの列（%s）', (name) => {
  it('差分の保存で書いた行・作り直しの行・マイグレーションで埋めた行が、イベントから畳んだ投影と一致する', async () => {
    const { d1, close } = await localD1Raw();
    try {
      const run = await runScenario(loadScenario(name), { repo: d1Repo(drizzle(d1) as Db) });
      const p = fold(await run.repo.events.read());
      expect(indexOfSignals(Object.values(p.signals))).toEqual(p.index);
      const keys = expectedKeys(p);
      const threads = Object.values(p.threads)
        .map((t) => {
          const c = threadColumns(t);
          return { id: t.id, source_key: c.sourceKey, last_signal_at: c.lastSignalAt, named_pending: c.namedPending ? 1 : 0, reply_due: c.replyDue, is_open: c.isOpen ? 1 : 0 };
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const named = Object.values(p.threads)
        .flatMap((t) => pendingNamedKeys(t).map((k) => ({ thread_id: t.id, address_key: k, data_source_id: t.dataSourceId })))
        .sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : a.address_key < b.address_key ? -1 : 1));
      expect(named.length).toBeGreaterThan(0);
      const crossKeys = Object.values(p.threads)
        .flatMap((t) => crossKeysOfSignals(p, t).map((k) => ({ thread_id: t.id, key: k, data_source_id: t.dataSourceId })))
        .sort((a, b) => `${a.thread_id}\n${a.key}`.localeCompare(`${b.thread_id}\n${b.key}`));
      expect(crossKeys.length).toBeGreaterThan(0);

      // 差分の保存で書いた行
      expect(await rows(d1)).toEqual({ keys, threads, named, crossKeys });

      // 作り直し（丸ごとの保存）の行
      await run.service.rebuild();
      expect(await rows(d1)).toEqual({ keys, threads, named, crossKeys });

      // マイグレーションで既存の行から埋める（2 回流しても同じ）
      await d1.prepare('DELETE FROM signal_keys').run();
      await d1.prepare('DELETE FROM thread_named').run();
      await d1.prepare('UPDATE threads SET source_key = NULL, last_signal_at = NULL, named_pending = 0, reply_due = NULL, is_open = 0').run();
      await d1.prepare('DELETE FROM thread_keys').run();
      for (const stmt of backfillStatements()) await d1.prepare(stmt).run();
      expect(await rows(d1)).toEqual({ keys, threads, named, crossKeys });
      for (const stmt of backfillStatements()) await d1.prepare(stmt).run();
      expect(await rows(d1)).toEqual({ keys, threads, named, crossKeys });
    } finally {
      await close();
    }
  });
});
