import { describe, expect, it } from 'vitest';
import { canonicalJson, canReadDataSource, deriveViewer, Directory, isOurs, Seed, seedProblems, type SeedInput } from '../../src/domain';
import { bearerToken } from '../../src/auth/bearer';
import { dir, seed } from '../helpers/world';

describe('Directory', () => {
  it('Address は期間付きで、大文字小文字を区別しない', () => {
    expect(dir.contactIdOfAddress({ channel: 'email', value: 'OLD@dave.example' }, '2025-06-01T00:00:00Z')).toBe('p_dave');
    expect(dir.contactIdOfAddress({ channel: 'email', value: 'old@dave.example' }, '2026-06-01T00:00:00Z')).toBeNull();
    expect(dir.contactIdOfAddress({ channel: 'line', value: 'info@dave.example' })).toBeNull();
  });

  it('H3 こちらの判定（0030）: 窓口のアドレスか、読者の Contact のアドレス', () => {
    const support = dir.dataSource('ds_support')!;
    expect(isOurs(dir, support, { channel: 'email', value: 'Support@ubs.example' })).toBe(true);
    // 読者（Alice）の Contact のアドレスはこちら
    expect(isOurs(dir, support, { channel: 'email', value: 'alice@ubs.example' })).toBe(true);
    expect(isOurs(dir, support, { channel: 'email', value: 'carol@example.com' })).toBe(false);
    // 個人の箱は窓口を持たず、読者（本人）のアドレスがこちら
    expect(isOurs(dir, dir.dataSource('ds_alice')!, { channel: 'email', value: 'alice@ubs.example' })).toBe(true);
    // 読者でない User の Contact（Eve は LINE の読者ではない）はこちらではない
    expect(isOurs(dir, dir.dataSource('ds_line')!, { channel: 'line', value: 'U_carol' })).toBe(false);
    // タスクのリストは、つないだアカウント（窓口）がこちら
    expect(isOurs(dir, dir.dataSource('ds_tasks_alice')!, { channel: 'todo', value: 'alice@ubs.example' })).toBe(true);
    expect(isOurs(dir, dir.dataSource('ds_tasks_alice')!, { channel: 'todo', value: 'bob@ubs.example' })).toBe(false);
  });

  it('H3 Viewer は User の Contact と、読者になっているリスト・データソースを束ねる', () => {
    const v = deriveViewer(dir, 'u_alice');
    expect(v).toEqual({
      userId: 'u_alice',
      contactId: 'p_alice',
      listIds: ['l_support', 'l_alice', 'l_tasks_alice'],
      dataSourceIds: ['ds_support', 'ds_alice', 'ds_tasks_alice'],
    });
    expect(canReadDataSource(v, 'ds_alice')).toBe(true);
    expect(canReadDataSource(v, 'ds_line')).toBe(false);
    // 読者になっているリストがない User（チームの外）は何も読めない
    expect(deriveViewer(dir, 'u_mallory')).toEqual({ userId: 'u_mallory', contactId: null, listIds: [], dataSourceIds: [] });
    // ゴースト Contact は Viewer になれない
    expect(deriveViewer(dir, 'p_carol').contactId).toBeNull();
  });
});

describe('H3 マスタの整合性（seedProblems）', () => {
  it('テスト用の世界は整合している', () => {
    expect(seedProblems(seed)).toEqual([]);
  });

  const broken = (f: (s: SeedInput) => void) => {
    const s = structuredClone(seed) as SeedInput;
    f(s);
    return seedProblems(Seed.parse(s));
  };

  it('データソース 1 つにリスト 1 つ', () => {
    expect(broken((s) => s.lists!.push({ id: 'l_dup', dataSourceId: 'ds_support' })).join()).toMatch(/ds_support: リストが 2 個/);
    expect(broken((s) => (s.lists = s.lists!.filter((l) => l.id !== 'l_line'))).join()).toMatch(/ds_line: リストが 0 個/);
  });

  it('個人リスト（タスクのリスト）の読者は本人だけ', () => {
    expect(broken((s) => s.listMembers!.push({ listId: 'l_tasks_alice', userId: 'u_bob' })).join()).toMatch(/個人の資格情報/);
  });

  it('個人の資格情報は読者 1 人（その本人）のデータソースにしか使わない', () => {
    expect(broken((s) => s.listMembers!.push({ listId: 'l_alice', userId: 'u_bob' })).join()).toMatch(/個人の資格情報/);
    // 組織の資格情報なら読者が複数でよい
    expect(broken((s) => s.listMembers!.push({ listId: 'l_line', userId: 'u_alice' }))).toEqual([]);
  });

  it('H3 読者は User（0030。ゴーストの Contact は読者になれない）。Contact のない User も読者になれる', () => {
    expect(broken((s) => s.listMembers!.push({ listId: 'l_support', userId: 'u_carol' })).join()).toMatch(/読者 u_carol が User ではない/);
    expect(broken((s) => s.listMembers!.push({ listId: 'l_line', userId: 'u_mallory' }))).toEqual([]);
    const s = Seed.parse({ ...seed, listMembers: [...seed.listMembers, { listId: 'l_line', userId: 'u_mallory' }] });
    expect(deriveViewer(new Directory(s), 'u_mallory')).toMatchObject({ contactId: null, listIds: ['l_line'] });
  });

  it('User の Contact は 1 つまで（1 デプロイ = 1 チーム）', () => {
    expect(broken((s) => s.contacts!.push({ id: 'p_alice2', name: 'Alice', userId: 'u_alice' })).join()).toMatch(/u_alice: Contact が 2 個/);
  });

  it('窓口のアドレスはデータソースのチャネルのもの', () => {
    const problems = broken((s) => {
      const ds = s.dataSources!.find((d) => d.id === 'ds_support')!;
      if (ds.kind === 'service') ds.selfAddresses = [{ channel: 'line', value: '@ubs' }];
    });
    expect(problems.join()).toMatch(/窓口のアドレス @ubs のチャネルが line/);
  });
});

describe('canonicalJson', () => {
  it('キー順に依存せず、undefined を落とす', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('本体の API のトークン', () => {
  it('Authorization ヘッダから Bearer トークンを取り出す（確かめるのはゲートウェイの口）', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   x')).toBe('x');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
