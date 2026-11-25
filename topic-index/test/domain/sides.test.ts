import { describe, expect, it } from 'vitest';
import { attentionOf, commView, Directory, isTriage, myTurnOf, recordSent, Seed } from '../../src/domain';
import { alice, answer, bob, dir, email, EventLog, ingestPure, makeCtx, seed } from '../helpers/world';

// クエリ層の「こちらのアドレスか」と名指しの解決（0030・0038）。fold はアドレスだけを畳み、読者か・リスト宛てか・どの Contact かは、読むときのマスタで決まる

const T = (h: number, m = 0) => `2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

describe('どちら側か（sides）', () => {
  it('H8 受信は窓口宛て（リスト宛て）で読者全員に、返信は相手への名指し（相手待ち）', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1' }), () => answer({ title: '雨漏り' }));
    const id = r.outcome!.threadId;
    expect(attentionOf(dir, log.state().threads[id]!)).toEqual({ named: [], list: { userIds: ['u_alice', 'u_bob'], signalId: r.signalId, at: T(9) } });
    expect(commView(dir, log.state().threads[id]!)).toMatchObject({ lastInboundAt: T(9), counterpartContactIds: ['p_carol'] });

    ctx.setNow(T(10));
    ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'o1', anchors: { inReplyTo: undefined } }), () =>
      answer({ thread: 'existing', thread_id: id }),
    );
    const t = log.state().threads[id]!;
    expect(attentionOf(dir, t).named).toMatchObject([{ address: { value: 'carol@example.com' }, userId: null, contactId: 'p_carol' }]);
    expect(commView(dir, t)).toMatchObject({ lastOutboundAt: T(10) });
  });

  it('H8 Contact に解決できない相手はアドレスのまま載る。名寄せすると Contact の名前が付くが、担当と名指しの付き方は変わらない（0030・0038）', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    // 知らない相手から受信 → 返信（CC に窓口と、知らない人を大文字で 2 回）
    const r = ingestPure(log, ctx, email({ from: 'stranger@nowhere.example', sourceRef: 'r1' }), () => answer({ title: '問い合わせ' }));
    const id = r.outcome!.threadId;
    ctx.setNow(T(10));
    ingestPure(
      log,
      ctx,
      email({ from: 'support@ubs.example', to: ['stranger@nowhere.example', 'support@ubs.example', 'Other@Nowhere.example', 'other@nowhere.example', 'carol@example.com'], sourceRef: 'o1' }),
      () => answer({ thread: 'existing', thread_id: id }),
    );
    const p = log.state();
    const t = p.threads[id]!;
    const unresolved = [
      { channel: 'email', value: 'Other@Nowhere.example' },
      { channel: 'email', value: 'stranger@nowhere.example' },
    ];
    const names = (d: Directory) => attentionOf(d, t).named.map((n) => [n.address.value, n.userId, n.contactId]);
    expect(names(dir)).toEqual([
      ['carol@example.com', null, 'p_carol'],
      ['Other@Nowhere.example', null, null],
      ['stranger@nowhere.example', null, null],
    ]);
    expect(commView(dir, t)).toMatchObject({ counterpartContactIds: ['p_carol'], counterpartAddresses: unresolved });

    // 名寄せ（マスタだけ直す。イベントはそのまま）
    const named = new Directory(
      Seed.parse({
        ...seed,
        contacts: [...seed.contacts, { id: 'p_stranger', name: '問い合わせの人' }],
        addresses: [...seed.addresses, { id: 'a_stranger', channel: 'email', value: 'stranger@nowhere.example', contactId: 'p_stranger' }],
      }),
    );
    expect(names(named)).toEqual([
      ['carol@example.com', null, 'p_carol'],
      ['Other@Nowhere.example', null, null],
      ['stranger@nowhere.example', null, 'p_stranger'],
    ]);
    expect(commView(named, t)).toMatchObject({ counterpartContactIds: ['p_carol', 'p_stranger'], counterpartAddresses: [unresolved[0]] });
  });

  it('H8 宛先のない送信・窓口だけに送ったものは、だれも名指ししない', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: [], sourceRef: 'o1' }), () => answer({ title: '控え' }));
    expect(attentionOf(dir, log.state().threads[r.outcome!.threadId]!)).toEqual({ named: [], list: null });
    const cc = ingestPure(log, ctx, email({ from: 'support@ubs.example', to: ['support@ubs.example'], sourceRef: 'o2' }), () => answer({ title: '控え 2' }));
    expect(attentionOf(dir, log.state().threads[cc.outcome!.threadId]!)).toEqual({ named: [], list: null });
  });

  it('H8 宛先に読者のアドレスがあれば、その人への名指し（受信の CC）。窓口宛ての分は読者全員', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const r = ingestPure(log, ctx, email({ from: 'carol@example.com', to: ['support@ubs.example', 'alice@ubs.example'], sourceRef: 'r1' }), () => answer());
    const t = log.state().threads[r.outcome!.threadId]!;
    expect(myTurnOf(dir, alice, t)).toEqual(['named', 'list']);
    expect(myTurnOf(dir, bob, t)).toEqual(['list']);
    expect(isTriage(dir, t)).toBe(true);
  });

  it('H3 H8 名寄せを後から直すと、イベントはそのままで過去のスレッドの相手と名指しが直る', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    // 知らないアドレスからの依頼（Bob の個人アドレスはまだ Bob に付いていない）
    const r = ingestPure(log, ctx, email({ from: 'frank@example.com', to: ['support@ubs.example', 'bob@ubs.example'], sourceRef: 'r1' }), () => answer());
    const id = r.outcome!.threadId;
    const p = log.state();
    expect(commView(dir, p.threads[id]!).counterpartContactIds).toEqual([]);
    expect(myTurnOf(dir, bob, p.threads[id]!)).toEqual(['list']);

    // あとから Frank を Contact にし、Bob の個人アドレスを Bob に付ける（イベントも投影も変えない）
    const fixed = new Directory(
      Seed.parse({
        ...seed,
        contacts: [...seed.contacts, { id: 'p_frank', name: 'Frank' }],
        addresses: [
          ...seed.addresses,
          { id: 'a_frank', channel: 'email', value: 'frank@example.com', contactId: 'p_frank' },
          { id: 'a_bob', channel: 'email', value: 'bob@ubs.example', contactId: 'p_bob' },
        ],
      }),
    );
    expect(commView(fixed, p.threads[id]!).counterpartContactIds).toEqual(['p_frank']);
    expect(myTurnOf(fixed, bob, p.threads[id]!)).toEqual(['named', 'list']);
  });

  it('H4 record_sent の from: 省けば窓口。指定するならそのデータソースでこちらのアドレス', () => {
    const log = new EventLog();
    const ctx = makeCtx(T(9));
    const base = { dataSourceId: 'ds_support', to: ['carol@example.com'], toContactIds: [], body: '調査します', sentRef: '<u1@x>' };
    const a = recordSent(log.state(), alice, ctx, base);
    expect(a.events[0]).toMatchObject({ type: 'OutboundRecorded', payload: { from: { value: 'support@ubs.example' } } });
    const b = recordSent(log.state(), alice, ctx, { ...base, from: 'alice@ubs.example' });
    expect(b.events[0]).toMatchObject({ type: 'OutboundRecorded', payload: { from: { value: 'alice@ubs.example' } } });
    expect(() => recordSent(log.state(), alice, ctx, { ...base, from: 'carol@example.com' })).toThrow(/not an address of this data source/);
    // 窓口のない個人の箱は本人のアドレス
    const c = recordSent(log.state(), alice, ctx, { ...base, dataSourceId: 'ds_alice', sentRef: '<u2@x>' });
    expect(c.events[0]).toMatchObject({ type: 'OutboundRecorded', payload: { from: { value: 'alice@ubs.example' } } });
  });
});
