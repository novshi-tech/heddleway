import { describe, expect, it } from 'vitest';
import type { MurmurService } from '../../src/app/service';
import { onceDirectory } from '../../src/connectors/directory-once';
import { GraphMailSync } from '../../src/connectors/graph/sync';
import { JiraSync } from '../../src/connectors/jira/sync';
import { TeamsSync } from '../../src/connectors/teams/sync';
import { TodoSync } from '../../src/connectors/todo/sync';
import { GtasksSync } from '../../src/connectors/gtasks/sync';
import type { SourceState } from '../../src/connectors/graph/state';
import { MemoryConnectorState } from '../../src/store/connector-state';
import { makeService } from '../helpers/service';
import { seed } from '../helpers/world';

// 見回り（maintain）は、データソースの数にかかわらずマスタを 1 回だけ読む（0041 の決定 1）

const source = (id: string, kind: SourceState['kind'], userId = 'u_alice'): SourceState =>
  ({ kind, dataSourceId: id, userId, gatewayCredentialId: 'gw', status: 'ok', reason: null, folders: {}, connectedAt: '2026-11-05T03:00:00.000Z', lastSyncAt: null, lastRetryAt: null }) as SourceState;

async function setup() {
  const { service } = await makeService(seed);
  let loads = 0;
  const original = service.directory.bind(service);
  const counting = Object.assign(Object.create(service) as MurmurService, {
    directory: async () => {
      loads++;
      return original();
    },
  });
  const state = new MemoryConnectorState();
  // どのコネクタのデータソースも、それぞれ 3 つずつ。マスタにはない（guard はマスタを引いたところで止まる）
  for (const kind of ['outlook', 'todo', 'gtasks', 'jira', 'teams'] as const) {
    for (const n of [1, 2, 3]) await state.putSource(source(`ds_${kind}_${n}`, kind));
  }
  const deps = {
    service: counting,
    state,
    queue: { send: async () => undefined },
    now: () => '2026-11-05T03:00:00.000Z',
    notificationUrl: 'https://gw.test/murmur/webhooks/graph',
    newClientState: () => 'cs',
    hash: async (t: string) => t,
  };
  const syncs = {
    graph: new GraphMailSync({ ...deps, graphFor: async () => ({}) as never }),
    todo: new TodoSync({ ...deps, todoFor: async () => ({}) as never }),
    gtasks: new GtasksSync({ service: counting, state, now: deps.now, gtasksFor: async () => ({}) as never }),
    jira: new JiraSync({ ...deps, jiraFor: async () => ({}) as never, webhookUrlFor: async () => 'https://gw.test/hook' }),
    teams: new TeamsSync({ ...deps, teamsFor: async () => ({}) as never }),
  };
  return { syncs, loads: () => loads };
}

describe('見回りのマスタの読み込み', () => {
  it('Outlook の maintain は、データソースが 12 個あっても（ほかのコネクタのものを含め）マスタを 1 回だけ読む', async () => {
    const { syncs, loads } = await setup();
    await syncs.graph.handle({ kind: 'maintain' });
    expect(loads()).toBe(1);
  });

  it('To Do・Google Tasks・Jira・Teams の maintain は、自分のデータソースが 3 個あってもマスタを 1 回だけ読む', async () => {
    for (const name of ['todo', 'gtasks', 'jira', 'teams'] as const) {
      const { syncs, loads } = await setup();
      await syncs[name].handle({ kind: 'maintain' });
      expect(loads(), name).toBe(1);
    }
  });

  it('読み込みを渡せば、5 つのコネクタの maintain をまとめて 1 回で済ませる', async () => {
    const { syncs, loads } = await setup();
    const directory = onceDirectory(() => (syncs.graph as unknown as { deps: { service: MurmurService } }).deps.service.directory());
    for (const s of [syncs.graph, syncs.jira, syncs.teams, syncs.todo, syncs.gtasks]) await s.handle({ kind: 'maintain' }, directory);
    expect(loads()).toBe(1);
  });

  it('maintain 以外の仕事は、仕事ごとに読む（使い回さない）', async () => {
    const { syncs, loads } = await setup();
    await syncs.teams.handle({ kind: 'sync', dataSourceId: 'ds_teams_1', folder: 'inbox' });
    await syncs.teams.handle({ kind: 'sync', dataSourceId: 'ds_teams_2', folder: 'inbox' });
    expect(loads()).toBe(2);
  });
});

describe('onceDirectory', () => {
  it('失敗は覚えず、次の呼び出しでやり直す', async () => {
    let n = 0;
    const load = onceDirectory(async () => {
      if (++n === 1) throw new Error('boom');
      return {} as never;
    });
    await expect(load()).rejects.toThrow('boom');
    await load();
    await load();
    expect(n).toBe(2);
  });
});
