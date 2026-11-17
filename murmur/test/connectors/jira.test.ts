import { describe, expect, it } from 'vitest';
import { JiraComment, JiraIssue } from '../../src/connectors/jira/issue';
import { adfText, commentSignal, createdSignal, itemsOfIssue, mentions, mirrorOf, toUtc } from '../../src/connectors/jira/normalize';
import { assigneeOf, attentionOf, createPersonalDataSource, deriveViewer, Directory, myTurnOf, planMasterEdit, type Seed } from '../../src/domain';
import { counterIds, makeService } from '../helpers/service';
import { answer, seed } from '../helpers/world';

// Jira のコネクタの写像（0034 の決定 4。S1）。応答の形は S0 の実物（docs/research/2026-11-04-jira-s0.md）を匿名化したもの

const ME = '5b00000000000000000000aa';
const KATO = '600000000000000000000bbb';
const MORI = '5d000000000000000000cccc';

const doc = (...paras: Array<Array<Record<string, unknown>>>) => ({ type: 'doc', version: 1, content: paras.map((content) => ({ type: 'paragraph', content })) });
const text = (t: string) => ({ type: 'text', text: t });
const mention = (id: string, name: string) => ({ type: 'mention', attrs: { id, text: `@${name}`, accessLevel: '' } });

function issue(over: { key?: string; assignee?: string | null; reporter?: string; status?: [string, string]; due?: string | null; created?: string; updated?: string; description?: unknown } = {}) {
  return JiraIssue.parse({
    id: '10001',
    key: over.key ?? 'SPW-2040',
    fields: {
      summary: '物件の立ち上げ',
      status: { name: over.status?.[0] ?? '進行中', statusCategory: { key: over.status?.[1] ?? 'indeterminate' } },
      assignee: over.assignee === null ? null : { accountId: over.assignee ?? KATO, displayName: '加藤', accountType: 'atlassian' },
      reporter: { accountId: over.reporter ?? MORI, displayName: '森', accountType: 'atlassian' },
      duedate: over.due === undefined ? '2026-11-20' : over.due,
      created: over.created ?? '2026-11-04T10:00:00.000+0900',
      updated: over.updated ?? '2026-11-04T13:37:57.144+0900',
      description: over.description ?? doc([text('鍵の受け渡しを確認する。SPW-1043 の続き')]),
    },
  });
}

const comment = (id: string, author: string, body: unknown, created = '2026-11-04T13:37:51.825+0900') =>
  JiraComment.parse({ id, author: { accountId: author, accountType: 'atlassian' }, body, created, updated: created });

