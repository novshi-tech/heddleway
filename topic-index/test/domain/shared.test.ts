import { describe, expect, it } from 'vitest';
import {
  canDisconnect,
  connectSharedSpace,
  deriveViewer,
  Directory,
  planMasterEdit,
  replaceSharedCredential,
  seedProblems,
  syncSharedReaders,
  type Seed,
  type SharedSpaceInput,
} from '../../src/domain';
import { makeCtx, seed } from '../helpers/world';

// 共有リスト（0037）: スペースに 1 つ、読者はソースから写す、資格情報はつないだ人の委任、外せるのは作った人と管理者

const ctx = () => makeCtx('2026-11-05T09:00:00.000Z');
const edited = <T>(base: Seed, f: (d: Seed, c: ReturnType<typeof ctx>) => T) => {
  const c = ctx();
  let out!: T;
  const { after } = planMasterEdit(base, (d) => {
    out = f(d, c);
  });
  return { after, out };
};

const SPACE: SharedSpaceInput = {
  userId: 'u_alice',
  gatewayCredentialId: 'gw_alice_jira',
  channel: 'jira',
  spaceKey: 'jira:cloud-1/SPW',
  name: 'スポット作業',
  identity: 'acct-alice',
  connector: { kind: 'jira', cloudId: 'cloud-1', site: 'https://acme.atlassian.net', jql: 'project = SPW' },
};

const listOf = (s: Seed, dsId: string) => s.lists.find((l) => l.dataSourceId === dsId)!.id;
const readersOf = (s: Seed, dsId: string) => new Directory(s).readersOfList(listOf(s, dsId)).sort();

describe('H3 共有リストを作る（0037 の決定 1）', () => {
  it('スペースに 1 つ。作った人が最初の読者で、資格情報は作った人の委任。マスタは整合する', () => {
    const { after, out } = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    expect(out.kind).toBe('created');
    const ds = out.dataSource;
    expect(ds).toMatchObject({ kind: 'service', channel: 'jira', group: true, shared: { spaceKey: 'jira:cloud-1/SPW', createdBy: 'u_alice' } });
    expect(readersOf(after, ds.id)).toEqual(['u_alice']);
    expect(after.credentialRefs.find((c) => c.id === ds.credentialRefId)).toMatchObject({ principal: { kind: 'user', userId: 'u_alice' }, gatewayCredentialId: 'gw_alice_jira' });
    // つないだ人のアカウントが本人の Contact に付く（名乗り）
    expect(new Directory(after).contactIdOfAddress({ channel: 'jira', value: 'acct-alice' })).toBe('p_alice');
    expect(seedProblems(after)).toEqual([]);
  });

  it('2 人目がつないでも同じ共有リストを返す（資格情報も読者も変えない）', () => {
    const first = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    const second = edited(first.after, (d, c) => connectSharedSpace(d, c, { ...SPACE, userId: 'u_bob', gatewayCredentialId: 'gw_bob', identity: 'acct-bob' }));
    expect(second.out).toMatchObject({ kind: 'exists', dataSource: { id: first.out.dataSource.id } });
    expect(second.after.dataSources.filter((d) => d.kind === 'service' && d.shared)).toHaveLength(1);
  });

  it('同じスペースの共有リストが 2 つあれば seedProblems が見つける', () => {
    const { after, out } = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    const dup = structuredClone(after);
    dup.dataSources.push({ ...out.dataSource, id: 'ds_dup' });
    dup.lists.push({ id: 'l_dup', dataSourceId: 'ds_dup' });
    expect(seedProblems(dup)).toContainEqual(expect.stringMatching(/スペース jira:cloud-1\/SPW の共有リストは/));
  });

  it('共有でない個人の資格情報のデータソースは、今までどおり読者 1 人', () => {
    const { after, out } = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    const personal = structuredClone(after);
    const ds = personal.dataSources.find((d) => d.id === out.dataSource.id)!;
    if (ds.kind === 'service') delete ds.shared;
    personal.listMembers.push({ listId: listOf(personal, ds.id), userId: 'u_bob' });
    expect(seedProblems(personal)).toContainEqual(expect.stringMatching(/個人の資格情報は読者 1 人/));
  });
});

