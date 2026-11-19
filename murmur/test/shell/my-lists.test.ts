import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../../src/app/connections';
import type { ListView } from '../../src/domain';
import { renderMyLists, type MyListsInput } from '../../src/http/my-lists';
import { makeService } from '../helpers/service';
import { answer, email, seed } from '../helpers/world';

// 本人の「参加中のリスト」の画面（0048）

const ME = 'entra_tenant_me';

function list(id: string, name: string, origin: ListView['dataSource']['origin'], shared: boolean, readers: string[] = ['野瀬']): ListView & { shared: boolean } {
  return {
    id: `l_${id}`,
    dataSource: { id, kind: 'service', name, description: '', channel: 'email', origin },
    readers: readers.map((r, i) => ({ userId: `u${i}`, name: r, contactId: null })),
    shared,
  };
}

function conn(data_source: string, kind: ConnectionView['kind'], status: ConnectionView['status'] = 'ok', reason: string | null = null): ConnectionView {
  return { data_source, name: data_source, kind, status, reason, connected_at: '2026-11-01T00:00:00Z', last_sync_at: '2026-11-19T01:55:13Z' };
}

const base: MyListsInput = {
  userId: ME,
  name: '野瀬',
  lists: [],
  connections: [],
  threads: [],
  sharedServices: ['jira', 'teams', 'shared-mailbox'],
};

describe('参加中のリストの画面（0048）', () => {
  it('H3 個人のリストと共有のリストを分け、状態・最後の取り込み・件数・メンバーを出す', () => {
    const html = renderMyLists({
      ...base,
      lists: [
        list('ds_mail', '野瀬 の Outlook', { kind: 'graph-mail', mailbox: 'me' }, false),
        list('ds_bo', 'バックオフィス（Jira）', { kind: 'jira', cloudId: 'c', site: 'https://x.atlassian.net', projectKey: 'BO' }, true, ['野瀬', '佐藤', '']),
      ],
      connections: [conn('ds_mail', 'outlook'), conn('ds_bo', 'jira', 'broken', '読めなくなりました')],
      threads: [
        { dataSourceId: 'ds_mail', myTurn: ['named'], triage: false },
        { dataSourceId: 'ds_bo', myTurn: [], triage: true },
        { dataSourceId: 'ds_bo', myTurn: ['assignee'], triage: false },
      ],
    });
    const [personal, shared] = html.split('<h2>共有のリスト</h2>');
    expect(personal).toContain('野瀬 の Outlook');
    expect(personal).toContain('Outlook のメール · 最後の取り込み 11/19 10:55');
    expect(personal).toContain('担当・アテンション 1 件');
    expect(personal).not.toContain('割当待ち');
    expect(shared).toContain('バックオフィス（Jira）');
    expect(shared).toContain('担当・アテンション 1 件 · 割当待ち 1 件');
    expect(shared).toContain('メンバー 3 人: 野瀬、佐藤、(呼び方なし)');
    expect(shared).toContain('<span class="badge broken">止まっています</span>');
    expect(shared).toContain('読めなくなりました。ゲートウェイで接続をつなぎ直して');
  });

  it('H3 まだつないでいない個人リストを IdP ごとに案内し、共有リストは許されたサービスの入り方だけを書く（ほかのリストの名前は出さない）', () => {
    const entra = renderMyLists({ ...base, lists: [list('ds_mail', 'Outlook', { kind: 'graph-mail', mailbox: 'me' }, false)], sharedServices: ['jira'] });
    const missing = entra.split('<h2>リストを増やすには</h2>')[1]!;
    expect(missing).not.toContain('Outlook のメール');
    expect(missing).toContain('トピック索引に To Do をつないで');
    expect(missing).toContain('トピック索引に Teams のチャットをつないで');
    expect(missing).toContain('Jira のプロジェクト');
    expect(missing).not.toContain('Teams のチャネル');
    expect(missing).not.toContain('Gmail');

    const google = renderMyLists({ ...base, userId: 'google_123', sharedServices: ['google-chat', 'teams'] });
    expect(google).toContain('トピック索引に Gmail をつないで');
    expect(google).toContain('Google Chat のスペース');
    expect(google).not.toContain('Teams のチャネル');
  });

  it('H3 呼び方がなければ頼み方を出し、表示する値はエスケープする', () => {
    const html = renderMyLists({ ...base, name: '', lists: [list('ds_x', '<script>', null, true, ['<b>'])] });
    expect(html).toContain('呼び方がまだ決まっていません');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('H3 service.myLists は見えるリストと開いているトピックだけを返し、User を作らない', async () => {
    const { service } = await makeService(seed, { decide: () => answer({ title: '雨漏り' }) });
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1' }));
    const alice = await service.myLists('u_alice');
    expect(alice.name).toBe('Alice');
    expect(alice.lists.map((l) => l.dataSource.id)).toContain('ds_support');
    expect(alice.lists.every((l) => l.shared === false)).toBe(true);
    expect(alice.threads.length).toBeGreaterThan(0);

    const stranger = await service.myLists('entra_t_nobody');
    expect(stranger).toEqual({ name: '', lists: [], threads: [] });
    expect((await service.directory()).user('entra_t_nobody')).toBeUndefined();
  });
});
