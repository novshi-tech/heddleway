import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '../../src/domain';
import { renderNow, renderSection, renderThread, sortNow, type NowInput, type NowThread, type PageList } from '../../src/http/now';
import { makeService } from '../helpers/service';
import { answer, email, seed } from '../helpers/world';

// 本人の「今やること」の画面とトピックの詳細（0051）

const NOW = '2026-11-25T03:00:00Z'; // 12:00 JST

const lists: PageList[] = [
  { id: 'ds_mail', name: '野瀬 の Outlook', kind: 'outlook', shared: false, jiraSite: null },
  { id: 'ds_todo', name: 'タスク', kind: 'todo', shared: false, jiraSite: null },
  { id: 'ds_bo', name: 'バックオフィス', kind: 'jira', shared: true, jiraSite: 'https://x.atlassian.net/' },
  { id: 'ds_ch', name: '全社チャネル', kind: 'teams', shared: true, jiraSite: null },
];

function thread(id: string, dataSourceId: string, over: Partial<NowThread> = {}): NowThread {
  return {
    id,
    dataSourceId,
    title: `件名 ${id}`,
    assignee: null,
    attention: { named: [], list: null },
    triage: false,
    awaiting: false,
    counterpartContactIds: [],
    counterpartAddresses: [],
    lastInboundAt: null,
    lastOutboundAt: null,
    dismissed: false,
    dismissReason: null,
    activeSinceDismissed: false,
    replyExpectedBy: null,
    overdue: false,
    closedAtSource: false,
    links: [],
    source: null,
    signalCount: 1,
    updatedAt: '2026-11-24T00:00:00Z',
    lastActivityAt: '2026-11-24T00:00:00Z',
    myTurn: [],
    derivedBall: null,
    linkedActiveSinceDismissed: false,
    linkCandidates: [],
    ...over,
  } as NowThread;
}

const base: NowInput = { base: '/features/topic-index', name: '野瀬', lists, threads: [], now: NOW };

