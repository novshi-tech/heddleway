import { describe, expect, it } from 'vitest';
import { deriveComm, isPending, type AddressRef, type CommState, type ThreadLogEntry } from '../../src/domain';

// 通信状態の導出（0030・0038）。名指しはアドレスと順番だけで畳む（リスト宛てか・読者かは決めない。turn.test.ts）

const at = (h: number) => `2026-10-16T${String(h).padStart(2, '0')}:00:00.000Z`;
const US: AddressRef = { channel: 'email', value: 'support@ubs.example' };
const CAROL: AddressRef = { channel: 'email', value: 'carol@example.com' };
const DAVE: AddressRef = { channel: 'email', value: 'info@dave.example' };
let seq = 0;
const signal = (h: number, from: AddressRef, to: AddressRef[], replyExpectedBy?: string): ThreadLogEntry => ({
  seq: ++seq,
  at: at(h),
  kind: 'signal',
  signalId: `sig${seq}`,
  from,
  to,
  replyExpectedBy,
});
const ack = (h: number, untilSignalId: string, addresses: AddressRef[], list = false, userId = 'u_alice'): ThreadLogEntry => ({
  seq: ++seq,
  at: at(h),
  kind: 'acknowledged',
  untilSignalId,
  addresses,
  list,
  actorUserId: userId,
});
const dismissed = (h: number): ThreadLogEntry => ({ seq: ++seq, at: at(h), kind: 'dismissed', reason: 'r' });
const reopened = (h: number): ThreadLogEntry => ({ seq: ++seq, at: at(h), kind: 'reopened' });
const claimed = (h: number, userId: string | null): ThreadLogEntry => ({ seq: ++seq, at: at(h), kind: 'claimed', userId });
const overdue = (h: number, signalId: string): ThreadLogEntry => ({ seq: ++seq, at: at(h), kind: 'overdue', signalId, replyExpectedBy: at(h - 1) });
const other = (h: number, kind: 'note' | 'linked'): ThreadLogEntry => ({ seq: ++seq, at: at(h), kind });

/** 名指しが残っているアドレスの値 */
const pending = (s: CommState) => s.attention.named.filter((n) => isPending(n)).map((n) => n.address.value);

