import { describe, expect, it } from 'vitest';
import {
  assigneeOf,
  attentionOf,
  deriveViewer,
  Directory,
  isAwaiting,
  isTriage,
  listThreads,
  myTurnOf,
  planMirror,
  Seed,
  type CoreContext,
  type InboundMirror,
  type InboundSignal,
} from '../../src/domain';
import { EventLog, ingestPure } from '../helpers/world';

// 再現: Jira の共有リスト（読者は直樹だけ）で、担当者でも起票者でもない読者の my_turn に出た件（2026-11-06 の実測。SPW-2475）。
// - 担当者（会田さん）と起票者（山本さん）の accountId は Contact に結ばれていない
// - 0038 の前は、起票のシグナルを AI が needs_response=true と判定するとボールが「こちら」になり、holders が解決できないので
//   担当者の写しが効かず、「読者が 1 人」で直樹に割り振られていた（by: reader）になっていた
// 0038 から: my_turn に出るのは、自分が担当・自分への名指し・リスト宛ての名指しが残っているもの（H8・H9）

const NAOKI = '5b44424e141cd45ff0698a68';
const AIDA = '712020:a9769c40-7345-4c70-8abe-7b57675aac93';
const YAMAMOTO = '63abca9efa5fbde2ba44a295';
const jira = (value: string) => ({ channel: 'jira' as const, value });

const seed = Seed.parse({
  users: [{ id: 'u_naoki', name: '直樹' }],
  contacts: [{ id: 'p_naoki', name: '直樹', userId: 'u_naoki' }],
  addresses: [{ id: 'a_naoki_jira', channel: 'jira', value: NAOKI, contactId: 'p_naoki' }],
  credentialRefs: [{ id: 'c_spw', principal: { kind: 'user', userId: 'u_naoki' }, address: jira(NAOKI) }],
  dataSources: [
    {
      kind: 'service',
      id: 'ds_423931eacf1448b08e6f',
      channel: 'jira',
      name: 'Jira SPW',
      credentialRefId: 'c_spw',
      selfAddresses: [],
      shared: { spaceKey: 'jira:urban-b/SPW', createdBy: 'u_naoki' },
    },
  ],
  lists: [{ id: 'l_spw', dataSourceId: 'ds_423931eacf1448b08e6f' }],
  listMembers: [{ listId: 'l_spw', userId: 'u_naoki' }],
});
const dir = new Directory(seed);
const naoki = deriveViewer(dir, 'u_naoki');
const DS = 'ds_423931eacf1448b08e6f';

function ctxAt(now: string): CoreContext {
  let n = 0;
  return { dir, now, newId: (prefix: string) => `${prefix}_${++n}` };
}

const mirror = (key: string, fields: InboundMirror['fields']): InboundMirror => ({
  kind: 'mirror',
  dataSourceId: DS,
  channel: 'jira',
  threadKey: key,
  fields,
  sourceRef: `jira:${key}@u1`,
});

/** normalize.ts の createdSignal と同じ形（宛先は担当者、起票した本人は除く） */
const created = (key: string, from: string, to: string[]): InboundSignal => ({
  dataSourceId: DS,
  channel: 'jira',
  from: jira(from),
  to: to.map(jira),
  subject: `[${key}] 件名`,
  body: '',
  anchors: { messageId: key, threadKey: key },
  sourceRef: `jira:${key}`,
  occurredAt: '2026-11-05T05:52:08.000Z',
});

const answer = (needs_response: boolean) => () => ({ thread: null, thread_id: null, title: null, needs_response, reason: 'r', confidence: 1 });

/** 写し → 起票のシグナルの順で取り込む（sync.ts の itemsOfIssue と同じ順） */
function issue(key: string, holders: string[], from: string, needsResponse: boolean) {
  const log = new EventLog();
  const ctx = ctxAt('2026-11-05T05:52:07.000Z');
  const plan = planMirror(log.state(), ctx, mirror(key, { closed: false, holders, title: key, statusLabel: '請求待ち', due: '2026-11-30' }));
  if (plan.kind !== 'mirrored') throw new Error('mirror not applied');
  log.push(plan.events, ctx.now);
  ingestPure(log, { ...ctx, now: '2026-11-05T05:52:08.000Z' }, created(key, from, holders.filter((h) => h !== from)), answer(needsResponse));
  const p = log.state();
  return { p, t: p.threads[plan.threadId]! };
}

