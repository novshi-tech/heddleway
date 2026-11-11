import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceState } from '../../src/connectors/graph/state';
import { GatewayGtasksApi, GtasksError } from '../../src/connectors/gtasks/api';
import { dueDate, normalizeGtask } from '../../src/connectors/gtasks/normalize';
import { advanceCursor, isListCheckDue, isPollDue, LIST_CHECK_MINUTES, MAX_PAGES_PER_RUN, planPoll, POLL_SLACK_MS } from '../../src/connectors/gtasks/plan';
import { GtasksSync } from '../../src/connectors/gtasks/sync';
import { GtasksTask, verifiedEmail } from '../../src/connectors/gtasks/task';
import { GTASKS_SCOPE } from '../../src/connectors/gtasks/scope';
import { connectTaskList, listThreads, type ServiceDataSource } from '../../src/domain';
import { GatewayAuthError, inScope, type UpstreamCall } from '../../src/ports/gateway';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { FakeGtasks, gtask } from '../helpers/fake-gtasks';
import { makeService } from '../helpers/service';
import { seed } from '../helpers/world';

// Google Tasks のタスクのリストの取り込み（0041 の決定 3）。ゲートウェイと Google の API は偽物

const CONNECTED = '2026-11-11T00:00:00.000Z';
const ctx = { dataSourceId: 'ds_gt', account: 'bob@gws.example', listName: 'Murmur', connectedAt: CONNECTED };
const parse = (t: unknown) => GtasksTask.parse(t);

describe('H9 Google Tasks のタスクの正規化（決まった形の写し）', () => {
  it('完了・本人・件名（前後の空白は除く）・リストの名前・期限の日付を写す。本文とリンクは写さない', () => {
    const n = normalizeGtask(ctx, parse(gtask({ id: 'T1', title: ' DEV-12 の調査 ', due: '2026-11-20', at: '2026-11-11T01:00:00.000Z' })));
    expect(n).toEqual({
      kind: 'mirror',
      mirror: {
        kind: 'mirror',
        dataSourceId: 'ds_gt',
        channel: 'todo',
        threadKey: 'T1',
        fields: { closed: false, holders: ['bob@gws.example'], title: 'DEV-12 の調査', statusLabel: 'Murmur', due: '2026-11-20' },
        sourceRef: 'gtasks:T1:2026-11-11T01:00:00.000Z',
      },
    });
  });

  it('完了・削除・非表示は閉じる', () => {
    for (const over of [{ status: 'completed' as const }, { deleted: true }, { hidden: true }]) {
      expect(normalizeGtask(ctx, parse(gtask({ id: 'T2', at: '2026-11-11T02:00:00.000Z', ...over })))).toMatchObject({ kind: 'mirror', mirror: { fields: { closed: true, due: null } } });
    }
  });

  it('期限は日付の部分をそのまま使う（UTC の 0 時として返る。タイムゾーンで丸めない）。なければ null', () => {
    expect(dueDate({ due: '2026-11-20T00:00:00.000Z' })).toBe('2026-11-20');
    expect(dueDate({ due: '2026-11-20T23:59:59.000Z' })).toBe('2026-11-20');
    expect(dueDate({ due: '2026-11-20' })).toBe('2026-11-20');
    expect(dueDate({ due: null })).toBeNull();
    expect(dueDate({})).toBeNull();
    expect(dueDate({ due: 'いつか' })).toBeNull();
  });

  it('サブタスクは親と同じ 1 つずつのタスクとして写す（親子は写さない）', () => {
    const n = normalizeGtask(ctx, parse(gtask({ id: 'T3', parent: 'T1', at: '2026-11-11T03:00:00.000Z' })));
    expect(n).toMatchObject({ kind: 'mirror', mirror: { threadKey: 'T3', fields: { closed: false, title: '件名' } } });
    expect(JSON.stringify(n)).not.toContain('T1');
  });

  it('件名のないタスクは写さない。閉じたものは、すでにあるスレッドを閉じる印だけ渡す', () => {
    expect(normalizeGtask(ctx, parse(gtask({ id: 'T4', title: '  ', at: '2026-11-11T04:00:00.000Z' })))).toEqual({ kind: 'skip', reason: 'no title' });
    expect(normalizeGtask(ctx, parse(gtask({ id: 'T5', title: null, at: '2026-11-11T04:00:00.000Z' })))).toEqual({ kind: 'skip', reason: 'no title' });
    expect(normalizeGtask(ctx, parse(gtask({ id: 'T6', title: null, deleted: true, at: '2026-11-11T04:00:00.000Z' })))).toMatchObject({
      kind: 'mirror',
      mirror: { threadKey: 'T6', fields: { closed: true } },
    });
  });

  it('つなぐ前に閉じたきりのもの（完了・削除・非表示）は取り込まない。つないだあとに変わったものは取り込む', () => {
    for (const over of [{ status: 'completed' as const }, { deleted: true }, { hidden: true }]) {
      expect(normalizeGtask(ctx, parse(gtask({ id: 'T7', at: '2026-11-10T23:59:59.000Z', ...over })))).toEqual({ kind: 'skip', reason: 'closed before connecting' });
      expect(normalizeGtask(ctx, parse(gtask({ id: 'T7', at: '2026-11-11T00:00:01.000Z', ...over })))).toMatchObject({ kind: 'mirror' });
    }
    // 開いているタスクは、つなぐ前から変わっていなくても取り込む
    expect(normalizeGtask(ctx, parse(gtask({ id: 'T8', at: '2026-10-01T00:00:00.000Z' })))).toMatchObject({ kind: 'mirror', mirror: { fields: { closed: false } } });
  });

  it('sourceRef は updated を含む（同じタスクの更新ごとに変わる）', () => {
    const ref = (at: string) => (normalizeGtask(ctx, parse(gtask({ id: 'T9', at }))) as { mirror: { sourceRef: string } }).mirror.sourceRef;
    expect(ref('2026-11-11T05:00:00.000Z')).not.toBe(ref('2026-11-11T05:00:01.000Z'));
  });
});