describe('H9 Jira の写像（純関数）', () => {
  it('時刻は UTC にそろえる（Jira はコロンなしのオフセット）', () => {
    expect(toUtc('2026-11-04T13:37:57.144+0900')).toBe('2026-11-04T04:37:57.144Z');
    expect(toUtc('2026-11-04T04:37:57.144Z')).toBe('2026-11-04T04:37:57.144Z');
  });

  it('写しは 0031 の決まった形: 完了はステータスカテゴリ done、holders は担当者', () => {
    expect(mirrorOf('ds_j', issue())).toEqual({
      kind: 'mirror',
      dataSourceId: 'ds_j',
      channel: 'jira',
      threadKey: 'SPW-2040',
      fields: { closed: false, holders: [KATO], title: '物件の立ち上げ', statusLabel: '進行中', due: '2026-11-20' },
      sourceRef: 'jira:SPW-2040@2026-11-04T04:37:57.144Z',
    });
    expect(mirrorOf('ds_j', issue({ assignee: null, status: ['完了', 'done'], due: null })).fields).toMatchObject({ closed: true, holders: [], statusLabel: '完了', due: null });
  });

  it('起票: 起票した人から担当者へ。messageId は課題キー（記録した起票の sent_ref と同じ。H5）。本文の課題キーは結び候補', () => {
    expect(createdSignal('ds_j', issue())).toEqual({
      dataSourceId: 'ds_j',
      channel: 'jira',
      from: { channel: 'jira', value: MORI },
      to: [{ channel: 'jira', value: KATO }],
      subject: '[SPW-2040] 物件の立ち上げ',
      body: '鍵の受け渡しを確認する。SPW-1043 の続き',
      anchors: { messageId: 'SPW-2040', threadKey: 'SPW-2040', jiraKeys: ['SPW-1043'] },
      sourceRef: 'jira:SPW-2040',
      occurredAt: '2026-11-04T01:00:00.000Z',
    });
    // 自分で起票して自分が担当なら宛先なし
    expect(createdSignal('ds_j', issue({ assignee: MORI }))!.to).toEqual([]);
  });

  it('コメント: 宛先はメンションした人だけ（書いた本人は除く）。messageId は <課題キー>#c<ID>', () => {
    const withMention = comment('46922', KATO, doc([mention(ME, '野瀬'), text(' 確認お願いします')]));
    expect(commentSignal('ds_j', issue(), withMention)).toMatchObject({
      from: { channel: 'jira', value: KATO },
      to: [{ channel: 'jira', value: ME }],
      body: '@野瀬 確認お願いします',
      anchors: { messageId: 'SPW-2040#c46922', threadKey: 'SPW-2040' },
      sourceRef: 'jira:SPW-2040#c46922',
      occurredAt: '2026-11-04T04:37:51.825Z',
    });
    // メンションなし: 宛先なし（担当者や起票した人に補わない。0038 の未決 3）
    expect(commentSignal('ds_j', issue(), comment('1', KATO, doc([text('済みです')])))!.to).toEqual([]);
    expect(commentSignal('ds_j', issue(), comment('2', MORI, doc([text('ありがとう')])))!.to).toEqual([]);
  });

  it('ADF: 段落・改行・メンション・リンクのカードをテキストに。PR の URL は結び候補', () => {
    const body = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('1 行目'), { type: 'hardBreak' }, text('2 行目')] },
        { type: 'paragraph', content: [mention(KATO, '加藤'), text(' '), { type: 'inlineCard', attrs: { url: 'https://bitbucket.org/nvt/web/pull-requests/18' } }] },
      ],
    };
    expect(adfText(body)).toBe('1 行目\n2 行目\n@加藤 https://bitbucket.org/nvt/web/pull-requests/18');
    expect(mentions(body)).toEqual([KATO]);
    expect(commentSignal('ds_j', issue(), comment('3', MORI, body))!.anchors).toMatchObject({ prRefs: ['nvt/web#18'] });
  });

  it('更新された課題 1 件 → 写しが先、起票とコメントは since より後のものだけ（つなぐ前の過去は取らない）', () => {
    const since = '2026-11-04T02:00:00.000Z';
    const old = comment('46534', KATO, doc([text('前のコメント')]), '2026-10-09T15:13:13.042+0900');
    const fresh = comment('46922', KATO, doc([text('新しいコメント')]));
    const items = itemsOfIssue('ds_j', issue(), [fresh, old], since);
    expect(items.map((i) => ('kind' in i ? 'mirror' : i.sourceRef))).toEqual(['mirror', 'jira:SPW-2040#c46922']);
    const early = itemsOfIssue('ds_j', issue(), [], '2026-11-04T00:00:00.000Z');
    expect(early.map((i) => ('kind' in i ? 'mirror' : i.sourceRef))).toEqual(['mirror', 'jira:SPW-2040']);
  });
});

/** 本人（Bob）の Jira の個人リストを作ったマスタ（0034 の決定 1） */
function jiraSeed(): { seed: Seed; dataSourceId: string } {
  let dataSourceId = '';
  const newId = counterIds();
  const { after } = planMasterEdit(seed, (d) => {
    dataSourceId = createPersonalDataSource(
      d,
      'u_bob',
      { channel: 'jira', name: 'Bob の Jira', identity: ME, gatewayCredentialId: 'gw_jira' },
      { dir: new Directory(d), now: '2026-11-04T00:00:00.000Z', newId },
    ).dataSourceId;
  });
  return { seed: after, dataSourceId };
}