describe('deriveComm（H2・H8・0038）', () => {
  it('空なら名指しも担当もない', () => {
    expect(deriveComm([])).toMatchObject({ attention: { named: [], broadcasts: [], listAcks: {} }, ownerUserId: null, dismissed: false });
  });

  it('H8 宛先が名指しされる（送り主は除く）。アドレスごとに最後の名指しを持ち、ほかの人の発言では消えない', () => {
    const a = signal(9, CAROL, [US, DAVE, CAROL]);
    const b = signal(10, DAVE, [CAROL]);
    const s = deriveComm([a, b]);
    expect(pending(s).sort()).toEqual([CAROL.value, DAVE.value, US.value].sort());
    expect(s.attention.named.find((n) => n.address.value === DAVE.value)).toMatchObject({ last: { signalId: a.signalId }, from: CAROL });
    expect(s.attention.named.find((n) => n.address.value === CAROL.value)).toMatchObject({ last: { signalId: b.signalId }, from: DAVE });
  });

  it('H8 宛先のないシグナルは broadcasts（グループのチャネルならリスト宛て）', () => {
    const a = signal(9, CAROL, []);
    expect(deriveComm([a]).attention.broadcasts).toEqual([{ signalId: a.signalId, at: a.at, seq: a.seq, from: CAROL }]);
  });

  it('H8 外すのはそのシグナルまで。それより後に名指しされれば、また残る。発言しただけでは外れない', () => {
    const a = signal(9, CAROL, [US]);
    const reply = signal(10, US, [CAROL]);
    const s1 = deriveComm([a, reply]);
    expect(pending(s1).sort()).toEqual([CAROL.value, US.value].sort());
    const s2 = deriveComm([a, reply, ack(11, a.signalId!, [US])]);
    expect(pending(s2)).toEqual([CAROL.value]);
    expect(s2.attention.named.find((n) => n.address.value === US.value)?.ackedThrough).toMatchObject({ signalId: a.signalId, userId: 'u_alice' });
    const again = signal(12, CAROL, [US]);
    expect(pending(deriveComm([a, reply, ack(11, a.signalId!, [US]), again])).sort()).toEqual([CAROL.value, US.value].sort());
  });

  it('H8 リスト宛ての外しは User ごとに位置を持つ。より前の位置への外しでは戻らない', () => {
    const a = signal(9, CAROL, [US]);
    const b = signal(10, CAROL, [US]);
    const s = deriveComm([a, b, ack(11, b.signalId!, [], true, 'u_bob'), ack(12, a.signalId!, [], true, 'u_bob')]);
    expect(s.attention.listAcks).toEqual({ u_bob: { signalId: b.signalId, at: b.at, seq: b.seq } });
  });

  it('H8 移し替えでなくなったシグナルまでの外しは効かない', () => {
    const a = signal(9, CAROL, [US]);
    expect(pending(deriveComm([a, ack(10, 'gone', [US])]))).toEqual([US.value]);
  });

  it('H4 担当する → その人、引き継ぐ → 別の人、手放す → なし。名指しは変えない', () => {
    const a = signal(9, CAROL, [US]);
    expect(deriveComm([a, claimed(10, 'u_bob')]).ownerUserId).toBe('u_bob');
    expect(deriveComm([a, claimed(10, 'u_bob'), claimed(11, 'u_alice')]).ownerUserId).toBe('u_alice');
    const released = deriveComm([a, claimed(10, 'u_bob'), claimed(11, null)]);
    expect(released.ownerUserId).toBeNull();
    expect(pending(released)).toEqual([US.value]);
  });

  it('片付けたら開き直すまで片付けたまま。間のシグナルは activeSinceDismissed で知らせる', () => {
    const s = deriveComm([signal(9, CAROL, [US]), dismissed(10), signal(11, CAROL, [US])]);
    expect(s).toMatchObject({ dismissed: true, activeSinceDismissed: true });
    expect(deriveComm([signal(9, CAROL, [US]), dismissed(10), reopened(11)])).toMatchObject({ dismissed: false, activeSinceDismissed: false });
  });

  it('H4 返事期待は記録した送信から。期限超過は ReplyOverdue がその送信を指しているときだけ。続いているかはクエリ層（turn.test.ts）', () => {
    const sent = signal(9, US, [CAROL, DAVE], at(12));
    const late = overdue(13, sent.signalId!);
    expect(deriveComm([sent, late])).toMatchObject({ replyExpectedBy: at(12), replyExpectedSignalId: sent.signalId, overdue: true });
    // 新しい返事期待の送信で、前の超過は指さなくなる
    const next = signal(14, US, [CAROL], at(20));
    expect(deriveComm([sent, late, next])).toMatchObject({ replyExpectedBy: at(20), replyExpectedSignalId: next.signalId, overdue: false });
    // 片付けたら超過は数えない
    expect(deriveComm([sent, late, dismissed(14)]).overdue).toBe(false);
  });

  it('H8 外した位置は外したときのシグナルの位置で固定する。あとで移し替えても、手前の名指しは外れたまま（0038）', () => {
    const a = signal(9, CAROL, [US]);
    const b = signal(10, CAROL, [US]);
    const acked: ThreadLogEntry = { ...ack(11, b.signalId!, [US]), untilAt: b.at, untilSeq: b.seq };
    expect(pending(deriveComm([a, b, acked]))).toEqual([]);
    // b を別のスレッドへ移した（ログから消えた）あとも、a までの名指しは外れたまま
    expect(pending(deriveComm([a, acked]))).toEqual([]);
  });

  it('H2 メモ・リンク・属性は名指しを作らない', () => {
    const s = deriveComm([other(9, 'note'), other(10, 'linked')]);
    expect(s.attention).toEqual({ named: [], broadcasts: [], listAcks: {} });
  });
});
