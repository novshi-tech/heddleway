import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncJob } from '../../src/connectors/graph/jobs';
import { jobsFromNotifications } from '../../src/connectors/graph/notifications';
import { sha256Hex } from '../../src/connectors/secrets';
import { normalizeTask } from '../../src/connectors/todo/normalize';
import { TodoSync } from '../../src/connectors/todo/sync';
import { TodoTask } from '../../src/connectors/todo/task';
import { connectTaskList, getThreadView, listThreads, type ServiceDataSource } from '../../src/domain';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { makeService } from '../helpers/service';
import { FakeTodo, todoTask } from '../helpers/fake-todo';
import { seed } from '../helpers/world';

// To Do のタスクのリストの取り込み（0039 の決定 3）。ゲートウェイと Graph は偽物

const CONNECTED = '2026-11-08T00:00:00.000Z';
const ctx = { dataSourceId: 'ds_todo', account: 'bob@ubs.example', listName: 'Murmur', connectedAt: CONNECTED };

describe('H9 To Do のタスクの正規化（決まった形の写し）', () => {
  const parse = (t: unknown) => TodoTask.parse(t);

  it('完了・本人・件名・リストの名前・期限の日付を写す。本文は写さない', () => {
    const n = normalizeTask(ctx, parse({ ...todoTask({ id: 'T1', title: ' DEV-12 の調査 ', due: '2026-11-20', at: '2026-11-08T01:00:00Z' }), body: { content: '本文' } }));
    expect(n).toEqual({
      kind: 'mirror',
      mirror: {
        kind: 'mirror',
        dataSourceId: 'ds_todo',
        channel: 'todo',
        threadKey: 'T1',
        fields: { closed: false, holders: ['bob@ubs.example'], title: 'DEV-12 の調査', statusLabel: 'Murmur', due: '2026-11-20' },
        sourceRef: 'todo:T1:2026-11-08T01:00:00Z',
      },
    });
    expect(normalizeTask(ctx, parse(todoTask({ id: 'T2', status: 'completed', at: '2026-11-08T02:00:00Z' })))).toMatchObject({ mirror: { fields: { closed: true, due: null } } });
  });

  it('消えたタスクは閉じる。つなぐ前に完了したきりのもの・件名のないものは取り込まない', () => {
    expect(normalizeTask(ctx, parse({ id: 'T3', '@removed': { reason: 'deleted' } }))).toMatchObject({ kind: 'mirror', mirror: { threadKey: 'T3', fields: { closed: true } } });
    expect(normalizeTask(ctx, parse(todoTask({ id: 'T4', status: 'completed', at: '2026-11-01T00:00:00Z' })))).toEqual({ kind: 'skip', reason: 'completed before connecting' });
    expect(normalizeTask(ctx, parse({ ...todoTask({ id: 'T5', at: '2026-11-08T03:00:00Z' }), title: '  ' }))).toEqual({ kind: 'skip', reason: 'no title' });
  });
});