describe('H3 読者をソースから写す（0037 の決定 2）', () => {
  const created = () => edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));

  it('本人が名乗ったアドレスで対応が付いた人だけが読者になる。対応のない人（推測しない）・アプリは読者にならない', () => {
    const base = created();
    const withBob = edited(base.after, (d, c) => {
      // Bob は自分の Jira をつないで accountId を名乗っている
      d.addresses.push({ id: 'a_bob_jira', channel: 'jira', value: 'acct-bob', contactId: 'p_bob' });
      return syncSharedReaders(d, c, base.out.dataSource.id, [
        { address: { channel: 'jira', value: 'acct-alice' } },
        { address: { channel: 'jira', value: 'acct-bob' } },
        { address: { channel: 'jira', value: 'acct-unknown' } },
      ]);
    });
    expect(withBob.out).toMatchObject({ added: ['u_bob'], removed: [], ownerLost: false });
    expect(readersOf(withBob.after, base.out.dataSource.id)).toEqual(['u_alice', 'u_bob']);
    expect(deriveViewer(new Directory(withBob.after), 'u_bob').dataSourceIds).toContain(base.out.dataSource.id);
    expect(seedProblems(withBob.after)).toEqual([]);
  });

  it('ソースから外れた人は読者から外れる。つないだ人が外れたら ownerLost', () => {
    const base = created();
    const r = edited(base.after, (d, c) => syncSharedReaders(d, c, base.out.dataSource.id, []));
    expect(r.out).toMatchObject({ readers: [], removed: ['u_alice'], ownerLost: true });
    expect(readersOf(r.after, base.out.dataSource.id)).toEqual([]);
    expect(deriveViewer(new Directory(r.after), 'u_alice').dataSourceIds).not.toContain(base.out.dataSource.id);
  });

  it('IdP の ID で対応が付く人（Teams）は、User があれば読者になり、そのアドレスが本人の Contact に付く。User のない人はならない', () => {
    const base = edited(seed, (d, c) =>
      connectSharedSpace(d, c, { ...SPACE, channel: 'slack', spaceKey: 'teams:t1/c1', identity: 'tenant/oid-alice', connector: undefined }),
    );
    const r = edited(base.after, (d, c) =>
      syncSharedReaders(d, c, base.out.dataSource.id, [
        { address: { channel: 'slack', value: 'tenant/oid-alice' }, userId: 'u_alice' },
        { address: { channel: 'slack', value: 'tenant/oid-bob' }, userId: 'u_bob' },
        { address: { channel: 'slack', value: 'tenant/oid-nobody' }, userId: 'u_nobody' },
      ]),
    );
    expect(r.out).toMatchObject({ added: ['u_bob'], ownerLost: false });
    expect(new Directory(r.after).contactIdOfAddress({ channel: 'slack', value: 'tenant/oid-bob' })).toBe('p_bob');
    expect(readersOf(r.after, base.out.dataSource.id)).toEqual(['u_alice', 'u_bob']);
  });
});

describe('H3 つなぎ直しと外す権限（0037 の決定 3・4）', () => {
  it('読者の 1 人の委任に資格情報を入れ替えられる。読者でない人はできない', () => {
    const base = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    const dsId = base.out.dataSource.id;
    const withBob = edited(base.after, (d) => d.listMembers.push({ listId: listOf(d, dsId), userId: 'u_bob' }));
    const r = edited(withBob.after, (d, c) => replaceSharedCredential(d, c, dsId, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', identity: 'acct-bob' }));
    const cred = r.after.credentialRefs.find((c) => c.id === r.out.credentialRefId)!;
    expect(cred).toMatchObject({ principal: { kind: 'user', userId: 'u_bob' }, gatewayCredentialId: 'gw_bob', address: { channel: 'jira', value: 'acct-bob' } });
    // 作った人は変わらない
    expect(r.out.shared).toEqual({ spaceKey: 'jira:cloud-1/SPW', createdBy: 'u_alice' });
    expect(() => edited(base.after, (d, c) => replaceSharedCredential(d, c, dsId, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', identity: 'acct-bob' }))).toThrow(/読者ではない/);
  });

  it('外せるのは、共有リストは作った人と管理者、個人のリストは本人', () => {
    const base = edited(seed, (d, c) => connectSharedSpace(d, c, SPACE));
    const dsId = base.out.dataSource.id;
    expect(canDisconnect(base.after, dsId, 'u_alice', false)).toBe(true);
    expect(canDisconnect(base.after, dsId, 'u_bob', false)).toBe(false);
    expect(canDisconnect(base.after, dsId, 'u_bob', true)).toBe(true);
    const personal = seed.dataSources.find((d) => d.kind === 'service' && seed.credentialRefs.find((c) => c.id === d.credentialRefId)?.principal.kind === 'user')!;
    const owner = (seed.credentialRefs.find((c) => personal.kind === 'service' && c.id === personal.credentialRefId)!.principal as { userId: string }).userId;
    expect(canDisconnect(seed, personal.id, owner, false)).toBe(true);
    expect(canDisconnect(seed, personal.id, 'u_nobody', true)).toBe(false);
  });
});
