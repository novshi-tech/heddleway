import type { Seed } from '../../src/domain/entities';
import { rowKey, SEED_KINDS } from '../../src/domain';

/**
 * seed の User ID を付け替える（仮の u_xxx → ゲートウェイの User ID）。
 * users[].id と、それを指す文字列（contacts[].userId、listMembers など）を同じ値で置き換える
 */
export function renameUsers(seed: Seed, map: Record<string, string>): Seed {
  const known = new Set(seed.users.map((u) => u.id));
  for (const from of Object.keys(map)) {
    if (!known.has(from)) throw new Error(`seed に User ${from} がない（あるのは ${[...known].join(', ')}）`);
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return Object.hasOwn(map, v) ? map[v] : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(seed) as Seed;
}

/** `--user u_kimura=entra_...` の並びを読む */
export function parseUserMap(args: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--user') continue;
    const [from, to] = (args[i + 1] ?? '').split('=');
    if (!from || !to) throw new Error('--user は <seed の User ID>=<ゲートウェイの User ID>');
    map[from] = to;
  }
  return map;
}

/** 本体のデータを全部消してから入れる（イベント・投影・ダミーのキューも消す。マスタが変わればイベントは意味を失うため） */
const CLEARED_TABLES = ['events', 'projection_meta', 'threads', 'signals', 'dummy_queue', 'master', 'master_changes'];

/**
 * D1 に流す seed の SQL（wrangler d1 execute --file）。マスタの行は D1MasterStore と同じ形（kind・ord・JSON）。
 * 文字列は SQL のリテラルにする（' を重ねる）
 */
export function seedSql(seed: Seed): string {
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const lines = CLEARED_TABLES.map((t) => `DELETE FROM ${t};`);
  for (const kind of SEED_KINDS) {
    (seed[kind] as unknown[]).forEach((data, ord) => {
      lines.push(`INSERT INTO master (kind, key, ord, data) VALUES (${literal(kind)}, ${literal(rowKey(kind, data))}, ${ord}, ${literal(JSON.stringify(data))});`);
    });
  }
  return `${lines.join('\n')}\n`;
}
