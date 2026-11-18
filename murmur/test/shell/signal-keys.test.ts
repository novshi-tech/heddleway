import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import { fold, indexOfSignals, signalKeysOf, threadColumns, type Projections } from '../../src/domain';
import { d1Repo, type Db } from '../../src/store/d1';
import { localD1Raw } from '../../scripts/lib/d1';
import { listScenarios, loadScenario, runScenario } from '../../scripts/lib/scenario';

// 0046 の決定 2: 索引（signal_keys）とスレッドの列は、投影（シグナルとスレッドの記録）だけから決まる。
// 差分の保存で書いた行も、マイグレーションで既存の行から埋めた行も、イベントから畳んだ投影から作ったものと一致する

type KeyRow = { data_source_id: string; kind: string; value: string; signal_id: string; seq: number };
type ThreadRow = { id: string; source_key: string | null; last_signal_at: string | null; named_pending: number };

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

async function rows(d1: D1Database) {
  const keys = (await d1.prepare('SELECT data_source_id, kind, value, signal_id, seq FROM signal_keys').all<KeyRow>()).results;
  const threads = (await d1.prepare('SELECT id, source_key, last_signal_at, named_pending FROM threads ORDER BY id').all<ThreadRow>()).results;
  return { keys: sortKeys(keys), threads };
}

/** 0004 のうち、既存の行から列と索引を埋める文（「0046:」の注記より後ろ） */
function backfillStatements(): string[] {
  const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0004_ingest_working_set.sql'), 'utf8');
  const tail = sql.slice(sql.indexOf('-- 0046:'));
  return tail.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
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
          return { id: t.id, source_key: c.sourceKey, last_signal_at: c.lastSignalAt, named_pending: c.namedPending ? 1 : 0 };
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1));

      // 差分の保存で書いた行
      expect(await rows(d1)).toEqual({ keys, threads });

      // 作り直し（丸ごとの保存）の行
      await run.service.rebuild();
      expect(await rows(d1)).toEqual({ keys, threads });

      // マイグレーションで既存の行から埋める。名指しの列は上位集合（名指しが 1 つでもあれば立てる）でよい
      await d1.prepare('DELETE FROM signal_keys').run();
      await d1.prepare('UPDATE threads SET source_key = NULL, last_signal_at = NULL, named_pending = 0').run();
      for (const stmt of backfillStatements()) await d1.prepare(stmt).run();
      const filled = await rows(d1);
      expect(filled.keys).toEqual(keys);
      expect(filled.threads.map(({ named_pending: _n, ...r }) => r)).toEqual(threads.map(({ named_pending: _n, ...r }) => r));
      for (const t of threads) if (t.named_pending) expect(filled.threads.find((x) => x.id === t.id)?.named_pending, t.id).toBe(1);
    } finally {
      await close();
    }
  });
});