describe('H9 Google Tasks のアカウント（userinfo）', () => {
  it('email があり、確認済みのときだけアドレスにする', () => {
    expect(verifiedEmail({ email: ' bob@gws.example ', email_verified: true })).toBe('bob@gws.example');
    expect(verifiedEmail({ email: 'bob@gws.example', email_verified: 'true' })).toBe('bob@gws.example');
    expect(verifiedEmail({ email: 'bob@gws.example', email_verified: false })).toBe('');
    expect(verifiedEmail({ email: 'bob@gws.example' })).toBe('');
    expect(verifiedEmail({ email_verified: true })).toBe('');
  });
});

describe('H9 Google Tasks の見回りの計画（純関数）', () => {
  const T0 = '2026-11-11T10:00:00.000Z';
  const at = (min: number, sec = 0) => new Date(Date.parse(T0) + min * 60_000 + sec * 1000).toISOString();

  it('間隔がなければ見回りのたび。あれば最後に読み終えてからその分たったときだけ（時刻のぶれの分は手前から通す）', () => {
    expect(isPollDue(at(5), T0, undefined)).toBe(true);
    expect(isPollDue(at(0), null, 15)).toBe(true);
    expect(isPollDue(at(5), T0, 15)).toBe(false);
    expect(isPollDue(at(14), T0, 15)).toBe(false);
    expect(isPollDue(at(15), T0, 15)).toBe(true);
    expect(isPollDue(at(15, -POLL_SLACK_MS / 1000 + 1), T0, 15)).toBe(true);
    expect(isPollDue(at(15, -60), T0, 15)).toBe(false);
  });

  const source = (over: Partial<SourceState>): SourceState => ({ kind: 'gtasks', dataSourceId: 'ds', userId: 'u', gatewayCredentialId: 'g', status: 'ok', reason: null, folders: {}, connectedAt: T0, lastSyncAt: T0, lastRetryAt: null, ...over });

  it('planPoll: 外したものは何もしない。broken は 1 時間おきに試し直す。setup のままなら読み直す。ok は間隔で決める', () => {
    expect(planPoll(source({ status: 'disconnected' }), at(60), undefined)).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: null }), at(5), undefined)).toEqual({ kind: 'retry' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: T0 }), at(30), undefined)).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: T0 }), at(60), undefined)).toEqual({ kind: 'retry' });
    expect(planPoll(source({ status: 'setup' }), at(5), 15)).toEqual({ kind: 'setup' });
    expect(planPoll(source({}), at(5), undefined)).toEqual({ kind: 'poll' });
    expect(planPoll(source({}), at(5), 15)).toEqual({ kind: 'idle' });
    expect(planPoll(source({}), at(15), 15)).toEqual({ kind: 'poll' });
    // 読みかけは間隔を待たない
    expect(planPoll(source({ gtasks: { updatedMin: null, resume: { pageToken: 'p', maxUpdated: null } } }), at(5), 15)).toEqual({ kind: 'poll' });
  });

  it('advanceCursor: 見えた中で一番大きい updated まで進める。何も見えなければそのまま。戻らない', () => {
    expect(advanceCursor(null, ['2026-11-11T01:00:00.000Z', '2026-11-11T03:00:00.000Z', '2026-11-11T02:00:00.000Z'])).toBe('2026-11-11T03:00:00.000Z');
    expect(advanceCursor('2026-11-11T02:00:00.000Z', [])).toBe('2026-11-11T02:00:00.000Z');
    expect(advanceCursor(null, [])).toBeNull();
    expect(advanceCursor('2026-11-11T05:00:00.000Z', ['2026-11-11T03:00:00.000Z'])).toBe('2026-11-11T05:00:00.000Z');
    // 秒未満の桁数が違っても時刻で比べる
    expect(advanceCursor('2026-11-11T05:00:00Z', ['2026-11-11T05:00:00.500Z'])).toBe('2026-11-11T05:00:00.500Z');
  });

  it('リストの名前の確かめ直しは間引く', () => {
    expect(isListCheckDue(T0, null)).toBe(true);
    expect(isListCheckDue(at(LIST_CHECK_MINUTES - 1), T0)).toBe(false);
    expect(isListCheckDue(at(LIST_CHECK_MINUTES), T0)).toBe(true);
  });
});