describe('H9 To Do のキューの仕事', () => {
  let todo: FakeTodo;
  let state: MemoryConnectorState;
  let queued: SyncJob[];
  let now: string;
  let made: Awaited<ReturnType<typeof makeService>>;
  let sync: TodoSync;
  let dsId: string;

  beforeEach(async () => {
    todo = new FakeTodo();
    state = new MemoryConnectorState();
    queued = [];
    now = '2026-11-08T00:00:00.000Z';
    made = await makeService(seed);
    const { result } = await made.service.changeMaster('u_bob', 'To Do をつなぐ', (d, c) =>
      connectTaskList(d, c, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', address: 'bob.todo@ubs.example', listId: 'L_murmur', listName: 'Murmur' }),
    );
    dsId = result.dataSource.id;
    await state.putSource({
      kind: 'todo',
      dataSourceId: dsId,
      userId: 'u_bob',
      gatewayCredentialId: 'gw_bob',
      status: 'setup',
      reason: null,
      folders: {},
      connectedAt: CONNECTED,
      lastSyncAt: null,
      lastRetryAt: null,
    });
    sync = new TodoSync({
      service: made.service,
      state,
      queue: { send: async (j) => void queued.push(j) },
      todoFor: async () => todo,
      now: () => now,
      notificationUrl: 'https://murmur.test/webhooks/graph',
      newClientState: () => 'cs',
      hash: sha256Hex,
    });
  });

  const threads = async () => listThreads(await made.service.directory(), { userId: 'u_bob', contactId: 'p_bob', listIds: [], dataSourceIds: [dsId] }, await made.service.state(), { filter: 'all' });

  it('setup: サブスクリプションを作り、リストを読み切って開いているタスクを写す。ok になる', async () => {
    todo.put('L_murmur', todoTask({ id: 'T1', title: '見積を取る', due: '2026-11-20', at: '2026-11-07T00:00:00Z' }));
    todo.put('L_murmur', todoTask({ id: 'T2', title: '前に終えたもの', status: 'completed', at: '2026-11-06T00:00:00Z' }));
    todo.put('L_murmur', todoTask({ id: 'T3', title: '請求書を送る', at: '2026-11-07T01:00:00Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect([...todo.subscriptions.values()]).toEqual([expect.objectContaining({ listId: 'L_murmur', notificationUrl: 'https://murmur.test/webhooks/graph' })]);
    expect((await threads()).map((t) => [t.title, t.source?.due, t.closedAtSource]).sort()).toEqual([
      ['見積を取る', '2026-11-20', false],
      ['請求書を送る', null, false],
    ]);
    expect(await state.source(dsId)).toMatchObject({ status: 'ok', lastSyncAt: now, folders: { L_murmur: { lastReceivedAt: '2026-11-07T01:00:00Z' } } });
    // ほかのリストは読まない
    expect(todo.calls.filter((c) => c.startsWith('delta')).every((c) => c.includes('L_murmur'))).toBe(true);
  });

  it('通知: そのリストの delta の続きを読み、変わった項目だけ写す。完了・消したタスクは閉じる。同じ値なら何もしない', async () => {
    todo.put('L_murmur', todoTask({ id: 'T1', title: '見積を取る', at: '2026-11-08T00:01:00Z' }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const before = (await made.repo.events.read()).length;

    todo.put('L_murmur', todoTask({ id: 'T1', title: '見積を取る', due: '2026-11-21', at: '2026-11-08T01:00:00Z' }));
    todo.put('L_murmur', todoTask({ id: 'T1', title: '見積を取る', due: '2026-11-21', at: '2026-11-08T01:00:01Z' }));
    const { jobs } = await jobsFromNotifications(todo.notification('L_murmur'), { subscription: (id) => state.subscription(id), hash: sha256Hex });
    expect(jobs).toEqual([{ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' }]);
    await sync.handle(jobs[0]!);
    const events = (await made.repo.events.read()).slice(before);
    expect(events.map((e) => e.type === 'ThreadMirrored' && e.payload.fields)).toEqual([{ due: '2026-11-21' }]);

    todo.put('L_murmur', todoTask({ id: 'T1', title: '見積を取る', status: 'completed', due: '2026-11-21', at: '2026-11-08T02:00:00Z' }));
    await sync.handle({ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' });
    expect((await threads())[0]).toMatchObject({ closedAtSource: true });
    todo.put('L_murmur', { id: 'T1', '@removed': { reason: 'deleted' } });
    await sync.handle({ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' });
    expect((await made.repo.events.read()).slice(before)).toHaveLength(2);
  });

  it('スタンドが作った記録（record_sent）が先なら、あとから届く写しは同じスレッドに入る', async () => {
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    const recorded = await made.service.recordSent('u_bob', { dataSourceId: dsId, to: [], toContactIds: [], subject: 'DEV-12 の調査', body: '期限は今週', sentRef: 'T9' });
    todo.put('L_murmur', todoTask({ id: 'T9', title: 'DEV-12 の調査（本番）', due: '2026-11-14', at: '2026-11-08T03:00:00Z' }));
    await sync.handle({ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' });
    const all = await threads();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: recorded.thread.id, title: 'DEV-12 の調査（本番）', source: { due: '2026-11-14', statusLabel: 'Murmur' } });
    const view = getThreadView(await made.service.directory(), { userId: 'u_bob', contactId: 'p_bob', listIds: [], dataSourceIds: [dsId] }, await made.service.state(), recorded.thread.id)!;
    expect(view.timeline.map((e) => e.kind)).toEqual(['signal', 'mirrored']);
  });

  it('ページの上限で止めたら続きを積む。delta の位置が無効になったら最初から読み直す', async () => {
    todo.pageSize = 1;
    for (let i = 0; i < 25; i++) todo.put('L_murmur', todoTask({ id: `T${i}`, title: `t${i}`, at: `2026-11-08T00:${String(10 + i).padStart(2, '0')}:00Z` }));
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    expect(queued).toEqual([{ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' }]);
    await sync.handle(queued[0]!);
    expect(await threads()).toHaveLength(25);

    const link = (await state.source(dsId))!.folders.L_murmur!.link!;
    todo.invalidLinks.add(link);
    await sync.handle({ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' });
    expect(todo.calls).toContain('deltaStart L_murmur');
    expect(await threads()).toHaveLength(25);
  });

  it('同意の問題なら broken にして止め、見回りで試し直す。外したらサブスクリプションを消す', async () => {
    await sync.handle({ kind: 'setup', dataSourceId: dsId });
    todo.authBroken = true;
    await sync.handle({ kind: 'sync', dataSourceId: dsId, folder: 'L_murmur' });
    expect(await state.source(dsId)).toMatchObject({ status: 'broken', reason: 'credential must be reconnected' });
    todo.authBroken = false;
    now = '2026-11-08T02:00:00.000Z';
    await sync.handle({ kind: 'maintain' });
    expect(await state.source(dsId)).toMatchObject({ status: 'ok' });

    await state.putSource({ ...(await state.source(dsId))!, status: 'disconnected' });
    await sync.handle({ kind: 'disconnect', dataSourceId: dsId });
    expect(todo.subscriptions.size).toBe(0);
  });

  it('H3 タスクのリストは本人だけの個人リスト。データソースの経路は graph-todo', async () => {
    const dir = await made.service.directory();
    const ds = dir.dataSource(dsId) as ServiceDataSource;
    expect(ds).toMatchObject({ channel: 'todo', connector: { kind: 'graph-todo', listId: 'L_murmur', listName: 'Murmur' } });
    expect(dir.readersOfList(dir.listOfDataSource(dsId)!.id)).toEqual(['u_bob']);
  });
});
