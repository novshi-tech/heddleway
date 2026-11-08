import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

// D1 のマイグレーション（drizzle/）。古い形のマスタの行に 0001 を当てても、行のキーが作られて残る（0030 の 5）

describe('マイグレーション', () => {
  it('H3 0001: マスタの行に key を付ける（id、ListMember は listId|読者、AttributeDef は dataSourceId|name）', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', d1Databases: ['DB'] }));
    try {
      const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
      const dir = join(import.meta.dirname, '../../drizzle');
      const apply = async (file: string) => {
        for (const stmt of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await d1.prepare(stmt).run();
      };
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      await apply(files[0]!);
      const insert = d1.prepare('INSERT INTO master (kind, ord, data) VALUES (?, ?, ?)');
      await insert.bind('contacts', 0, JSON.stringify({ id: 'p_kimura', name: '木村' })).run();
      await insert.bind('listMembers', 0, JSON.stringify({ listId: 'l_oa', contactId: 'p_kimura' })).run();
      await insert.bind('attributeDefs', 0, JSON.stringify({ dataSourceId: 'ds_jira', name: 'status' })).run();
      await apply(files[1]!);
      const rows = await d1.prepare('SELECT kind, key FROM master ORDER BY kind').all<{ kind: string; key: string }>();
      expect(rows.results).toEqual([
        { kind: 'attributeDefs', key: 'ds_jira|status' },
        { kind: 'contacts', key: 'p_kimura' },
        { kind: 'listMembers', key: 'l_oa|p_kimura' },
      ]);
      expect((await d1.prepare('SELECT COUNT(*) AS n FROM master_changes').first<{ n: number }>())!.n).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it('H1 H3 0003: 個人のメモ（データソース・リスト・読者・イベント）と属性を消し、ほかは残す。投影は作り直す（0039）', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', d1Databases: ['DB'] }));
    try {
      const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
      const dir = join(import.meta.dirname, '../../drizzle');
      const apply = async (file: string) => {
        for (const stmt of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await d1.prepare(stmt).run();
      };
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.slice(0, 3)) await apply(f);
      const master = d1.prepare('INSERT INTO master (kind, key, ord, data) VALUES (?, ?, ?, ?)');
      const row = (kind: string, key: string, data: object) => master.bind(kind, key, 0, JSON.stringify(data)).run();
      await row('dataSources', 'ds_mail', { kind: 'service', id: 'ds_mail', channel: 'email', name: 'mail', credentialRefId: 'c' });
      await row('dataSources', 'ds_notes', { kind: 'notes', id: 'ds_notes', name: 'メモ', ownerUserId: 'u_a' });
      await row('lists', 'l_mail', { id: 'l_mail', dataSourceId: 'ds_mail' });
      await row('lists', 'l_notes', { id: 'l_notes', dataSourceId: 'ds_notes' });
      await row('listMembers', 'l_mail|u_a', { listId: 'l_mail', userId: 'u_a' });
      await row('listMembers', 'l_notes|u_a', { listId: 'l_notes', userId: 'u_a' });
      await row('attributeDefs', 'ds_notes|priority', { dataSourceId: 'ds_notes', name: 'priority', type: 'string', description: 'd' });
      const ev = d1.prepare('INSERT INTO events (seq, type, payload, at) VALUES (?, ?, ?, ?)');
      const at = '2026-10-16T09:00:00.000Z';
      const events: [string, object][] = [
        ['SignalObserved', { signalId: 's_mail', dataSourceId: 'ds_mail', channel: 'email', from: { channel: 'email', value: 'x@y' }, to: [], body: 'b', sourceRef: 'r1' }],
        ['SignalThreaded', { signalId: 's_mail', thread: { kind: 'new', threadId: 't_mail', title: 'm' }, by: 'no_match', confidence: 1, reason: 'r' }],
        ['SignalObserved', { signalId: 's_note', dataSourceId: 'ds_notes', channel: 'note', from: { channel: 'note', value: 'u_a' }, to: [], body: 'n', sourceRef: 'note:1' }],
        ['SignalThreaded', { signalId: 's_note', thread: { kind: 'new', threadId: 't_note', title: 'n' }, by: 'self', confidence: 1, reason: 'r' }],
        ['ThreadLinked', { a: 't_note', b: 't_mail', route: 'manual', actorUserId: 'u_a' }],
        ['ThreadAttributeSet', { threadId: 't_note', name: 'priority', value: '高', actorUserId: 'u_a' }],
        ['ThreadDismissed', { threadId: 't_note', actorUserId: 'u_a', reason: '済み' }],
        ['OutboundRecorded', { signalId: 's_out', merged: false, dataSourceId: 'ds_mail', channel: 'email', from: { channel: 'email', value: 'a@y' }, to: [{ channel: 'email', value: 'x@y' }], body: 'o', sentRef: '<o>', sourceThreadId: 't_note', actorUserId: 'u_a' }],
        ['ThreadDismissed', { threadId: 't_mail', actorUserId: 'u_a', reason: '済み' }],
      ];
      for (const [i, [type, payload]] of events.entries()) await ev.bind(i + 1, type, JSON.stringify(payload), at).run();
      await d1.prepare("INSERT INTO projection_meta (id, last_seq, idx) VALUES (1, 9, '{}')").run();
      await d1.prepare("INSERT INTO threads (id, data_source_id, data) VALUES ('t_note', 'ds_notes', '{}')").run();

      await apply(files[3]!);
      const left = await d1.prepare('SELECT seq, type, payload FROM events ORDER BY seq').all<{ seq: number; type: string; payload: string }>();
      expect(left.results.map((r) => [r.seq, r.type])).toEqual([
        [1, 'SignalObserved'],
        [2, 'SignalThreaded'],
        [8, 'OutboundRecorded'],
        [9, 'ThreadDismissed'],
      ]);
      expect(JSON.parse(left.results[2]!.payload).sourceThreadId).toBeNull();
      const rows = await d1.prepare('SELECT kind, key FROM master ORDER BY kind, key').all<{ kind: string; key: string }>();
      expect(rows.results).toEqual([
        { kind: 'dataSources', key: 'ds_mail' },
        { kind: 'listMembers', key: 'l_mail|u_a' },
        { kind: 'lists', key: 'l_mail' },
      ]);
      for (const t of ['threads', 'signals', 'projection_meta']) expect((await d1.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
      const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_drop_%'").all();
      expect(tables.results).toEqual([]);
    } finally {
      await mf.dispose();
    }
  });
});
