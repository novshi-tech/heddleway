import { canonicalJson } from './canonical';
import { seedProblems } from './directory';
import { Seed } from './entities';
import { DomainError } from './errors';

// マスタの書き換え（0030 の 5）。マスタはイベントにせず、その場で書き換える。
// 何が変わったかは差分（MasterChange）にして、シェルが変更の記録に残す。

export const SEED_KINDS = ['users', 'contacts', 'contactAliases', 'addresses', 'credentialRefs', 'dataSources', 'lists', 'listMembers'] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

/** マスタの行のキー（kind の中で一意） */
export function rowKey(kind: SeedKind, row: unknown): string {
  const r = row as Record<string, string>;
  if (kind === 'listMembers') return `${r.listId}|${r.userId}`;
  return r.id!;
}

/** 1 行の変更。before が null なら足した、after が null なら消した */
export interface MasterChange {
  kind: SeedKind;
  key: string;
  before: unknown | null;
  after: unknown | null;
}

/** 2 つのマスタの差分（kind の順、行の順） */
export function diffSeed(before: Seed, after: Seed): MasterChange[] {
  const changes: MasterChange[] = [];
  for (const kind of SEED_KINDS) {
    const old = new Map((before[kind] as unknown[]).map((r) => [rowKey(kind, r), r]));
    const now = new Map((after[kind] as unknown[]).map((r) => [rowKey(kind, r), r]));
    for (const [key, r] of now) {
      const prev = old.get(key);
      if (prev === undefined) changes.push({ kind, key, before: null, after: r });
      else if (canonicalJson(prev) !== canonicalJson(r)) changes.push({ kind, key, before: prev, after: r });
    }
    for (const [key, r] of old) if (!now.has(key)) changes.push({ kind, key, before: r, after: null });
  }
  return changes;
}

/** 差分を当てる（行の順は保ち、足した行は末尾） */
export function applyMasterChanges(seed: Seed, changes: readonly MasterChange[]): Seed {
  const raw = structuredClone(seed) as Record<SeedKind, unknown[]>;
  for (const c of changes) {
    const rows = raw[c.kind];
    const i = rows.findIndex((r) => rowKey(c.kind, r) === c.key);
    if (c.after === null) {
      if (i >= 0) rows.splice(i, 1);
    } else if (i >= 0) rows[i] = structuredClone(c.after);
    else rows.push(structuredClone(c.after));
  }
  return Seed.parse(raw);
}

/**
 * マスタを書き換える判断。edit は before の写しを受け取って書き換えた後のマスタを返す。
 * 書き換えた後のマスタは zod の形と整合性（seedProblems）を満たすこと。もともとあった問題は咎めない（新しく増えた分だけ conflict）
 */
export function planMasterEdit(before: Seed, edit: (draft: Seed) => Seed | void): { after: Seed; changes: MasterChange[] } {
  const draft = structuredClone(before);
  const edited = Seed.parse(edit(draft) ?? draft);
  const known = new Set(seedProblems(before));
  const problems = seedProblems(edited).filter((p) => !known.has(p));
  if (problems.length > 0) throw new DomainError('conflict', problems.join('; '));
  return { after: edited, changes: diffSeed(before, edited) };
}
