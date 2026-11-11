import { describe, expect, it } from 'vitest';
import { connectMailbox, deriveViewer, Directory, isOurs, planMasterEdit, seedProblems, type MailboxInput, type MailboxPlan, type Seed } from '../../src/domain';
import { counterIds } from '../helpers/service';
import { seed } from '../helpers/world';

// 個人の箱を実行時に作る（0024 の決定 3）。作り方は 0030 の個人のリストと同じで、読者は本人 1 人に決まる

const NOW = '2026-10-30T00:00:00.000Z';
const input: MailboxInput = { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', addresses: ['Bob@ubs.example', 'bob@ubs.example', 'b.alias@ubs.example'] };

/** シェルの changeMaster と同じく、下書きに当てて差分を取る */
function connect(before: Seed, i: MailboxInput = input, newId = counterIds()): { after: Seed; plan: MailboxPlan } {
  let plan!: MailboxPlan;
  const { after } = planMasterEdit(before, (d) => {
    plan = connectMailbox(d, { dir: new Directory(d), now: NOW, newId }, i);
  });
  return { after, plan };
}

describe('H3 connectMailbox', () => {
  it('データソース・リスト・読者（本人だけ）を作り、アドレスとエイリアスを本人の Contact に付ける', () => {
    const { after, plan } = connect(seed);
    expect(plan.kind).toBe('created');
    expect(seedProblems(after)).toEqual([]);
    expect(plan.dataSource).toMatchObject({ channel: 'email', selfAddresses: [], connector: { kind: 'graph-mail', folders: ['inbox', 'sentitems'] } });
    const dir = new Directory(after);
    // 大文字小文字の違いは 1 つにまとめる
    expect(dir.addressesOfContact('p_bob', 'email').map((a) => a.value)).toEqual(['Bob@ubs.example', 'b.alias@ubs.example']);
    expect(deriveViewer(dir, 'u_bob').dataSourceIds).toContain(plan.dataSource.id);
    expect(deriveViewer(dir, 'u_alice').dataSourceIds).not.toContain(plan.dataSource.id);
    // エイリアスから送ったものも「こちら」
    const ds = dir.dataSource(plan.dataSource.id)!;
    expect(ds.kind === 'service' && isOurs(dir, ds, { channel: 'email', value: 'B.ALIAS@ubs.example' }, NOW)).toBe(true);
  });

  it('同じ本人・同じゲートウェイの接続なら作り直さない（何度つないでもよい）', () => {
    const first = connect(seed);
    const again = connect(first.after);
    expect(again.plan).toEqual({ kind: 'exists', dataSource: first.plan.dataSource });
    expect(again.after).toEqual(first.after);
  });

  it('Gmail（service: gmail）: 経路は gmail、名前は「の Gmail」。Outlook のメールボックスとは別のデータソース', () => {
    const outlookInput = { ...input, addresses: ['bob@ubs.example'] };
    const gmailInput: MailboxInput = { ...input, addresses: ['bob@gws.example'], service: 'gmail', gatewayCredentialId: 'gw_gmail' };
    const newId = counterIds();
    const outlook = connect(seed, outlookInput, newId);
    const gmail = connect(outlook.after, gmailInput, newId);
    expect(gmail.plan.kind).toBe('created');
    expect(gmail.plan.dataSource).toMatchObject({ name: 'Bob の Gmail', channel: 'email', selfAddresses: [], connector: { kind: 'gmail', mailbox: 'me' } });
    expect(seedProblems(gmail.after)).toEqual([]);
    // 同じ本人・同じ接続なら作り直さない（種類が同じものだけ）
    const again = connect(gmail.after, gmailInput, newId);
    expect(again.plan).toEqual({ kind: 'exists', dataSource: gmail.plan.dataSource });
    expect(connect(gmail.after, outlookInput, newId).plan).toEqual({ kind: 'exists', dataSource: outlook.plan.dataSource });
    // 同じアドレスの箱を Outlook と Gmail の両方でつなぐことはできない（同じ箱を 2 つのリストで読まない）
    expect(() => connect(outlook.after, { ...outlookInput, service: 'gmail', gatewayCredentialId: 'gw_gmail' }, newId)).toThrow(/already reads/);
  });

  it.each([
    ['Outlook', undefined, ['bob@ubs.example', 'b.alias@ubs.example']],
    ['Gmail', 'gmail' as const, ['bob@gws.example']],
  ])('H3 %s: ゲートウェイの接続を消して足し直し、資格情報の ID が変わっても、同じ本人・同じ種類・同じアドレスのメールボックスとして付け替える（作り直さない）', (_label, service, addresses) => {
    const base: MailboxInput = { ...input, addresses, ...(service ? { service } : {}) };
    const newId = counterIds();
    const first = connect(seed, base, newId);
    const ds = first.plan.dataSource;
    const again = connect(first.after, { ...base, gatewayCredentialId: 'gw_new' }, newId);
    expect(again.plan).toEqual({ kind: 'exists', dataSource: ds });
    const dir = new Directory(again.after);
    expect(dir.credentialRef(ds.credentialRefId)).toMatchObject({ gatewayCredentialId: 'gw_new', address: { channel: 'email', value: addresses[0] } });
    // データソースもリストも増えない。Contact のアドレスも変わらない
    expect(again.after.dataSources).toHaveLength(first.after.dataSources.length);
    expect(again.after.lists).toEqual(first.after.lists);
    expect(again.after.credentialRefs).toHaveLength(first.after.credentialRefs.length);
    // 大文字小文字の違うアドレスでも同じ箱
    const upper = connect(again.after, { ...base, gatewayCredentialId: 'gw_newer', addresses: addresses.map((a) => a.toUpperCase()) }, newId);
    expect(upper.plan).toEqual({ kind: 'exists', dataSource: ds });
    expect(new Directory(upper.after).credentialRef(ds.credentialRefId)?.gatewayCredentialId).toBe('gw_newer');
    // 別のアドレスの箱なら、新しい資格情報でも別のデータソースになる
    expect(connect(first.after, { ...base, gatewayCredentialId: 'gw_other', addresses: ['bob.other@elsewhere.example'] }, newId).plan.kind).toBe('created');
  });

  it('H3 付け替えるのは同じ種類の箱だけ。Gmail をつなぎ直しても Outlook の箱の資格情報は変わらない', () => {
    const newId = counterIds();
    const outlook = connect(seed, { ...input, addresses: ['bob@ubs.example'] }, newId);
    const gmail = connect(outlook.after, { ...input, addresses: ['bob@gws.example'], service: 'gmail', gatewayCredentialId: 'gw_g' }, newId);
    const again = connect(gmail.after, { ...input, addresses: ['bob@gws.example'], service: 'gmail', gatewayCredentialId: 'gw_g2' }, newId);
    const dir = new Directory(again.after);
    expect(dir.credentialRef(outlook.plan.dataSource.credentialRefId)?.gatewayCredentialId).toBe('gw_bob');
    expect(dir.credentialRef(gmail.plan.dataSource.credentialRefId)?.gatewayCredentialId).toBe('gw_g2');
  });

  it('別の人のアドレスなら断る', () => {
    expect(() => connect(seed, { ...input, addresses: ['bob@ubs.example', 'alice@ubs.example'] })).toThrow(/another user's address/);
  });

  it('サインインしていない User・アドレスのわからない箱はつなげない', () => {
    expect(() => connect(seed, { ...input, userId: 'u_nobody' })).toThrow(/サインイン/);
    expect(() => connect(seed, { ...input, addresses: [] })).toThrow(/アドレス/);
  });
});
