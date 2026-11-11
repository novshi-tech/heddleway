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

  it('別の人のアドレスなら断る', () => {
    expect(() => connect(seed, { ...input, addresses: ['bob@ubs.example', 'alice@ubs.example'] })).toThrow(/another user's address/);
  });

  it('サインインしていない User・アドレスのわからない箱はつなげない', () => {
    expect(() => connect(seed, { ...input, userId: 'u_nobody' })).toThrow(/サインイン/);
    expect(() => connect(seed, { ...input, addresses: [] })).toThrow(/アドレス/);
  });
});
