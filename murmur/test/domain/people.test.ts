import { describe, expect, it } from 'vitest';
import {
  addListMember,
  bindIdentity,
  createContact,
  createPersonalDataSource,
  deriveViewer,
  Directory,
  DomainError,
  endAddress,
  ensureUser,
  mergeContacts,
  planMasterEdit,
  searchContacts,
  unbindContact,
  unresolvedAddresses,
  type Seed,
} from '../../src/domain';
import { alice, answer, dir, email, EventLog, ingestPure, makeCtx, seed } from '../helpers/world';

// User と Contact の作り方と名寄せ（0030 の 6〜9）

const ctx = () => makeCtx('2026-10-31T09:00:00.000Z');
/** 書き換えて整合性を確かめた後のマスタ */
const edited = <T>(base: Seed, f: (d: Seed, c: ReturnType<typeof ctx>) => T) => {
  const c = ctx();
  let out!: T;
  const { after } = planMasterEdit(base, (d) => {
    out = f(d, c);
  });
  return { after, out };
};

describe('サインイン（0030 の 4・6）', () => {
  it('H3 sub だけの名無し: User の行だけを作り、Contact は作らない。何も見えない', () => {
    const { after } = edited(seed, (d) => ensureUser(d, 'u_naoki'));
    expect(after.users.find((u) => u.id === 'u_naoki')).toEqual({ id: 'u_naoki', name: '' });
    expect(new Directory(after).contactOfUser('u_naoki')).toBeUndefined();
    expect(deriveViewer(new Directory(after), 'u_naoki')).toMatchObject({ contactId: null, listIds: [] });
    expect(edited(after, (d) => ensureUser(d, 'u_naoki')).out).toBe(false);
  });
});

