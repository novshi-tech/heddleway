import { describe, expect, it } from 'vitest';
import { applyMasterChanges, DomainError, diffSeed, planMasterEdit } from '../../src/domain';
import { seed } from '../helpers/world';

// マスタの書き換え（0030 の 5）。差分の計算と当て方、書き換えた後の整合性

describe('マスタの書き換え（H3）', () => {
  it('差分を当てれば書き換えた後のマスタになる。変わらなければ差分は空', () => {
    const { after, changes } = planMasterEdit(seed, (d) => {
      d.contacts.push({ id: 'p_frank', name: 'Frank', externalRefs: {} });
      d.addresses = d.addresses.filter((a) => a.id !== 'a_carol_line');
    });
    expect(applyMasterChanges(seed, changes)).toEqual(after);
    expect(diffSeed(after, after)).toEqual([]);
    expect(planMasterEdit(seed, () => {}).changes).toEqual([]);
  });

  it('整合性を崩す書き換えは conflict（1 つのアドレスが同じ時点で 2 つの Contact に付く、など）', () => {
    const dup = () =>
      planMasterEdit(seed, (d) => {
        d.addresses.push({ id: 'a_carol2', channel: 'email', value: 'Carol@example.com', contactId: 'p_dave' });
      });
    expect(dup).toThrow(DomainError);
    expect(dup).toThrow(/期間が重なる/);
    // 期間をずらせば付け替えられる
    expect(() =>
      planMasterEdit(seed, (d) => {
        d.addresses.find((a) => a.id === 'a_carol')!.validTo = '2026-10-20T00:00:00.000Z';
        d.addresses.push({ id: 'a_carol2', channel: 'email', value: 'carol@example.com', contactId: 'p_dave', validFrom: '2026-10-20T00:00:00.000Z' });
      }),
    ).not.toThrow();
    expect(() => planMasterEdit(seed, (d) => void d.addresses.push({ id: 'a_x', channel: 'email', value: 'x@y', contactId: 'p_nope' }))).toThrow(/contact p_nope がない/);
  });
});
