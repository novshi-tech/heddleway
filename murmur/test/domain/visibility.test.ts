import { describe, expect, it } from 'vitest';
import { deriveViewer, getListView, getThreadView, listLists, listThreads, originOf, visibleSignals } from '../../src/domain';
import { alice, answer, bob, dir, email, eve, EventLog, ingestPure, line, makeCtx, mallory } from '../helpers/world';

// クエリ層の可視性（H3）: 見えるのはリストの読者だけ。個人のメールボックスやタスクのリストは本人だけ。テナント外は 0 件

function world() {
  const log = new EventLog();
  const ctx = makeCtx();
  const shared = ingestPure(log, ctx, email({ from: 'carol@example.com', sourceRef: 'r1', body: '共有の問い合わせ' }), () => answer({ title: '共有' }));
  ctx.setNow('2026-10-16T10:00:00.000Z');
  const personal = ingestPure(log, ctx, email({ dataSourceId: 'ds_alice', from: 'info@dave.example', to: ['alice@ubs.example'], sourceRef: 'r2', body: '個人宛ての見積' }), () =>
    answer({ title: '個人' }),
  );
  ctx.setNow('2026-10-16T11:00:00.000Z');
  const lineThread = ingestPure(log, ctx, line({ from: 'U_carol', sourceRef: 'l1', body: 'LINE の連絡' }), () => answer({ needs_response: false, confidence: 0.9 }));
  return { p: log.state(), shared: shared.outcome!.threadId, personal: personal.outcome!.threadId, line: lineThread.outcome!.threadId };
}

describe('可視性', () => {
  it('H3 listThreads は読者になっているデータソースのスレッドだけを返す', () => {
    const { p, shared, personal, line: l } = world();
    expect(listThreads(dir, alice, p, { filter: 'all' }).map((t) => t.id)).toEqual([personal, shared]);
    expect(listThreads(dir, bob, p, { filter: 'all' }).map((t) => t.id)).toEqual([l, shared]);
    expect(listThreads(dir, eve, p, { filter: 'all' })).toEqual([]);
    expect(listThreads(dir, alice, p, { filter: 'all', dataSourceId: 'ds_alice' }).map((t) => t.id)).toEqual([personal]);
    expect(listThreads(dir, mallory, p, { filter: 'all' })).toEqual([]);
  });

  it('H3 仕分け待ちは共有リストで担当のいない開いているもの。open は開いているもの', () => {
    const { p, shared, line: l } = world();
    expect(listThreads(dir, bob, p, { filter: 'triage' }).map((t) => t.id)).toEqual([l, shared]);
    expect(listThreads(dir, bob, p, { filter: 'open' }).map((t) => t.id)).toEqual([l, shared]);
  });

  it('H3 getThreadView は読者にだけ生の中身を返す', () => {
    const { p, shared, personal } = world();
    const view = getThreadView(dir, alice, p, personal);
    expect(view?.dataSource).toEqual({ id: 'ds_alice', name: 'Alice のメールボックス', kind: 'service', channel: 'email', origin: null });
    expect(JSON.stringify(view)).toContain('個人宛ての見積');
    expect(getThreadView(dir, bob, p, personal)).toBeNull();
    expect(getThreadView(dir, eve, p, shared)).toBeNull();
    expect(getThreadView(dir, alice, p, 'thr_nope')).toBeNull();
  });

  it('H3 visibleSignals はデータソースの読者の分だけ。ゴーストは Viewer になれない', () => {
    const { p } = world();
    expect(visibleSignals(alice, p)).toHaveLength(2);
    expect(visibleSignals(bob, p)).toHaveLength(2);
    expect(visibleSignals(eve, p)).toHaveLength(0);
    expect(visibleSignals(deriveViewer(dir, 'u_nobody'), p)).toHaveLength(0);
  });

  it('H3 getListView は読者にだけ、データソースと読者を返す', () => {
    expect(getListView(dir, alice, 'l_tasks_alice')).toMatchObject({
      dataSource: { id: 'ds_tasks_alice', kind: 'service', channel: 'todo' },
      readers: [{ contactId: 'p_alice', name: 'Alice' }],
    });
    expect(getListView(dir, bob, 'l_tasks_alice')).toBeNull();
    expect(getListView(dir, bob, 'l_line')?.dataSource.channel).toBe('line');
    expect(getListView(dir, alice, 'l_nope')).toBeNull();
  });

  it('H3 listLists は読者になっているリストだけを返す', () => {
    expect(listLists(dir, alice).map((l) => l.id)).toContain('l_tasks_alice');
    expect(listLists(dir, bob).map((l) => l.id)).not.toContain('l_tasks_alice');
    expect(listLists(dir, eve).map((l) => l.id)).toEqual(['l_slack']);
    expect(listLists(dir, mallory)).toEqual([]);
    expect(listLists(dir, deriveViewer(dir, 'u_nobody'))).toEqual([]);
  });

  it('H3 listThreads の since はそれより後に動いたスレッドだけ', () => {
    const { p, shared, personal, line: l } = world();
    expect(listThreads(dir, alice, p, { filter: 'all', since: '2026-10-16T09:30:00.000Z' }).map((t) => t.id)).toEqual([personal]);
    expect(listThreads(dir, bob, p, { filter: 'all', since: '2026-10-16T10:30:00.000Z' }).map((t) => t.id)).toEqual([l]);
    expect(listThreads(dir, bob, p, { filter: 'all', since: '2026-10-16T12:00:00.000Z' })).toEqual([]);
    expect(listThreads(dir, alice, p, { filter: 'all', since: '2026-01-01T00:00:00.000Z' }).map((t) => t.id)).toEqual([personal, shared]);
  });

  it('H7 データソースの入れ物の ID を出す（スタンドがソースのデータを読みに行けるように）', () => {
    expect(originOf(undefined)).toBeNull();
    expect(originOf({ kind: 'google-tasks', listId: 'L1', listName: 'エージェント用' })).toEqual({ kind: 'google-tasks', listId: 'L1' });
    expect(originOf({ kind: 'graph-todo', listId: 'L2', listName: 'タスク' })).toEqual({ kind: 'graph-todo', listId: 'L2' });
    expect(originOf({ kind: 'teams', teamId: 'T', channelId: 'C' })).toEqual({ kind: 'teams', teamId: 'T', channelId: 'C' });
    expect(originOf({ kind: 'jira', cloudId: 'c', site: 'https://x.atlassian.net', jql: 'project = X', projectKey: 'X' })).toEqual({
      kind: 'jira',
      cloudId: 'c',
      site: 'https://x.atlassian.net',
      projectKey: 'X',
    });
    expect(originOf({ kind: 'gmail', mailbox: 'me' })).toEqual({ kind: 'gmail', mailbox: 'me' });
  });
});