describe('今やることの画面（0051・0052）', () => {
  it('H3 自分がやるもの（担当とタスク）・アテンション・返事待ち・割当待ちに分け、1 つのトピックは最初の区分にだけ出す', () => {
    const threads = [
      thread('t_jira', 'ds_bo', { myTurn: ['assignee', 'named'], source: { key: 'BO-12', closed: false, holders: [], title: 'x', statusLabel: '進行中', due: null } as never }),
      thread('t_task', 'ds_todo', { source: { key: 'task1', closed: false, holders: [], title: 'x', statusLabel: 'タスク', due: '2026-11-24' } as never }),
      thread('t_list', 'ds_ch', { myTurn: ['list'], lastActivityAt: '2026-11-25T02:00:00Z' }),
      thread('t_named', 'ds_mail', { myTurn: ['named'] }),
      thread('t_wait', 'ds_mail', { awaiting: true, overdue: true, replyExpectedBy: '2026-11-24T09:00:00Z' }),
      thread('t_triage', 'ds_ch', { triage: true }),
      thread('t_none', 'ds_mail'),
    ];
    const s = sortNow({ lists, threads });
    expect(s.mine.map((t) => t.id)).toEqual(['t_task', 't_jira']);
    expect(s.attention.map((t) => t.id)).toEqual(['t_named', 't_list']);
    expect(s.awaiting.map((t) => t.id)).toEqual(['t_wait']);
    expect(s.triage.map((t) => t.id)).toEqual(['t_triage']);

    const html = renderNow({ ...base, threads });
    expect(html).toContain('<a class="tab" href="/features/topic-index" aria-current="page">今やること</a>');
    expect(html).toContain('<a class="alert broken" href="/features/topic-index/mine">期限切れ <b>1</b></a>');
    expect(html).toContain('href="/features/topic-index/threads/t_jira"');
    expect(html).toContain('バックオフィス · 進行中');
    expect(html).toContain('<span class="badge broken">期限切れ 11/24</span>');
    // アテンションはリストごとの件数だけ。新しく動いたリストが上
    expect(html).not.toContain('件名 t_named');
    expect(html.indexOf('href="/features/topic-index/attention/ds_ch"')).toBeLessThan(html.indexOf('href="/features/topic-index/attention/ds_mail"'));
    expect(html).toContain('<span class="badge">あなた宛て 1</span><span class="count">1</span>');
    // 返事待ちと割当待ちは件数の 1 行
    expect(html).toContain('<a href="/features/topic-index/awaiting">返事待ち <b>1</b> <span class="badge broken">期限切れ 1</span></a>');
    expect(html).toContain('<a href="/features/topic-index/triage">割当待ち <b>1</b></a>');
    expect(html).not.toContain('件名 t_wait');
    expect(html).not.toContain('件名 t_none');
  });

  it('H3 自分がやるものは上位 5 件だけ出し、残りは区分の画面で見る', () => {
    const many = Array.from({ length: 8 }, (_, i) => thread(`t${i}`, 'ds_bo', { myTurn: ['assignee'], lastActivityAt: `2026-11-2${i}T00:00:00Z` }));
    const html = renderNow({ ...base, threads: many });
    expect(html.match(/class="item"/g)).toHaveLength(5);
    expect(html).toContain('<a class="more" href="/features/topic-index/mine">8 件すべて見る</a>');
    expect(html).not.toContain('class="alert');
    const page = renderSection({ ...base, threads: many }, 'mine');
    expect(page?.title).toBe('自分がやるもの');
    expect(page?.body.match(/class="item"/g)).toHaveLength(8);
    expect(page?.body).toContain('<a class="back" href="/features/topic-index">← 今やること</a>');
  });

  it('H3 アテンションの画面はリストで絞れて、本人宛てが先。知らないリストは null', () => {
    const threads = [
      thread('t_list', 'ds_ch', { myTurn: ['list'], lastActivityAt: '2026-11-25T02:00:00Z' }),
      thread('t_named', 'ds_ch', { myTurn: ['named'] }),
      thread('t_mail', 'ds_mail', { myTurn: ['named'] }),
    ];
    const one = renderSection({ ...base, threads }, 'attention', 'ds_ch');
    expect(one?.title).toBe('全社チャネル');
    expect(one!.body.indexOf('件名 t_named')).toBeLessThan(one!.body.indexOf('件名 t_list'));
    expect(one?.body).not.toContain('件名 t_mail');
    expect(renderSection({ ...base, threads }, 'attention', 'ds_nope')).toBeNull();
    const all = renderSection({ ...base, threads }, 'attention');
    expect(all?.body).toContain('<h2 class="group-head">全社チャネル <span class="count">2</span></h2>');
  });

  it('H3 何もなければ空の案内を出し、リストがなければつなぎ方を出す', () => {
    const html = renderNow(base);
    expect(html).toContain('担当・タスクはありません');
    expect(html).toContain('残っているアテンションはありません');
    expect(html).not.toContain('割当待ち');
    expect(renderSection(base, 'triage')?.body).toContain('割当待ちはありません');
    const empty = renderNow({ ...base, lists: [] });
    expect(empty).toContain('まだどのリストのメンバーにもなっていません');
  });

  it('H3 表示する値はエスケープする', () => {
    const html = renderNow({ ...base, threads: [thread('t1', 'ds_bo', { myTurn: ['assignee'], title: '<script>x</script>' })] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('トピックの詳細（0051）', () => {
  it('H3 事実・Jira へのリンク・関連づけたトピック・経過（新しいものが上、長い本文は畳む）を出す', () => {
    const t = thread('t_jira', 'ds_bo', {
      myTurn: ['assignee'],
      source: { key: 'BO-12', closed: false, holders: [], title: 'x', statusLabel: '進行中', due: '2026-11-30' } as never,
    }) as ThreadItem;
    const html = renderThread({
      base: '/features/topic-index',
      thread: t,
      list: lists[2],
      assigneeNames: ['野瀬'],
      counterparts: [],
      linked: [{ id: 't_task', title: 'BO-12 を直す', listName: 'タスク', myTurn: [], dismissed: false }],
      entries: [
        { at: '2026-11-24T00:00:00Z', kind: 'signal', fromLinked: null, signal: { direction: 'inbound', from: 'Carol', to: ['野瀬'], subject: '雨漏り', body: 'あ'.repeat(700), attachments: 1 } },
        { at: '2026-11-25T02:30:00Z', kind: 'claimed', fromLinked: null, text: '野瀬が担当した' },
      ],
      now: NOW,
    });
    expect(html).toContain('<h1>件名 t_jira</h1>');
    expect(html).toContain('<li>担当: 野瀬</li>');
    expect(html).toContain('<li>状態: 進行中</li>');
    expect(html).toContain('<li>期限: 11/30</li>');
    expect(html).toContain('href="https://x.atlassian.net/browse/BO-12"');
    expect(html).toContain('href="/features/topic-index/threads/t_task"');
    expect(html.indexOf('野瀬が担当した')).toBeLessThan(html.indexOf('雨漏り'));
    expect(html).toContain('Carol → 野瀬');
    expect(html).toContain('<summary>続きを読む</summary>');
  });

  it('H3 service.threadPage は見えるトピックだけを返し、名前を解決する', async () => {
    const { service } = await makeService(seed, { decide: () => answer({ title: '雨漏り' }) });
    const r = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', subject: '雨漏りの件' }));
    expect(r.status).toBe('threaded');
    const threadId = (r as { threadId: string }).threadId;

    const alice = await service.threadPage('u_alice', threadId);
    expect(alice?.view.thread.title).toBe('雨漏り');
    const first = alice?.entries[0];
    expect(first && 'signal' in first ? first.signal.from : null).toBe('Carol（顧客）');
    expect(alice?.counterparts).toEqual(['Carol（顧客）']);

    expect(await service.threadPage('u_eve', threadId)).toBeNull();
    expect(await service.threadPage('entra_t_nobody', threadId)).toBeNull();
    expect((await service.directory()).user('entra_t_nobody')).toBeUndefined();

    const lists = await service.myLists('u_alice');
    expect(lists.threads.map((t) => t.id)).toContain(threadId);
  });
});