describe('Jira の共有リストで、読者でない担当者の課題が読者の my_turn に出ない（SPW-2475 の再現。0038）', () => {
  it('H8 H9 担当者が読者でない（Contact もない）課題は、その人が担当で名指しもその人。読者の my_turn には出ず、こちらが送っていないので相手待ちにもならない', () => {
    const { p, t } = issue('SPW-2475', [AIDA], YAMAMOTO, true);
    expect(t.source?.holders).toEqual([AIDA]);
    expect(assigneeOf(dir, t)).toEqual({ by: 'source', userIds: [], contactIds: [], addresses: [jira(AIDA)] });
    expect(attentionOf(dir, t)).toMatchObject({ named: [{ address: jira(AIDA), userId: null, contactId: null }], list: null });
    expect(myTurnOf(dir, naoki, t)).toEqual([]);
    expect(isTriage(dir, t)).toBe(false);
    expect(isAwaiting(dir, t)).toBe(false);
    expect(listThreads(dir, naoki, p, { filter: 'my_turn' })).toEqual([]);
  });

  it('H8 H9 同じ形で AI が needs_response=false と判定した課題（SPW-2470 相当）と、担当と名指しが同じになる（AI の判定に依らない）', () => {
    const a = issue('SPW-2475', [AIDA], YAMAMOTO, true);
    const b = issue('SPW-2470', [AIDA], YAMAMOTO, false);
    const shape = (x: typeof a) => [assigneeOf(dir, x.t), attentionOf(dir, x.t).named.map((n) => n.address), myTurnOf(dir, naoki, x.t)];
    expect(shape(a)).toEqual(shape(b));
  });

  it('H8 H9 担当者が読者なら、その人の担当で、起票の名指しもその人（BO-2093 相当）', () => {
    const { p, t } = issue('BO-2093', [NAOKI], YAMAMOTO, true);
    expect(assigneeOf(dir, t)).toEqual({ by: 'source', userIds: ['u_naoki'], contactIds: [], addresses: [] });
    expect(myTurnOf(dir, naoki, t)).toEqual(['assignee', 'named']);
    expect(listThreads(dir, naoki, p, { filter: 'my_turn' }).map((x) => x.id)).toEqual([t.id]);
  });

  it('H8 共有リストでは「読者が 1 人」を理由に担当を決めない。担当者のいない課題は仕分け待ち', () => {
    const { t } = issue('SPW-2483', [], YAMAMOTO, true);
    expect(isTriage(dir, t)).toBe(true);
    expect(myTurnOf(dir, naoki, t)).toEqual([]);
  });
});

describe('Jira の共有リストの宛先のない連絡（0038 の未決 3）', () => {
  it('H8 メンションのないコメントは、共有リスト（group）でもリスト宛てにならない。読者の my_turn に出ない', () => {
    const groupSeed = Seed.parse({ ...seed, dataSources: seed.dataSources.map((d) => (d.kind === 'service' ? { ...d, group: true } : d)) });
    const gdir = new Directory(groupSeed);
    const viewer = deriveViewer(gdir, 'u_naoki');
    const log = new EventLog();
    const ctx = { dir: gdir, now: '2026-11-05T05:52:07.000Z', newId: ((n) => (prefix: string) => `${prefix}_${++n}`)(0) };
    const plan = planMirror(log.state(), ctx, mirror('SPW-2486', { closed: false, holders: [], title: '巡回チェック', statusLabel: 'To Do', due: null }));
    if (plan.kind !== 'mirrored') throw new Error('mirror not applied');
    log.push(plan.events, ctx.now);
    ingestPure(log, { ...ctx, now: '2026-11-05T05:52:08.000Z' }, created('SPW-2486', YAMAMOTO, []), answer(true));
    const t = log.state().threads[plan.threadId]!;
    expect(attentionOf(gdir, t).list).toBeNull();
    expect(myTurnOf(gdir, viewer, t)).toEqual([]);
    expect(isTriage(gdir, t)).toBe(true);
  });
});
