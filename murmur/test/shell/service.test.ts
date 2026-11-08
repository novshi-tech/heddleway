import { describe, expect, it } from 'vitest';
import { canonicalJson, draft } from '../../src/domain';
import { memoryRepo } from '../../src/store/memory';
import { ConcurrencyError, type Repo } from '../../src/store/types';
import { makeService } from '../helpers/service';
import { answer, email, line, seed, view } from '../helpers/world';

describe('MurmurService.ingest', () => {
  it('H6 受信 → 区切り → スレッド。同じ source_ref は duplicate。観測された送信は構造で決まれば AI を呼ばない', async () => {
    const { service, decider } = await makeService(seed, { decide: () => answer({ title: '雨漏り' }) });
    const r = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }));
    expect(r).toEqual({ status: 'threaded', signalId: 'sig_1', threadId: 'thr_2', newThread: true, by: 'no_match' });
    expect(decider.requests.map((q) => q.mode)).toEqual(['new']);
    expect(await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1' }))).toEqual({ status: 'duplicate', signalId: 'sig_1' });

    const sent = await service.ingest(email({ from: 'support@ubs.example', to: ['carol@example.com'], sourceRef: 'o1', anchors: { inReplyTo: '<m1>' } }));
    expect(sent).toMatchObject({ status: 'threaded', threadId: 'thr_2', by: 'anchor' });
    expect(decider.requests).toHaveLength(1);
    expect(view(await service.state(), 'thr_2').awaiting).toBe(true);
  });

  it('H3 データソースのない取り込みは invalid', async () => {
    const { service } = await makeService(seed);
    await expect(service.ingest(email({ dataSourceId: 'ds_nope', from: 'a@x', sourceRef: 'r' }))).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('コネクタの取り込み（Cron）', () => {
  it('H6 データソースごとにダミーのキューから取り込む', async () => {
    const { service, backend } = await makeService(seed, { decide: () => answer() });
    await backend.enqueue(email({ from: 'carol@example.com', sourceRef: 'r1' }));
    await backend.enqueue(line({ from: 'U_carol', sourceRef: 'l1' }));
    const results = await service.pollConnectors();
    expect(results.map((r) => r.status)).toEqual(['threaded', 'threaded']);
    expect(await service.pollConnectors()).toEqual([]);
    const p = await service.state();
    expect(Object.values(p.threads).map((t) => t.dataSourceId).sort()).toEqual(['ds_line', 'ds_support']);
    expect(await service.tick()).toEqual({ ingested: 0, overdue: 0 });
  });
});

describe('スタンドの操作', () => {
  it('H3 片付け・開き直し・移し替え。見えないものは not_found', async () => {
    const { service } = await makeService(seed, { decide: () => answer({ thread: null }) });
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }));
    const r2 = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    const [t] = await service.listThreads('u_bob', { filter: 'triage' });
    expect(t!.signalCount).toBe(2);

    const dismissed = await service.dismissThread('u_bob', { threadId: t!.id, reason: '対応済み' });
    expect(dismissed.thread).toMatchObject({ dismissed: true, triage: false, myTurn: [] });
    expect(await service.listThreads('u_bob', { filter: 'triage' })).toEqual([]);
    expect((await service.reopenThread('u_alice', { threadId: t!.id })).thread.dismissed).toBe(false);

    const moved = await service.moveSignal('u_alice', { signalId: r2.signalId, to: { kind: 'new', title: '別件' }, reason: '別の話題' });
    expect(moved.thread).toMatchObject({ title: '別件', signalCount: 1 });
    expect((await service.getThread('u_alice', t!.id)).thread.signalCount).toBe(1);

    await expect(service.getThread('u_eve', t!.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.dismissThread('u_eve', { threadId: t!.id, reason: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.moveSignal('u_eve', { signalId: r2.signalId, to: { kind: 'new', title: 't' }, reason: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.getList('u_bob', 'l_alice')).rejects.toMatchObject({ code: 'not_found' });
    expect((await service.getList('u_alice', 'l_alice')).readers).toEqual([{ userId: 'u_alice', name: 'Alice', contactId: 'p_alice' }]);
  });

  it('/me は User と Contact と、読者になっているリスト（データソース）を返す', async () => {
    const { service } = await makeService(seed);
    const me = await service.me('u_alice');
    expect(me.contact?.contactId).toBe('p_alice');
    expect(me.lists.map((l) => [l.id, l.dataSourceId, l.kind])).toEqual([
      ['l_support', 'ds_support', 'service'],
      ['l_alice', 'ds_alice', 'service'],
      ['l_tasks_alice', 'ds_tasks_alice', 'service'],
    ]);
    // このデプロイに Contact のない User は contact が null
    expect((await service.me('u_mallory')).contact).toBeNull();
    await expect(service.me('u_ghost')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('投影と並行性', () => {
  it('H1 投影が遅れていても state() がイベントから追いつき、rebuild で作り直せる', async () => {
    const { service, repo } = await makeService(seed, { decide: () => answer() });
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1' }));
    const full = await service.state();
    // 投影の保存に失敗したのと同じ状態を作る
    const threadId = Object.keys(full.threads)[0]!;
    await repo.events.append(full.lastSeq, [draft('ThreadDismissed', { threadId, actorUserId: 'u_alice', reason: 'x' })], '2026-10-16T10:00:00.000Z');
    const caughtUp = await service.state();
    expect(caughtUp.threads[threadId]!.dismissed).toBe(true);
    expect(canonicalJson(await service.rebuild())).toBe(canonicalJson(caughtUp));
  });

  it('追記が競合したら読み直してやり直す', async () => {
    const inner = memoryRepo();
    let conflicts = 1;
    const repo: Repo = {
      ...inner,
      events: {
        read: (a) => inner.events.read(a),
        append: async (seq, drafts, at) => {
          if (conflicts-- > 0) {
            // 別のリクエストが先に書いた
            await inner.events.append(
              seq,
              [
                draft('SignalObserved', {
                  signalId: 'sig_other',
                  dataSourceId: 'ds_support',
                  channel: 'email',
                  from: { channel: 'email', value: 'x@y' },
                  to: [],
                  body: 'other',
                  sourceRef: 'other',
                }),
              ],
              at,
            );
            throw new ConcurrencyError(seq);
          }
          return inner.events.append(seq, drafts, at);
        },
      },
    };
    const { service } = await makeService(seed, { repo, decide: () => answer() });
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1' }));
    const events = await repo.events.read();
    expect(events.map((e) => e.type)).toEqual(['SignalObserved', 'SignalObserved', 'SignalThreaded']);
  });
});
