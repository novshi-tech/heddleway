import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceState } from '../../src/connectors/graph/state';
import { GatewayGtasksApi, GtasksError } from '../../src/connectors/gtasks/api';
import { dueDate, normalizeGtask } from '../../src/connectors/gtasks/normalize';
import { advanceCursor, CURSOR_MARGIN_MS, finalCursor, isListCheckDue, isPollDue, LIST_CHECK_MINUTES, MAX_PAGES_PER_RUN, planPoll, planRead, POLL_SLACK_MS, SETUP_FRESH_MINUTES } from '../../src/connectors/gtasks/plan';
import { GtasksSync } from '../../src/connectors/gtasks/sync';
import { GtasksTask, listDisplayName, verifiedEmail } from '../../src/connectors/gtasks/task';
import { GTASKS_SCOPE } from '../../src/connectors/gtasks/scope';
import { connectTaskList, listThreads, type ServiceDataSource } from '../../src/domain';
import { GoogleApiNotEnabled } from '../../src/connectors/google-error';
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
    // つないだ直後に積んだ取り込みの仕事が新しい間は重ねて始めない（キューが処理する）。古ければ見回りが始める。読みかけがあれば続ける
    expect(planPoll(source({ status: 'setup' }), at(5), 15)).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'setup' }), at(SETUP_FRESH_MINUTES), 15)).toEqual({ kind: 'setup' });
    expect(planPoll(source({ status: 'setup', gtasks: { updatedMin: null, setupAt: at(20) } }), at(25), 15)).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'setup', gtasks: { updatedMin: null, resume: { pageToken: 'p', mode: 'full', updatedMin: null, startedAt: T0, maxUpdated: null } } }), at(1), 15)).toEqual({ kind: 'setup' });
    expect(planPoll(source({}), at(5), undefined)).toEqual({ kind: 'poll' });
    expect(planPoll(source({}), at(5), 15)).toEqual({ kind: 'idle' });
    expect(planPoll(source({}), at(15), 15)).toEqual({ kind: 'poll' });
    // 読みかけは間隔を待たない
    expect(planPoll(source({ gtasks: { updatedMin: null, resume: { pageToken: 'p', mode: 'full', updatedMin: null, startedAt: T0, maxUpdated: null } } }), at(5), 15)).toEqual({ kind: 'poll' });
  });

  it('advanceCursor: 見えた中で一番大きい updated まで進める。何も見えなければそのまま。戻らない', () => {
    expect(advanceCursor(null, ['2026-11-11T01:00:00.000Z', '2026-11-11T03:00:00.000Z', '2026-11-11T02:00:00.000Z'])).toBe('2026-11-11T03:00:00.000Z');
    expect(advanceCursor('2026-11-11T02:00:00.000Z', [])).toBe('2026-11-11T02:00:00.000Z');
    expect(advanceCursor(null, [])).toBeNull();
    expect(advanceCursor('2026-11-11T05:00:00.000Z', ['2026-11-11T03:00:00.000Z'])).toBe('2026-11-11T05:00:00.000Z');
    // 秒未満の桁数が違っても時刻で比べる
    expect(advanceCursor('2026-11-11T05:00:00Z', ['2026-11-11T05:00:00.500Z'])).toBe('2026-11-11T05:00:00.500Z');
  });

  it('finalCursor: 見えた一番新しい updated まで進めるが、読み始めた時刻の 1 分前より後にはしない。戻らない', () => {
    const started = '2026-11-11T10:00:00.000Z';
    const limit = new Date(Date.parse(started) - CURSOR_MARGIN_MS).toISOString();
    expect(limit).toBe('2026-11-11T09:59:00.000Z');
    // 読んでいる間（読み始め以後）に変わったタスクが見えても、読み始めの 1 分前で止める（読み直して重複しても無害）
    expect(finalCursor(null, ['2026-11-11T10:03:00.000Z', '2026-11-11T08:00:00.000Z'], started)).toBe(limit);
    expect(finalCursor('2026-11-11T08:00:00.000Z', ['2026-11-11T10:03:00.000Z'], started)).toBe(limit);
    // 余裕の手前なら、そのまま見えた一番新しい updated
    expect(finalCursor(null, ['2026-11-11T08:00:00.000Z', '2026-11-11T09:00:00.000Z'], started)).toBe('2026-11-11T09:00:00.000Z');
    // 何も見えなければ今のまま。すでに余裕より先にある cursor は戻さない
    expect(finalCursor(null, [], started)).toBeNull();
    expect(finalCursor('2026-11-11T08:00:00.000Z', [], started)).toBe('2026-11-11T08:00:00.000Z');
    expect(finalCursor('2026-11-11T09:59:30.000Z', ['2026-11-11T10:03:00.000Z'], started)).toBe('2026-11-11T09:59:30.000Z');
  });

  it('planRead: 読みかけの pageToken は、それが属する問い合わせでしか使わない', () => {
    const cursor = '2026-11-11T08:00:00.000Z';
    const fullResume = { pageToken: 'p', mode: 'full' as const, updatedMin: null, startedAt: T0, maxUpdated: '2026-11-11T07:00:00.000Z' };
    const deltaResume = { pageToken: 'q', mode: 'delta' as const, updatedMin: cursor, startedAt: T0, maxUpdated: null };
    // 読みかけがなければ、頼まれた問い合わせを最初から
    expect(planRead({ requested: 'delta', cursor, resume: null })).toEqual({ mode: 'delta', updatedMin: cursor, pageToken: null, maxUpdated: null, startedAt: null });
    expect(planRead({ requested: 'full', cursor, resume: undefined })).toEqual({ mode: 'full', updatedMin: null, pageToken: null, maxUpdated: null, startedAt: null });
    // 全部読む読みかけは、cursor があって差分を頼まれても全部読むまま続ける
    expect(planRead({ requested: 'delta', cursor, resume: fullResume })).toEqual({ mode: 'full', updatedMin: null, pageToken: 'p', maxUpdated: '2026-11-11T07:00:00.000Z', startedAt: T0 });
    expect(planRead({ requested: 'full', cursor, resume: fullResume })).toMatchObject({ mode: 'full', updatedMin: null, pageToken: 'p' });
    // 差分の読みかけは、同じ updatedMin の差分だけ続ける。全部読むのを頼まれたら、違う updatedMin なら捨てる
    expect(planRead({ requested: 'delta', cursor, resume: deltaResume })).toMatchObject({ mode: 'delta', updatedMin: cursor, pageToken: 'q', startedAt: T0 });
    expect(planRead({ requested: 'delta', cursor: '2026-11-11T09:00:00.000Z', resume: deltaResume })).toMatchObject({ pageToken: null, startedAt: null });
    expect(planRead({ requested: 'full', cursor, resume: deltaResume })).toEqual({ mode: 'full', updatedMin: null, pageToken: null, maxUpdated: null, startedAt: null });
  });

  it('listDisplayName: 名前が空なら名前のないリスト用の名前（空にしない）', () => {
    expect(listDisplayName('Murmur')).toBe('Murmur');
    expect(listDisplayName('')).toBe('(名前のないリスト)');
    expect(listDisplayName('  ')).toBe('(名前のないリスト)');
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
    await api.list('MTIz abc');
    await api.tasks('MTIz abc', { updatedMin: '2026-11-11T01:02:03.456Z', pageToken: 'tok/1' });
    await api.tasks('L1');
    expect(calls).toEqual([
      'GET /oauth2/v3/userinfo',
      'GET /tasks/v1/users/@me/lists?maxResults=100',
      'GET /tasks/v1/users/@me/lists/MTIz%20abc',
      'GET /tasks/v1/lists/MTIz%20abc/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true&updatedMin=2026-11-11T01%3A02%3A03.456Z&pageToken=tok%2F1',
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

  it('エラーの分類は構造化されたエラーで行う: 429・403 の上限の reason・RESOURCE_EXHAUSTED は試し直す側、API が有効でない 403 は同意の問題にしない', async () => {
    const e403 = (body: object) => reply(403, { error: { code: 403, message: 'm', ...body } });
    const quota = [
      { status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] },
      { errors: [{ reason: 'userRateLimitExceeded' }] },
      { errors: [{ reason: 'dailyLimitExceeded' }] },
      { errors: [{ reason: 'quotaExceeded' }] },
      { status: 'RESOURCE_EXHAUSTED' },
    ];
    for (const body of quota) await expect(new GatewayGtasksApi(e403(body)).lists(), JSON.stringify(body)).rejects.toBeInstanceOf(GtasksError);
    await expect(new GatewayGtasksApi(reply(429, { error: { code: 429 } })).lists()).rejects.toMatchObject({ name: 'GtasksError', status: 429 });
    // API が有効でない（デプロイの問題）: GatewayAuthError ではなく GoogleApiNotEnabled
    const disabled = [
      { status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }] },
      { status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] },
      { status: 'SERVICE_DISABLED' },
    ];
    for (const body of disabled) {
      const p = new GatewayGtasksApi(e403(body)).lists();
      await expect(p, JSON.stringify(body)).rejects.toBeInstanceOf(GoogleApiNotEnabled);
      await expect(new GatewayGtasksApi(e403(body)).lists()).rejects.not.toBeInstanceOf(GatewayAuthError);
    }
    await expect(new GatewayGtasksApi(e403(disabled[0]!)).lists()).rejects.toThrow(/Google Tasks API がゲートウェイの Google Cloud プロジェクトで有効になっていない/);
    // 文面だけでは分類しない（reason も status もなければ、従来どおり同意・権限の問題）
    await expect(new GatewayGtasksApi(e403({ status: 'PERMISSION_DENIED', message: 'Quota exceeded for quota metric rate limit' })).lists()).rejects.toBeInstanceOf(GatewayAuthError);
    // 権限の問題の 403 はそのまま
    await expect(new GatewayGtasksApi(e403({ status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] })).lists()).rejects.toBeInstanceOf(GatewayAuthError);
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
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-10T23:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const before = (await mirrorEvents()).length;
    gt.calls.length = 0;

    now = '2026-11-11T00:05:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', due: '2026-11-21', at: '2026-11-11T00:03:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toEqual([{ fn: 'tasks', listId: 'L_murmur', updatedMin: '2026-11-10T23:00:00.000Z', pageToken: null }]);
    expect((await mirrorEvents()).slice(before).map((e) => e.type === 'ThreadMirrored' && e.payload.fields)).toEqual([{ due: '2026-11-21' }]);
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-11T00:03:00.000Z');

    now = '2026-11-11T00:10:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', status: 'completed', due: '2026-11-21', at: '2026-11-11T00:08:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect((await threads())[0]).toMatchObject({ closedAtSource: true });

    // 何も変わっていない見回り（境界の 1 件だけ返る）: cursor は動かず、イベントも増えない
    const events = (await mirrorEvents()).length;
    now = '2026-11-11T00:15:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls.at(-1)).toMatchObject({ updatedMin: '2026-11-11T00:08:00.000Z' });
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-11T00:08:00.000Z');
    expect(await mirrorEvents()).toHaveLength(events);
  });

  it('同じタスクが 2 度返っても（updatedMin の境界）スレッドもイベントも増えない。削除されたものは閉じる', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-10T23:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const before = await mirrorEvents();
    expect(before).toHaveLength(1);
    // 境界のタスクはもう一度返る（updated >= updatedMin）
    for (let i = 0; i < 3; i++) {
      now = `2026-11-11T00:0${5 + i}:00.000Z`;
      await sync.handle({ kind: 'maintain' });
    }
    expect(gt.taskCalls.slice(-3).every((c) => c.updatedMin === '2026-11-10T23:00:00.000Z')).toBe(true);
    expect(await mirrorEvents()).toHaveLength(1);
    expect(await threads()).toHaveLength(1);

    now = '2026-11-11T01:00:00.000Z';
    gt.put('L_murmur', gtask({ id: 'T1', title: null, deleted: true, at: '2026-11-11T00:30:00.000Z' }));
    await sync.handle({ kind: 'maintain' });
    expect((await threads())[0]).toMatchObject({ title: '見積を取る', closedAtSource: true });
  });

  it('ページをたどる。上限で止めたら読みかけの位置を残し、cursor は進めず、次の見回りが続ける（更新順でなく並び順で返るため）', async () => {
    gt.pageSize = 1;
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', at: '2026-11-10T23:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    // 並びの先頭が新しく、後ろが古い。上限で止まったときに先頭の updated まで進めると、後ろを飛ばす
    for (let i = 0; i < MAX_PAGES_PER_RUN + 3; i++) gt.put('L_murmur', gtask({ id: `N${i}`, title: `n${i}`, at: `2026-11-11T0${i < 12 ? 2 : 1}:${String(i + 10).padStart(2, '0')}:00.000Z` }));
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    let s = (await state.source(dsId))!;
    expect(s.gtasks!.updatedMin).toBe('2026-11-10T23:00:00.000Z');
    expect(s.gtasks!.resume).toMatchObject({ pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    expect(logs.some((l) => l.msg === 'gtasks_sync_paged_out')).toBe(true);
    // 1 ページ目は境界の T0（もう写してある）。残りの 19 件が増えた
    expect(await threads()).toHaveLength(MAX_PAGES_PER_RUN);

    // 続き（間隔を設定していても待たない）
    sync = build(60);
    now = '2026-11-11T00:10:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls[0]).toMatchObject({ updatedMin: '2026-11-10T23:00:00.000Z', pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    s = (await state.source(dsId))!;
    expect(s.gtasks!.resume).toBeNull();
    // 読み切った cursor は、見えた一番新しい updated（02 時台）ではなく、読み始めた時刻（00:05）の 1 分前で止める
    expect(s.gtasks!.updatedMin).toBe('2026-11-11T00:04:00.000Z');
    expect(await threads()).toHaveLength(1 + MAX_PAGES_PER_RUN + 3);
  });

  it('読みかけの pageToken が無効になったら、同じ cursor から読み直す', async () => {
    gt.pageSize = 1;
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', at: '2026-11-11T00:00:10.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    await state.putSource({ ...(await state.source(dsId))!, gtasks: { updatedMin: null, resume: { pageToken: 'tok:5', mode: 'delta', updatedMin: null, startedAt: CONNECTED, maxUpdated: null } } });
    gt.invalidTokens.add('tok:5');
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls.slice(-2).map((c) => c.pageToken)).toEqual(['tok:5', null]);
    expect((await state.source(dsId))!.gtasks).toMatchObject({ resume: null, updatedMin: '2026-11-10T23:59:00.000Z' });
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

  it('リストの名前が変わったら、見回りでデータソースの名前と写しの statusLabel を直す（確かめるのは間引く）。cursor より古いタスクも全部読み直して直す', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-10T23:00:00.000Z' }));
    // cursor（一番新しい updated）より古いタスク。差分の読みでは二度と返らない
    gt.put('L_murmur', gtask({ id: 'T_old', title: '前からあるもの', at: '2026-11-01T00:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-10T23:00:00.000Z');
    expect((await byTitle('前からあるもの'))!.source?.statusLabel).toBe('Murmur');
    gt.listsInfo[1]!.title = 'Murmur（UBS）';
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' });
    // まだ確かめる時ではない
    expect((await made.service.directory()).dataSource(dsId)).toMatchObject({ connector: { listName: 'Murmur' } });
    expect((await byTitle('前からあるもの'))!.source?.statusLabel).toBe('Murmur');
    now = '2026-11-11T01:05:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect((await made.service.directory()).dataSource(dsId)).toMatchObject({ name: 'Bob の Google Tasks（Murmur（UBS））', connector: { kind: 'google-tasks', listName: 'Murmur（UBS）' } });
    // 全部読み直した（updatedMin なし）ので、cursor より古いタスクの statusLabel も直る
    expect(gt.taskCalls[0]).toMatchObject({ updatedMin: null });
    expect((await byTitle('見積を取る'))!.source?.statusLabel).toBe('Murmur（UBS）');
    expect((await byTitle('前からあるもの'))!.source?.statusLabel).toBe('Murmur（UBS）');
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

  /** n 件のタスクを並びの順に置く（updated は全部過去）。pageSize 1 なら 1 ページ 1 件 */
  const fill = (n: number, at = '2026-11-10T00:00:00.000Z') => {
    for (let i = 0; i < n; i++) gt.put('L_murmur', gtask({ id: `T${i}`, title: `t${i}`, at }));
  };
  const byTitle = async (title: string) => (await threads()).find((t) => t.title === title);

  it('H9 読んでいる間に更新されたタスクを取りこぼさない: 上限で止めた読みの途中で、読み済みのページ（t1）と未読のページ（t2 > t1）が更新されても、cursor は読み始めの 1 分前で止まり、次の見回りが t1 を読む', async () => {
    gt.pageSize = 1;
    fill(MAX_PAGES_PER_RUN + 5);
    await sync.handle({ kind: 'setup', dataSourceId: dsId }); // 読み始め 00:00。20 ページで止まる
    expect((await state.source(dsId))!.gtasks!.resume).toMatchObject({ pageToken: `tok:${MAX_PAGES_PER_RUN}`, startedAt: now });
    // 読み済み（T0）が先に、未読（最後の T24）があとに更新される
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', due: '2026-11-25', at: '2026-11-11T00:02:00.000Z' }));
    gt.put('L_murmur', gtask({ id: `T${MAX_PAGES_PER_RUN + 4}`, title: 'last', at: '2026-11-11T00:03:00.000Z' }));
    now = '2026-11-11T00:05:00.000Z';
    await sync.handle({ kind: 'maintain' }); // 続きを読み切る。T24（t2）が見える
    const s = (await state.source(dsId))!;
    expect(s.gtasks!.resume).toBeNull();
    expect(s.gtasks!.updatedMin).toBe('2026-11-10T23:59:00.000Z'); // t2（00:03）ではなく読み始め（00:00）の 1 分前
    expect((await byTitle('last'))!.title).toBe('last');
    expect((await byTitle('t0'))!.source?.due).toBeNull(); // まだ t1 の変更は見ていない
    now = '2026-11-11T00:10:00.000Z';
    await sync.handle({ kind: 'maintain' }); // cursor 以後の差分に t1 が入っている
    expect((await byTitle('t0'))!.source?.due).toBe('2026-11-25');
  });

  it('H9 読みかけの全部読みは、cursor があっても全部読みのまま続く（別の問い合わせに pageToken を渡さない）', async () => {
    gt.pageSize = 1;
    gt.put('L_murmur', gtask({ id: 'T0', title: 't0', at: '2026-11-10T00:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect((await state.source(dsId))!.gtasks!.updatedMin).toBe('2026-11-10T00:00:00.000Z');
    // broken からの戻り（全部読み直し）が、上限で止まる
    fill(MAX_PAGES_PER_RUN + 3, '2026-11-09T00:00:00.000Z');
    await state.putSource({ ...(await state.source(dsId))!, status: 'broken', reason: 'x', lastRetryAt: null });
    now = '2026-11-11T00:05:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls.every((c) => c.updatedMin === null)).toBe(true);
    expect((await state.source(dsId))!.gtasks!.resume).toMatchObject({ mode: 'full', updatedMin: null, pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    // 次の見回りは差分（cursor は null でない）を頼むが、続きは同じ全部読み
    now = '2026-11-11T00:10:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls[0]).toEqual({ fn: 'tasks', listId: 'L_murmur', updatedMin: null, pageToken: `tok:${MAX_PAGES_PER_RUN}` });
    expect((await state.source(dsId))!.gtasks!.resume).toBeNull();
    expect(await threads()).toHaveLength(MAX_PAGES_PER_RUN + 3);
  });

  it('H9 つないだ直後の取り込みは重ねて読まない（キューの仕事が新しい間は見回りが待つ）。失敗した取り込みは、読んだところから続ける', async () => {
    gt.pageSize = 1;
    fill(6);
    // 見回りが先に来ても、積んだばかりの取り込みは待つ
    now = '2026-11-11T00:02:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.calls).toEqual([]);
    // キューの仕事が 3 ページ目で失敗する
    gt.beforeTasks = (n) => {
      if (n === 3) throw new GtasksError(500, 'INTERNAL');
    };
    await expect(sync.handle({ kind: 'setup', dataSourceId: dsId })).rejects.toBeInstanceOf(GtasksError);
    expect((await state.source(dsId))!.gtasks!.resume).toMatchObject({ mode: 'full', pageToken: 'tok:2' });
    // 見回りは読みかけを 1 ページ目からやり直さず、続きから読む（読みかけがあれば新しくても続ける）
    gt.beforeTasks = null;
    gt.calls.length = 0;
    now = '2026-11-11T00:07:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls[0]).toMatchObject({ pageToken: 'tok:2' });
    expect(await state.source(dsId)).toMatchObject({ status: 'ok', gtasks: { resume: null } });
    expect(await threads()).toHaveLength(6);
  });

  it('H9 読んでいる間に外されたら、外したままにする（ページの途中で外しても、cursor・読みかけ・状態を書き戻さない）', async () => {
    gt.pageSize = 1;
    fill(5);
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    await state.putSource({ ...(await state.source(dsId))!, status: 'ok', gtasks: { updatedMin: null, resume: null } });
    gt.beforeTasks = async (n) => {
      if (n === 3) await state.putSource({ ...(await state.source(dsId))!, status: 'disconnected', reason: '本人が外した' });
    };
    now = '2026-11-11T00:05:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toHaveLength(3);
    const s = (await state.source(dsId))!;
    expect(s).toMatchObject({ status: 'disconnected', reason: '本人が外した' });
    expect(s.gtasks!.updatedMin).toBeNull();
    expect(logs.some((l) => l.msg === 'gtasks_sync_superseded')).toBe(true);
    // 続けて見回りが来ても何も読まない
    gt.calls.length = 0;
    now = '2026-11-11T00:10:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(gt.calls).toEqual([]);
  });

  it('H9 読んでいる間に別の接続につなぎ直されたら、つなぎ直した状態を上書きしない。古い接続の失敗で止めない', async () => {
    gt.pageSize = 1;
    fill(5);
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const reconnected = { ...(await state.source(dsId))!, gatewayCredentialId: 'gw_new', status: 'setup' as const, reason: null, gtasks: { updatedMin: null, resume: null, listCheckedAt: null, setupAt: '2026-11-11T00:05:00.000Z' } };
    gt.beforeTasks = async (n) => {
      if (n === 2) await state.putSource(reconnected);
    };
    now = '2026-11-11T00:05:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toEqual(reconnected);
    // 古い接続が同意の問題で失敗しても、新しい接続を broken にしない
    gt.calls.length = 0;
    gt.beforeTasks = async (n) => {
      if (n === 1) {
        await state.putSource({ ...reconnected, gatewayCredentialId: 'gw_newer' });
        throw new GatewayAuthError('old credential');
      }
    };
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect(await state.source(dsId)).toMatchObject({ gatewayCredentialId: 'gw_newer', status: 'setup', reason: null });
  });

  it('H9 上限（429・クォータの 403）は試し直す側: ok のまま、次の見回りが読む。API が有効でないときは broken にして理由を残す（同意の問題と書かない）', async () => {
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-10T00:00:00.000Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    now = '2026-11-11T00:05:00.000Z';
    gt.failNextTasks = new GtasksError(429, 'RESOURCE_EXHAUSTED');
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'ok', reason: null });
    now = '2026-11-11T00:10:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.taskCalls).toHaveLength(1);

    now = '2026-11-11T00:15:00.000Z';
    gt.failNextTasks = new GoogleApiNotEnabled('Google Tasks API');
    await sync.handle({ kind: 'maintain' });
    const broken = (await state.source(dsId))!;
    expect(broken).toMatchObject({ status: 'broken', lastRetryAt: now });
    expect(broken.reason).toMatch(/Google Tasks API がゲートウェイの Google Cloud プロジェクトで有効になっていない/);
    expect(broken.reason).not.toMatch(/同意/);
    // 毎回は試さない（1 時間おき）
    now = '2026-11-11T00:20:00.000Z';
    gt.calls.length = 0;
    await sync.handle({ kind: 'maintain' });
    expect(gt.calls).toEqual([]);
  });

  it('H9 見回りの間隔の基準は読み始めた時刻（読み終えた時刻にすると 15 分の間隔が読む時間の分だけずれていく）', async () => {
    let tick = Date.parse('2026-11-11T00:00:00.000Z');
    const slow = new GtasksSync({ service: made.service, state, gtasksFor: async () => gt, now: () => new Date((tick += 20_000)).toISOString(), pollMinutes: 15 });
    gt.put('L_murmur', gtask({ id: 'T1', title: '見積を取る', at: '2026-11-10T00:00:00.000Z' }));
    await slow.handle({ kind: 'setup', dataSourceId: dsId });
    const first = (await state.source(dsId))!.lastSyncAt!;
    // 読み始め（この run の最初の now()）に近い値。読み終わり（数回 now() を呼んだあと）ではない
    expect(Date.parse(first) - Date.parse('2026-11-11T00:00:00.000Z')).toBeLessThanOrEqual(20_000 * 3);
    const called = tick;
    await slow.handle({ kind: 'maintain' }); // 読み始め 20 秒後ではまだ間隔の前
    expect(tick).toBeGreaterThan(called);
    expect((await state.source(dsId))!.lastSyncAt).toBe(first);
  });

  it('H3 タスクのリストは本人だけの個人リスト。データソースの経路は google-tasks（チャネルは To Do と同じ todo）', async () => {
    const dir = await made.service.directory();
    expect(dir.dataSource(dsId)).toMatchObject({ channel: 'todo', name: 'Bob の Google Tasks（Murmur）', connector: { kind: 'google-tasks', listId: 'L_murmur', listName: 'Murmur' } });
    expect(dir.readersOfList(dir.listOfDataSource(dsId)!.id)).toEqual(['u_bob']);
    expect((dir.dataSource(dsId) as ServiceDataSource).selfAddresses).toEqual([]);
  });
});