describe('H9 H5 H8 Jira の写像を取り込む（個人リスト）', () => {
  it('写しでスレッドができ、担当者が本人なら本人が担当。コメントのメンションも名指しとして残る。完了で誰にもない', async () => {
    const { seed: s, dataSourceId: ds } = jiraSeed();
    const { service, clock } = await makeService(s, { decide: () => answer({ needs_response: true }) });
    clock.set('2026-11-04T05:00:00.000Z');
    const since = '2026-11-04T00:00:00.000Z';
    for (const item of itemsOfIssue(ds, issue({ assignee: ME }), [comment('46922', KATO, doc([mention(ME, '野瀬'), text(' 確認お願いします')]))], since)) {
      await service.ingestItem(item);
    }
    const p = await service.state();
    const dir = await service.directory();
    const [t] = Object.values(p.threads).filter((x) => x.dataSourceId === ds);
    expect(t).toMatchObject({ title: '物件の立ち上げ', sourceKey: 'SPW-2040', closedAtSource: false });
    expect(t!.signalIds).toHaveLength(2);
    // 個人リストは本人が暗黙の担当（担当は出さない）。残っているかは名指しで決まる
    expect(assigneeOf(dir, t!)).toBeNull();
    expect(myTurnOf(dir, deriveViewer(dir, 'u_bob'), t!)).toEqual(['named']);

    // 同じ更新がもう一度届いても（重なり・通知と Cron の両方）二重にならない
    for (const item of itemsOfIssue(ds, issue({ assignee: ME }), [], since)) await service.ingestItem(item);
    expect((await service.state()).threads[t!.id]!.signalIds).toHaveLength(2);

    await service.ingestItem(mirrorOf(ds, issue({ assignee: ME, status: ['完了', 'done'], updated: '2026-11-04T15:00:00.000+0900' })));
    const done = (await service.state()).threads[t!.id]!;
    expect(done.closedAtSource).toBe(true);
    expect(myTurnOf(dir, deriveViewer(dir, 'u_bob'), done)).toEqual([]);
  });

  it('スタンドが記録した起票とコメントは、あとで取り込んでも 1 本のまま（H5）。相手がマスタになければアドレスのまま', async () => {
    const { seed: s, dataSourceId: ds } = jiraSeed();
    const { service, clock } = await makeService(s, { decide: () => answer({ needs_response: true }) });
    clock.set('2026-11-04T01:00:00.000Z');
    await service.recordSent('u_bob', { dataSourceId: ds, to: [KATO], toContactIds: [], subject: '[SPW-2040] 物件の立ち上げ', body: '起票', sentRef: 'SPW-2040', anchors: { threadKey: 'SPW-2040' } });
    clock.set('2026-11-04T04:40:00.000Z');
    await service.recordSent('u_bob', { dataSourceId: ds, to: [KATO], toContactIds: [], body: 'お願いします', sentRef: 'SPW-2040#c46923', anchors: { threadKey: 'SPW-2040' } });
    clock.set('2026-11-04T05:00:00.000Z');
    const mine = comment('46923', ME, doc([text('お願いします')]), '2026-11-04T13:40:00.000+0900');
    for (const item of itemsOfIssue(ds, issue({ reporter: ME }), [mine], '2026-11-04T00:00:00.000Z')) await service.ingestItem(item);
    const p = await service.state();
    const threads = Object.values(p.threads).filter((x) => x.dataSourceId === ds);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.signalIds).toHaveLength(2);
    // 加藤への名指しが残り、相手待ち（加藤はマスタにいないので、アドレスのまま）
    expect(attentionOf(await service.directory(), threads[0]!).named).toEqual([
      { address: { channel: 'jira', value: KATO }, userId: null, contactId: null, signalId: expect.any(String), at: '2026-11-04T04:40:00.000Z' },
    ]);
  });
});