describe('リストでのアイデンティティ（0030 の 7）', () => {
  const naoki = () => edited(seed, (d) => ensureUser(d, 'u_naoki')).after;

  it('H3 付いている Contact がなければ作って sub に結ぶ。ゴーストがあればそれを結ぶ（Contact は 2 つにならない）', () => {
    const created = edited(naoki(), (d, c) => bindIdentity(d, 'u_naoki', { channel: 'email', value: 'naoki@example.com' }, c));
    expect(created.out.kind).toBe('created');
    expect(new Directory(created.after).contactOfUser('u_naoki')?.id).toBe(created.out.contactId);

    // Carol のゴーストのアドレスを、サインインした Carol が自分のアイデンティティに選ぶ
    const carol = edited(seed, (d) => ensureUser(d, 'u_carol')).after;
    const bound = edited(carol, (d, c) => bindIdentity(d, 'u_carol', { channel: 'line', value: 'U_carol' }, c));
    expect(bound.out).toEqual({ kind: 'bound', contactId: 'p_carol' });
    expect(new Directory(bound.after).contactOfUser('u_carol')?.id).toBe('p_carol');
  });

  it('H3 本人の Contact があれば、そこにアドレスを付ける。別のゴーストのアドレスなら、まとめる候補を返すだけ', () => {
    const attached = edited(seed, (d, c) => bindIdentity(d, 'u_alice', { channel: 'slack', value: 'T_UBS/U_ALICE' }, c));
    expect(attached.out).toEqual({ kind: 'attached', contactId: 'p_alice' });
    const candidate = edited(seed, (d, c) => bindIdentity(d, 'u_alice', { channel: 'email', value: 'carol@example.com' }, c));
    expect(candidate.out).toEqual({ kind: 'merge_candidate', contactId: 'p_alice', ghostContactId: 'p_carol' });
    expect(new Directory(candidate.after).contactIdOfAddress({ channel: 'email', value: 'carol@example.com' })).toBe('p_carol');
  });

  it('H3 別の User の Contact のアドレスは conflict', () => {
    expect(() => edited(seed, (d, c) => bindIdentity(d, 'u_bob', { channel: 'email', value: 'alice@ubs.example' }, c))).toThrow(/another user's address/);
  });

  it('H3 個人のリスト: 資格情報は本人、読者は本人だけ、窓口なし。アイデンティティが本人の Contact に付いてこちらになる', () => {
    const { after, out } = edited(naoki(), (d, c) =>
      createPersonalDataSource(d, 'u_naoki', { channel: 'email', name: '直樹のメール', identity: 'naoki@example.com', gatewayCredentialId: 'gw-cred-1' }, c),
    );
    const d2 = new Directory(after);
    const ds = d2.dataSource(out.dataSourceId)!;
    expect(ds).toMatchObject({ kind: 'service', selfAddresses: [] });
    expect(after.credentialRefs.find((c) => ds.kind === 'service' && c.id === ds.credentialRefId)).toMatchObject({
      principal: { kind: 'user', userId: 'u_naoki' },
      gatewayCredentialId: 'gw-cred-1',
    });
    expect(d2.readersOfList(out.listId)).toEqual(['u_naoki']);
    expect(out.identity.kind).toBe('created');
    // 同じアカウントのリストは 2 つ作らない
    expect(() =>
      edited(after, (d, c) => createPersonalDataSource(d, 'u_naoki', { channel: 'email', name: 'x', identity: 'naoki@example.com', gatewayCredentialId: 'g' }, c)),
    ).toThrow(/already reads/);
  });

  it('H3 共有のリストに読者を足す（管理者）: サインイン済みの User だけ。アイデンティティは任意', () => {
    expect(() => edited(seed, (d, c) => addListMember(d, 'l_support', 'u_nobody', undefined, c))).toThrow(/サインインしていない/);
    const { after, out } = edited(seed, (d, c) => addListMember(d, 'l_slack', 'u_alice', 'T_UBS/U_ALICE', c));
    expect(out).toEqual({ kind: 'attached', contactId: 'p_alice' });
    expect(new Directory(after).readersOfList('l_slack')).toEqual(['u_eve', 'u_alice']);
  });
});

describe('名寄せと直す操作（0030 の 8・9）', () => {
  it('H3 未解決のアドレス: 見えるデータソースのシグナルに出てきて、Contact に解決できないもの（窓口は数えない）', () => {
    const log = new EventLog();
    const c = makeCtx('2026-10-16T09:00:00.000Z');
    ingestPure(log, c, email({ from: 'frank@example.com', to: ['support@ubs.example', 'gina@example.com'], sourceRef: 'r1' }), () => answer());
    c.setNow('2026-10-16T10:00:00.000Z');
    ingestPure(log, c, email({ from: 'frank@example.com', sourceRef: 'r2' }), () => answer({ thread: 'new' }));
    const out = unresolvedAddresses(dir, alice, log.state());
    expect(out.map((u) => [u.value, u.count])).toEqual([
      ['frank@example.com', 2],
      ['gina@example.com', 1],
    ]);
    expect(out[0]).toMatchObject({ channel: 'email', lastSeenAt: '2026-10-16T10:00:00.000Z' });
    expect(out[0]!.threadIds).toHaveLength(2);
    // 見えないデータソースの分は出さない
    expect(unresolvedAddresses(dir, deriveViewer(dir, 'u_eve'), log.state())).toEqual([]);
  });

  it('H3 ゴーストを作ってアドレスを付け、名前やアドレスで引ける。付け替えは終わらせてから', () => {
    const { after, out } = edited(seed, (d, c) => createContact(d, { name: 'Frank', address: { channel: 'email', value: 'frank@example.com' } }, c));
    expect(searchContacts(new Directory(after), 'FRANK@').map((x) => x.id)).toEqual([out]);
    expect(searchContacts(new Directory(after), 'frank')[0]).toMatchObject({ name: 'Frank', userId: null, addresses: [{ value: 'frank@example.com', validTo: null }] });
    const addressId = searchContacts(new Directory(after), 'frank')[0]!.addresses[0]!.id;
    const ended = edited(after, (d, c) => endAddress(d, out, addressId, c)).after;
    expect(new Directory(ended).contactIdOfAddress({ channel: 'email', value: 'frank@example.com' }, '2026-10-31T10:00:00.000Z')).toBeNull();
  });

  it('H3 まとめる: アドレスを移し、消える側の ID は別名で引ける。両方に User があればまとめない', () => {
    const { after } = edited(seed, (d) => mergeContacts(d, 'p_carol', 'p_dave'));
    const d2 = new Directory(after);
    expect(d2.contact('p_dave')?.id).toBe('p_carol');
    expect(d2.contactIdOfAddress({ channel: 'email', value: 'info@dave.example' })).toBe('p_carol');
    expect(() => edited(seed, (d) => mergeContacts(d, 'p_alice', 'p_bob'))).toThrow(/both/);
    // ゴーストに User の Contact をまとめると、User はまとめ先に移る
    expect(new Directory(edited(seed, (d) => mergeContacts(d, 'p_carol', 'p_alice')).after).contactOfUser('u_alice')?.id).toBe('p_carol');
  });

  it('H3 User との結びを外せるのは本人だけ。外しても見えるものは変わらない', () => {
    expect(() => edited(seed, (d) => unbindContact(d, 'p_alice', 'u_bob'))).toThrow(DomainError);
    const { after } = edited(seed, (d) => unbindContact(d, 'p_alice', 'u_alice'));
    expect(deriveViewer(new Directory(after), 'u_alice')).toMatchObject({ contactId: null, listIds: alice.listIds });
  });
});
