import { describe, expect, it } from 'vitest';
import { loadScenario } from '../../scripts/lib/scenario';
import { localD1 } from '../../scripts/lib/d1';
import { parseUserMap, renameUsers, seedSql } from '../../scripts/lib/seed';
import { d1Repo } from '../../src/store/d1';

describe('H7 seed の投入（User ID の付け替え）', () => {
  it('H7 users と、それを指す Contact・リストのメンバーが同じ ID に付け替わる', () => {
    const seed = loadScenario('absence').seed;
    const out = renameUsers(seed, parseUserMap(['--user', 'u_kimura=entra_t_o']));
    expect(out.users.map((u) => u.id)).toEqual(['entra_t_o']);
    expect(out.contacts.find((p) => p.id === 'p_kimura')?.userId).toBe('entra_t_o');
    expect(JSON.stringify(out)).not.toContain('u_kimura');
    expect(JSON.stringify(seed)).toContain('u_kimura');
  });

  it('H7 seed にない User を指定したら失敗する', () => {
    expect(() => renameUsers(loadScenario('absence').seed, { u_nobody: 'x' })).toThrow(/u_nobody/);
  });

  it('H7 seed の SQL を D1 に流すと、マスタがそのまま読み出せる（引用符を含む値も）', async () => {
    const seed = renameUsers(loadScenario('complaint').seed, { u_sato: "o'brien" });
    const { db, close } = await localD1();
    try {
      const d1 = db.$client;
      for (const stmt of seedSql(seed).trim().split('\n')) await d1.prepare(stmt).run();
      expect(await d1Repo(db).master.loadSeed()).toEqual(seed);
    } finally {
      await close();
    }
  });
});
