import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  deriveViewer,
  fold,
  getThreadView,
  listThreads,
  selectListScope,
  selectThreadScope,
  type ThreadFilter,
} from '../../src/domain';
import { listScenarios, loadScenario, runScenario } from '../../scripts/lib/scenario';

// 0047: 範囲で作った詳細・一覧は、全件で作ったものと同じ（H1 H3 H8）。どのシナリオの、どの User・スレッド・絞り込みでも

const FILTERS: ThreadFilter[] = ['my_turn', 'mine', 'open', 'awaiting', 'overdue', 'triage', 'all'];
const OPEN_ONLY = new Set<ThreadFilter>(['my_turn', 'open', 'awaiting', 'overdue', 'triage']);

describe.each(listScenarios())('H1 H3 H8 範囲で作った詳細・一覧は全件と同じ（%s）', (name) => {
  it('詳細（結んだ先・結び候補つき）と一覧（全部の絞り込み）', async () => {
    const run = await runScenario(loadScenario(name));
    const full = fold(await run.repo.events.read());
    const dir = await run.service.directory();
    const users = dir.seed.users.map((u) => u.id);
    let views = 0;
    let candidates = 0;
    for (const userId of users) {
      const viewer = deriveViewer(dir, userId);
      for (const id of Object.keys(full.threads)) {
        const scoped = selectThreadScope(full, { threadIds: [id], links: true, candidates: true });
        const a = getThreadView(dir, viewer, full, id);
        expect(canonicalJson(getThreadView(dir, viewer, scoped, id)), `${userId} ${id}`).toBe(canonicalJson(a));
        if (a) {
          views++;
          candidates += a.thread.linkCandidates.length;
        }
      }
      for (const filter of FILTERS) {
        const scoped = selectListScope(full, { dataSourceIds: viewer.dataSourceIds, openOnly: OPEN_ONLY.has(filter) });
        expect(canonicalJson(listThreads(dir, viewer, scoped, { filter })), `${userId} ${filter}`).toBe(canonicalJson(listThreads(dir, viewer, full, { filter })));
        // 範囲にはシグナルがない（一覧はシグナルを読まない）
        expect(Object.keys(scoped.signals)).toEqual([]);
      }
    }
    expect(views).toBeGreaterThan(0);
    // 結び候補が出る場面を含む（どこかのシナリオで）
    if (name === 'development') expect(candidates).toBeGreaterThan(0);
  });
});