describe('H9 Google Tasks の読み取りの口', () => {
  const calls: string[] = [];
  const reply = (status: number, body: unknown): UpstreamCall => async (method, path) => {
    calls.push(`${method} ${path}`);
    return Response.json(body, { status });
  };

  it('呼ぶ口は全部 GTASKS_SCOPE の中（GET だけ）。ID とクエリは URL に直す。タスクは完了・非表示・削除も読む', async () => {
    calls.length = 0;
    const api = new GatewayGtasksApi(async (method, path) => {
      calls.push(`${method} ${path}`);
      return Response.json(path.includes('/tasks/v1/users/@me/lists/') ? { id: 'L', title: 'l' } : { items: [], email: 'x@y', email_verified: true });
    });
    await api.account();
    await api.lists();
    await api.list('a/b c');
    await api.tasks('a/b c', { updatedMin: '2026-11-11T01:02:03.456Z', pageToken: 'tok/1' });
    await api.tasks('L1');
    expect(calls).toEqual([
      'GET /oauth2/v3/userinfo',
      'GET /tasks/v1/users/@me/lists?maxResults=100',
      'GET /tasks/v1/users/@me/lists/a%2Fb%20c',
      'GET /tasks/v1/lists/a%2Fb%20c/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true&updatedMin=2026-11-11T01%3A02%3A03.456Z&pageToken=tok%2F1',
      'GET /tasks/v1/lists/L1/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true',
    ]);
    for (const c of calls) {
      const [method, path] = c.split(' ') as ['GET', string];
      expect(inScope(GTASKS_SCOPE, method, path), c).toBe(true);
    }
  });

  it('リストの一覧は nextPageToken をたどる。items がなければ空', async () => {
    const urls: string[] = [];
    const api = new GatewayGtasksApi(async (_m, path) => {
      urls.push(path);
      return Response.json(path.includes('pageToken=p2') ? { items: [{ id: 'B', title: 'b' }] } : { items: [{ id: 'A', title: 'a' }], nextPageToken: 'p2' });
    });
    expect((await api.lists()).map((l) => l.id)).toEqual(['A', 'B']);
    expect(urls[1]).toContain('pageToken=p2');
    expect(await new GatewayGtasksApi(reply(200, {})).lists()).toEqual([]);
  });

  it('エラー: 404 はリストなし（list は null、tasks は GtasksError）。401・403 は同意の問題。上限（429・403 の rateLimit）は試し直す側', async () => {
    const err = (status: number, s: string, extra: object = {}) => ({ error: { code: status, message: 'm', status: s, ...extra } });
    expect(await new GatewayGtasksApi(reply(404, err(404, 'NOT_FOUND'))).list('L')).toBeNull();
    await expect(new GatewayGtasksApi(reply(404, err(404, 'NOT_FOUND'))).tasks('L')).rejects.toMatchObject({ name: 'GtasksError', status: 404 });
    await expect(new GatewayGtasksApi(reply(401, err(401, 'UNAUTHENTICATED'))).lists()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(new GatewayGtasksApi(reply(403, err(403, 'PERMISSION_DENIED'))).lists()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(new GatewayGtasksApi(reply(429, err(429, 'RESOURCE_EXHAUSTED'))).lists()).rejects.toBeInstanceOf(GtasksError);
    await expect(new GatewayGtasksApi(reply(403, err(403, 'PERMISSION_DENIED', { errors: [{ reason: 'rateLimitExceeded' }] }))).lists()).rejects.toBeInstanceOf(GtasksError);
    await expect(new GatewayGtasksApi(reply(403, { error: 'consent revoked' })).lists()).rejects.toBeInstanceOf(GatewayAuthError);
  });
});

describe('H9 Google Tasks の取り込み（見回り）', () => {
  let gt: FakeGtasks;
  let state: MemoryConnectorState;
  let now: string;
  let made: Awaited<ReturnType<typeof makeService>>;
  let dsId: string;
  let logs: Record<string, unknown>[];
  const build = (pollMinutes?: number) =>
    new GtasksSync({ service: made.service, state, gtasksFor: async () => gt, now: () => now, pollMinutes, log: (e) => void logs.push(e) });
  let sync: GtasksSync;

  beforeEach(async () => {
    gt = new FakeGtasks();
    state = new MemoryConnectorState();
    logs = [];
    now = '2026-11-11T00:00:00.000Z';
    made = await makeService(seed);
    const { result } = await made.service.changeMaster('u_bob', 'Google Tasks をつなぐ', (d, c) =>
      connectTaskList(d, c, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: '', address: 'bob.gt@gws.example', listId: 'L_murmur', listName: 'Murmur', service: 'google-tasks' }),
    );
    dsId = result.dataSource.id;
    await state.putSource({ kind: 'gtasks', dataSourceId: dsId, userId: 'u_bob', gatewayCredentialId: 'gw_bob', status: 'setup', reason: null, folders: {}, connectedAt: CONNECTED, lastSyncAt: null, lastRetryAt: null });
    sync = build();
  });

  const threads = async () => listThreads(await made.service.directory(), { userId: 'u_bob', contactId: 'p_bob', listIds: [], dataSourceIds: [dsId] }, await made.service.state(), { filter: 'all' });
  const mirrorEvents = async () => (await made.repo.events.read()).filter((e) => e.type === 'ThreadMirrored');

  it('setup: リストを全部読み（updatedMin なし・完了なども読む）、開いているタスクを写す。cursor は一番新しい updated。ok になる', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', due: '2026-11-20', at: '2026-11-10T00:00:00.000Z' }));
    gt.put('L_murmur', gtask({ id: 'T2', title: '前に終えたもの', status: 'completed', at: '2026-11-09T00:00:00.000Z' }));
    gt.put('L_murmur', gtask({ id: 'T3', title: '請求書を送る', at: '2026-11-10T05:00:00.000Z' }));
    gt.put('L_murmur', gtask({ id: 'T4', title: '消したもの', deleted: true, at: '2026-11-10T06:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect((await threads()).map((t) => [t.title, t.source?.due, t.closedAtSource]).sort()).toEqual([
      ['見積を取る', '2026-11-20', false],
      ['請求書を送る', null, false],
    ]);
    expect(gt.taskCalls.every((c) => c.updatedMin === null && c.listId === 'L_murmur')).toBe(true);
    expect(gt.taskCalls.map((c) => c.pageToken)).toEqual([null, 'tok:2']);
    expect(await state.source(dsId)).toMatchObject({ status: 'ok', lastSyncAt: now, gtasks: { updatedMin: '2026-11-10T06:00:00.000Z', resume: null } });
    // ほかのリストは読まない。購読のような呼び出しもない
    expect(gt.calls.every((c) => c.fn === 'list' || c.listId === 'L_murmur')).toBe(true);
  });

  it('maintain: cursor を updatedMin に渡し、変わったものだけ写す。完了は閉じる。cursor は進む。何も来なければそのまま', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-11T00:01:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const before = (await mirrorEvents()).length;
    gt.calls.length = 0;

    now = '2026-11-11T00:05:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', due: '2026-11-21', at: '2026-11-11T01:00:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toEqual([{ fn: 'tasks', listId: 'L_murmur', updatedMin: '2026-11-11T00:01:00.000Z', pageToken: null }]);
    expect((await mirrorEvents()).slice(before).map((e) => e.type === 'ThreadMirrored' && e.payload.fields)).toEqual([{ due: '2026-11-21' }]);
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-11T01:00:00.000Z');

    now = '2026-11-11T00:10:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', status: 'completed', due: '2026-11-21', at: '2026-11-11T02:00:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect((await threads())[0]).toMatchObject({ closedAtSource: true });

    // 何も変わっていない見回り（境界の 1 件だけ返る）: cursor は動かず、イベントも増えない
    const events = (await mirrorEvents()).length;
    now = '2026-11-11T00:15:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls.at(-1)).toMatchObject({ updatedMin: '2026-11-11T02:00:00.000Z' });
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-11T02:00:00.000Z');
    expect(await mirrorEvents()).toHaveLength(events);
  });

  it('同じタスクが 2 度返っても（updatedMin の境界）スレッドもイベントも増えない。削除されたものは閉じる', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-11T00:01:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const before = await mirrorEvents();
    expect(before).toHaveLength(1);
    // 境界のタスクはもう一度返る（updated >= updatedMin）
    for (let i = 0; i < 3; i++) {
      now = `2026-11-11T00:0${5 + i}:00.000Z`;
      await sync.handle({ kind: 'maintain' });
    }
    expect(gt.taskCalls.slice(-3).every((c) => c.updatedMin === '2026-11-11T00:01:00.000Z')).toBe(true);
    expect(await mirrorEvents()).toHaveLength(1);
    expect(await threads()).toHaveLength(1);

    now = '2026-11-11T01:00:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: null, deleted: true, at: '2026-11-11T00:30:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect((await threads())[0]).toMatchObject({ title: '見積を取る', closedAtSource: true });
  });

  it('ページをたどる。上限で止めたら読みかけの位置を残し、cursor は進めず、次の見回りが続ける（更新順でなく並び順で返るため）', async () => {
    gt.pageSize = 1;
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', at: '2026-11-11T00:00:10.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    // 並びの先頭が新しく、後ろが古い。上限で止まったときに先頭の updated まで進めると、後ろを飛ばす
    for (let i = 0; i < MAX_PAGES_PER_RUN + 3; i++) gt.put('L_murmur', gtask({ id: `N${i}`, title: `n${i}`, at: `2026-11-11T0${i < 12 ? 2 : 1}:${String(i + 10).padStart(2, '0')}:00.000Z` }));
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    let s = (await state.source(dsId))!;
    expect(s.gtasks!.updatedMin).toBe('2026-11-11T00:00:10.000Z');
    expect(s.gtasks!.resume).toMatchObject({ pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    expect(logs.some((l) => l.msg === 'gtasks_sync_paged_out')).toBe(true);
    // 1 ページ目は境界の T0（もう写してある）。残りの 19 件が増えた
    expect(await threads()).toHaveLength(MAX_PAGES_PER_RUN);

    // 続き（間隔を設定していても待たない）
    sync = build(60);
    now = '2026-11-11T00:10:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls[0]).toMatchObject({ updatedMin: '2026-11-11T00:00:10.000Z', pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    s = (await state.source(dsId))!;
    expect(s.gtasks!.resume).toBeNull();
    expect(s.gtasks!.updatedMin).toBe('2026-11-11T02:21:00.000Z');
    expect(await threads()).toHaveLength(1 + MAX_PAGES_PER_RUN + 3);
  });

  it('読みかけの pageToken が無効になったら、同じ cursor から読み直す', async () => {
    gt.pageSize = 1;
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', at: '2026-11-11T00:00:10.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    await state.putSource({ ...(await state.source(dsId))!, gtasks: { updatedMin: null, resume: { pageToken: 'tok:5', maxUpdated: null } } });
    gt.invalidTokens.add('tok:5');
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls.slice(-2).map((c) => c.pageToken)).toEqual(['tok:5', null]);
    expect((await state.source(dsId))!.gtasks).toMatchObject({ resume: null, updatedMin: '2026-11-11T00:00:10.000Z' });
  });

  it('見回りの間隔（tasksPollMinutes）: 読み終えてから間隔がたつまで読まない。未設定なら見回りのたび', async () => {
    sync = build(15);
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-11T00:00:30.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    gt.calls.length = 0;
    for (const t of ['00:05', '00:10']) {
      now = `2026-11-11T${t}:00.000Z`;
      await sync.handle({ kind: 'maintain' });
    }
    expect(gt.calls).toEqual([]);
    now = '2026-11-11T00:15:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toHaveLength(1);
    expect((await state.source(dsId))!.lastSyncAt).toBe(now);
    // 失敗したら lastSyncAt は動かず、次の見回りでまた試す
    now = '2026-11-11T00:30:00.000Z';
    gt.failNextTasks = new GtasksError(429, 'RESOURCE_EXHAUSTED');
    await sync.handle({ kind: 'maintain' });
    expect(logs.some((l) => l.msg === 'gtasks_maintain_failed')).toBe(true);
    expect((await state.source(dsId))!.lastSyncAt).toBe('2026-11-11T00:15:00.000Z');
    now = '2026-11-11T00:35:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toHaveLength(1);

    // 間隔なし: 毎回
    sync = build();
    gt.calls.length = 0;
    for (const t of ['00:40', '00:45']) {
      now = `2026-11-11T${t}:00.000Z`;
      await sync.handle({ kind: 'maintain' });
    }
    expect(gt.taskCalls).toHaveLength(2);
  });

  it('リストの名前が変わったら、見回りでデータソースの名前と写しの statusLabel を直す（確かめるのは間引く）', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-11T00:01:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    gt.listsInfo[1]!.title = 'Murmur（UBS）';
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    // まだ確かめる時ではない
    expect((await made.service.directory()).dataSource(dsId)).toMatchObject({ connector: { listName: 'Murmur' } });
    now = '2026-11-11T01:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect((await made.service.directory()).dataSource(dsId)).toMatchObject({ name: 'Bob の Google Tasks（Murmur（UBS））', connector: { kind: 'google-tasks', listName: 'Murmur（UBS）' } });
    expect((await threads())[0]!.source?.statusLabel).toBe('Murmur（UBS）');
  });

  it('リストが消えたら止める（broken）。見回りの tasks の 404 でも、setup でも同じ。つなぎ直すと戻る', async () => {
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    // 名前の確かめより先に、tasks が 404
    now = '2026-11-11T00:05:00.000Z';
    gt.listsInfo.splice(1, 1);
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/見つからない/) });
    gt.listsInfo.push({ id: 'L_murmur', title: 'Murmur' });
    now = '2026-11-11T01:10:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'ok', reason: null });

    // 名前の確かめ（list が null）
    gt.listsInfo.splice(1, 1);
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect(await state.source(dsId)).toMatchObject({ status: 'broken', reason: expect.stringMatching(/見つからない/) });
    // 見回りの間の 404（名前の確かめが済んだあと）
    gt.listsInfo.push({ id: 'L_murmur', title: 'Murmur' });
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    gt.listsInfo.splice(1, 1);
    now = '2026-11-11T01:20:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'broken' });
  });

  it('同意の問題なら broken にして止め、見回りで試し直す（1 時間おき）。外したものは何もせず、外す仕事も消すものがない', async () => {
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    gt.authBroken = true;
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'broken', reason: 'credential must be reconnected', lastRetryAt: now });
    gt.authBroken = false;
    gt.calls.length = 0;
    now = '2026-11-11T00:30:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.calls).toEqual([]);
    now = '2026-11-11T01:10:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'ok' });

    await state.putSource({ ...(await state.source(dsId))!, status: 'disconnected', reason: '本人が外した' });
    gt.calls.length = 0;
    await sync.handle({ kind: 'disconnect', dataSourceId: dsId });
    gt.authBroken = true;
    now = '2026-11-11T05:00:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.calls).toEqual([]);
    expect(await state.source(dsId)).toMatchObject({ status: 'disconnected', reason: '本人が外した' });
  });

  it('スタンドが作った記録（record_sent）が先なら、あとから届く写しは同じスレッドに入る', async () => {
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const recorded = await made.service.recordSent('u_bob', { dataSourceId: dsId, to: [], toContactIds: [], subject: 'DEV-12 の調査', body: '期限は今週', sentRef: 'T9' });
    gt.put('L_murmur', gtask({ id: 'T9', title: 'DEV-12 の調査（本番）', due: '2026-11-14', at: '2026-11-11T03:00:00.000Z' }));
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    const all = await threads();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: recorded.thread.id, title: 'DEV-12 の調査（本番）', source: { due: '2026-11-14', statusLabel: 'Murmur' } });
  });

  it('H3 タスクのリストは本人だけの個人リスト。データソースの経路は google-tasks（チャネルは To Do と同じ todo）', async () => {
    const dir = await made.service.directory();
    expect(dir.dataSource(dsId)).toMatchObject({ channel: 'todo', name: 'Bob の Google Tasks（Murmur）', connector: { kind: 'google-tasks', listId: 'L_murmur', listName: 'Murmur' } });
    expect(dir.readersOfList(dir.listOfDataSource(dsId)!.id)).toEqual(['u_bob']);
    expect((dir.dataSource(dsId) as ServiceDataSource).selfAddresses).toEqual([]);
  });
});
