import { describe, expect, it } from 'vitest';
import { normalizeChannelMessage, messageText } from '../../src/connectors/teams/normalize';
import { ChannelMessage } from '../../src/connectors/teams/message';
import { connectTeamsChannel, deriveViewer, Directory, myTurnOf, planMasterEdit, seedProblems, type SharedSpacePlan } from '../../src/domain';
import { answer, makeCtx, seed } from '../helpers/world';
import { makeService } from '../helpers/service';

// Teams のチャネルの共有リスト（0036・0037）

const TENANT = 'tenant-1';
const CH = '19:abc@thread.skype';

const msg = (over: Record<string, unknown> = {}) =>
  ChannelMessage.parse({
    id: '1001',
    replyToId: null,
    messageType: 'message',
    createdDateTime: '2026-11-05T01:00:00.000Z',
    subject: '空調の件',
    body: { contentType: 'html', content: '<p><at id="0">Bob</at> さん、確認&amp;対応お願いします<br>明日まで</p>' },
    from: { user: { id: 'oid-alice', displayName: 'Alice', tenantId: TENANT } },
    mentions: [{ id: 0, mentionText: 'Bob', mentioned: { user: { id: 'oid-bob', displayName: 'Bob', tenantId: TENANT } } }],
    ...over,
  });

describe('H8 Teams のメッセージの正規化（0036 の決定 3・4）', () => {
  it('投稿: 送信者・個人へのメンションが宛先・本文は文に・アンカーは自分の ID', () => {
    expect(normalizeChannelMessage('ds_t', CH, msg())).toEqual({
      kind: 'signal',
      signal: {
        dataSourceId: 'ds_t',
        channel: 'teams',
        from: { channel: 'teams', value: 'tenant-1/oid-alice' },
        fromName: 'Alice',
        to: [{ channel: 'teams', value: 'tenant-1/oid-bob' }],
        subject: '空調の件',
        body: '@Bob さん、確認&対応お願いします\n明日まで',
        anchors: { messageId: '1001', threadTs: '1001' },
        sourceRef: `teams:${CH}/1001`,
        occurredAt: '2026-11-05T01:00:00.000Z',
      },
    });
  });

  it('返信: アンカー threadTs は投稿の ID。件名は投稿のもの', () => {
    const r = normalizeChannelMessage('ds_t', CH, msg({ id: '1002', replyToId: '1001', subject: null, mentions: [] }), msg());
    expect(r).toMatchObject({ kind: 'signal', signal: { anchors: { messageId: '1002', threadTs: '1001' }, subject: '空調の件', to: [] } });
  });

  it('チャネル・タグへのメンションは宛先にしない。システムのメッセージ・削除・アプリの投稿は取り込まない', () => {
    expect(normalizeChannelMessage('ds_t', CH, msg({ mentions: [{ id: 0, mentioned: { conversation: { id: CH } } }] }))).toMatchObject({ signal: { to: [] } });
    expect(normalizeChannelMessage('ds_t', CH, msg({ messageType: 'systemEventMessage' }))).toMatchObject({ kind: 'skip' });
    expect(normalizeChannelMessage('ds_t', CH, msg({ deletedDateTime: '2026-11-05T02:00:00Z' }))).toMatchObject({ kind: 'skip' });
    expect(normalizeChannelMessage('ds_t', CH, msg({ from: { user: null } }))).toMatchObject({ kind: 'skip' });
  });

  it('HTML を文にする（段落・改行・実体参照）。テキストはそのまま', () => {
    expect(messageText('<div>一行目</div><div>二行目&nbsp;&lt;x&gt;</div>', 'html')).toBe('一行目\n二行目 <x>');
    expect(messageText(' plain ', 'text')).toBe('plain');
  });
});

describe('H3 H8 Teams のチャネルの共有リスト', () => {
  const connect = () => {
    let plan!: SharedSpacePlan;
    const { after } = planMasterEdit(seed, (d) => {
      plan = connectTeamsChannel(d, makeCtx('2026-11-05T00:00:00.000Z'), {
        userId: 'u_alice',
        gatewayCredentialId: 'gw_alice_graph',
        teamId: 'team-1',
        teamName: '全社',
        channelId: CH,
        channelName: '電話対応',
        tenantId: TENANT,
        objectId: 'oid-alice',
      });
    });
    return { after, ds: plan.dataSource };
  };

  it('スペースに 1 つ。名乗りは <tenant>/<oid>。マスタは整合する', () => {
    const { after, ds } = connect();
    expect(ds).toMatchObject({ channel: 'teams', name: '全社 / 電話対応（Teams）', group: true, shared: { spaceKey: `teams:team-1/${CH}` }, connector: { kind: 'teams', teamId: 'team-1', channelId: CH } });
    expect(new Directory(after).contactIdOfAddress({ channel: 'teams', value: 'tenant-1/oid-alice' })).toBe('p_alice');
    expect(seedProblems(after)).toEqual([]);
  });

  it('投稿のメンションでその人に名指しが付き、返信は構造（threadTs）で投稿のスレッドに入る', async () => {
    const { after, ds } = connect();
    // Bob も読者で、Teams のアドレスを名乗っている
    const { after: withBob } = planMasterEdit(after, (d) => {
      d.listMembers.push({ listId: d.lists.find((l) => l.dataSourceId === ds.id)!.id, userId: 'u_bob' });
      d.addresses.push({ id: 'a_bob_teams', channel: 'teams', value: 'tenant-1/oid-bob', contactId: 'p_bob' });
    });
    const made = await makeService(withBob, { decide: () => answer({ needs_response: true, title: '空調の件' }) });
    const root = msg();
    const n1 = normalizeChannelMessage(ds.id, CH, root);
    const reply = msg({ id: '1002', replyToId: '1001', mentions: [], body: { contentType: 'html', content: '<p>見ておきます</p>' }, from: { user: { id: 'oid-bob', tenantId: TENANT } } });
    const n2 = normalizeChannelMessage(ds.id, CH, reply, root);
    if (n1.kind !== 'signal' || n2.kind !== 'signal') throw new Error('expected signals');

    await made.service.ingest(n1.signal);
    let p = await made.service.state();
    const [thread] = Object.values(p.threads).filter((t) => t.dataSourceId === ds.id);
    expect(myTurnOf(await made.service.directory(), deriveViewer(await made.service.directory(), 'u_bob'), thread!)).toEqual(['named']);

    expect(await made.service.ingest(n2.signal)).toMatchObject({ status: 'threaded', threadId: thread!.id });
    p = await made.service.state();
    expect(Object.values(p.threads).filter((t) => t.dataSourceId === ds.id)).toHaveLength(1);
    expect(p.threads[thread!.id]!.signalIds).toHaveLength(2);
  });
});
