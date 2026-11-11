import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../../src/auth/webhook';
import { MoveSignalBody } from '../../src/api/schemas';
import { createApp } from '../../src/http/app';
import { makeService } from '../helpers/service';
import { answer, email, seed } from '../helpers/world';

// ゲートウェイの口の偽物: トークン "gw:<User ID>" だけを通す（本物はゲートウェイの issue_token のトークンを確かめる）
const token = (user: string) => `gw:${user}`;
const authenticate = async (t: string) => (t.startsWith('gw:') ? t.slice(3) : null);

describe('Webhook の署名', () => {
  it('ダミーの Webhook の HMAC 署名', async () => {
    const sig = await signWebhook('body', 'secret');
    expect(await verifyWebhookSignature('body', sig, 'secret')).toBe(true);
    expect(await verifyWebhookSignature('body2', sig, 'secret')).toBe(false);
    expect(await verifyWebhookSignature('body', 'zz', 'secret')).toBe(false);
  });
});

describe('HTTP API', () => {
  async function app() {
    const ctx = await makeService(seed, { decide: () => answer({ title: '雨漏り' }) });
    const http = createApp({
      service: () => ctx.service,
      authenticate,
      webhookVerify: (body, sig) => verifyWebhookSignature(body, sig, 'whsec'),
      timelineToken: 'tok',
    });
    const call = async (method: string, path: string, user?: string, body?: unknown) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (user) headers.authorization = `Bearer ${token(user)}`;
      const res = await http.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
      return { status: res.status, body: out };
    };
    return { ...ctx, call, http };
  }

  it('H3 H7 初めて接続した人は名無し。個人のリストを作ると、先に名寄せされていたゴーストに結ばれる（0030 の 6・7）', async () => {
    const { call } = await app();
    // サインインしただけ: User の行だけで、Contact もリストもない（seed の誰かにもならない）
    const me = (await call('GET', '/api/me', 'u_carol')).body;
    expect(me).toEqual({ user: { id: 'u_carol', name: '' }, contact: null, lists: [] });
    expect((await call('GET', '/api/threads', 'u_carol')).body).toEqual([]);
    // チームのメンバー（どれかのリストの読者）でなければ連絡先は読めない
    expect((await call('GET', '/api/contacts', 'u_carol')).status).toBe(403);
    expect((await call('PATCH', '/api/me', 'u_carol', { name: 'Carol' })).body.user.name).toBe('Carol');

    // 個人のリスト（LINE）を作る。U_carol はチームが Carol のゴーストとして名寄せ済み
    const created = await call('POST', '/api/data-sources', 'u_carol', {
      channel: 'line',
      name: 'Carol の LINE',
      identity: 'U_carol',
      gateway_credential_id: 'gw-1',
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ identity: { kind: 'bound', contactId: 'p_carol' }, readers: [{ userId: 'u_carol', contactId: 'p_carol' }] });
    expect((await call('GET', '/api/me', 'u_carol')).body).toMatchObject({ contact: { contactId: 'p_carol' }, lists: [{ kind: 'service' }] });
    // メモは個人リストのスレッドに書く。thread_id のないメモ（個人のメモのデータソース）はもうない（0039）
    expect((await call('POST', '/api/notes', 'u_carol', { body: 'メモ' })).status).toBe(400);
    expect((await call('GET', '/api/me', 'u_carol')).body.lists).toHaveLength(1);
    // To Do のリストは POST /connections/todo でつなぐ（経路のないタスクのリストは作れない。0039）
    expect((await call('POST', '/api/data-sources', 'u_carol', { channel: 'todo', name: 'x', identity: 'carol@example.com', gateway_credential_id: 'g' })).status).toBe(400);
    // 別の User のアドレスは選べない
    expect((await call('POST', '/api/data-sources', 'u_carol', { channel: 'email', name: 'x', identity: 'alice@ubs.example', gateway_credential_id: 'g' })).status).toBe(409);
  });

  it('H3 名寄せ: 未解決のアドレスを探し、ゴーストを作ってアドレスを付け、まとめる（0030 の 8・9）', async () => {
    const { call, service } = await app();
    await service.ingest(email({ from: 'frank@example.com', sourceRef: 'r1' }));
    const unresolved = (await call('GET', '/api/addresses/unresolved', 'u_alice')).body;
    expect(unresolved).toMatchObject([{ channel: 'email', value: 'frank@example.com', count: 1 }]);
    const frank = (await call('POST', '/api/contacts', 'u_alice', { name: 'Frank', address: { channel: 'email', value: 'frank@example.com' } })).body;
    expect(frank).toMatchObject({ name: 'Frank', userId: null, addresses: [{ value: 'frank@example.com' }] });
    expect((await call('GET', '/api/addresses/unresolved', 'u_alice')).body).toEqual([]);
    const threads = (await call('GET', '/api/threads', 'u_alice')).body as { counterpartContactIds: string[] }[];
    expect(threads[0]!.counterpartContactIds).toEqual([frank.id]);

    expect((await call('POST', `/api/contacts/${frank.id}/addresses`, 'u_alice', { channel: 'line', value: 'U_frank' })).body.addresses).toHaveLength(2);
    expect((await call('POST', `/api/contacts/${frank.id}/addresses`, 'u_alice', { channel: 'line', value: 'U_carol' })).status).toBe(409);
    expect((await call('GET', '/api/contacts?q=frank', 'u_alice')).body).toHaveLength(1);
    expect((await call('PATCH', `/api/contacts/${frank.id}`, 'u_bob', { name: 'Frank（工務店）' })).body.name).toBe('Frank（工務店）');

    const merged = (await call('POST', '/api/contacts/p_dave/merge', 'u_alice', { from: frank.id })).body;
    expect(merged.addresses.map((a: { value: string }) => a.value)).toContain('frank@example.com');
    expect((await call('GET', `/api/contacts/${frank.id}`, 'u_alice')).body.id).toBe('p_dave');
    expect((await call('POST', '/api/contacts/p_alice/unbind', 'u_bob')).status).toBe(403);
    // 変更の記録が残る
    const log = await service.deps.repo.master.changeLog();
    expect(log.filter((r) => r.actorUserId === 'u_alice').map((r) => r.kind)).toEqual(expect.arrayContaining(['contacts', 'addresses', 'contactAliases']));
  });

  it('伝搬されたユーザー識別がなければ 401', async () => {
    const { call, http } = await app();
    expect((await call('GET', '/api/me')).status).toBe(401);
    const res = await http.request('/api/me', { headers: { authorization: 'Bearer x.y.z' } });
    expect(res.status).toBe(401);
    // 仮決めだった旧ヘッダは受け付けない
    const legacy = await http.request('/api/me', { headers: { 'x-murmur-identity': token('u_alice') } });
    expect(legacy.status).toBe(401);
  });

  it('/me・スレッドの一覧と詳細・片付け・開き直し・移し替え・リストの一通り', async () => {
    const { call, service } = await app();
    expect((await call('GET', '/api/me', 'u_alice')).body.contact.contactId).toBe('p_alice');

    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }));
    const r2 = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    const threads = (await call('GET', '/api/threads?filter=triage', 'u_alice')).body as { id: string }[];
    expect(threads).toHaveLength(1);
    const threadId = threads[0]!.id;
    expect((await call('GET', `/api/threads/${threadId}`, 'u_alice')).body.timeline).toHaveLength(2);
    expect((await call('GET', `/api/threads/${threadId}`, 'u_eve')).status).toBe(404);
    expect((await call('GET', '/api/threads?data_source=ds_alice', 'u_alice')).body).toEqual([]);

    const dismissed = await call('POST', `/api/threads/${threadId}/dismiss`, 'u_bob', { reason: '対応不要' });
    expect(dismissed.body.thread).toMatchObject({ dismissed: true, dismissReason: '対応不要' });
    expect((await call('POST', `/api/threads/${threadId}/dismiss`, 'u_bob', {})).status).toBe(400);
    expect((await call('GET', '/api/threads', 'u_alice')).body).toEqual([]);
    expect((await call('POST', `/api/threads/${threadId}/reopen`, 'u_alice')).body.thread.dismissed).toBe(false);

    const moved = await call('POST', `/api/signals/${r2.signalId}/move`, 'u_alice', { new_thread_title: '別件', reason: '別の話題' });
    expect(moved.body.thread).toMatchObject({ title: '別件', signalCount: 1 });
    const back = await call('POST', `/api/signals/${r2.signalId}/move`, 'u_alice', { thread_id: threadId, reason: '戻す' });
    expect(back.body.thread.signalCount).toBe(2);
    expect((await call('POST', `/api/signals/${r2.signalId}/move`, 'u_eve', { thread_id: threadId, reason: 'x' })).status).toBe(404);

    expect((await call('GET', '/api/lists/l_support', 'u_alice')).body.dataSource.name).toBe('support@');
    const lists = (await call('GET', '/api/lists', 'u_alice')).body as { id: string }[];
    expect(lists.map((l) => l.id)).toEqual(expect.arrayContaining(['l_support', 'l_alice', 'l_tasks_alice']));
    expect(((await call('GET', '/api/lists', 'u_bob')).body as { id: string }[]).map((l) => l.id)).not.toContain('l_alice');
    expect((await call('GET', '/api/lists/l_alice', 'u_bob')).status).toBe(404);
  });

  it('H8 タスク・メモ・担当・名指し・リンク・自分の番・タイムラインの since の一通り', async () => {
    const { call, service, clock } = await app();
    const r1 = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }));
    const threadId = r1.status === 'threaded' ? r1.threadId : '';
    expect((await call('GET', '/api/threads?filter=triage', 'u_bob')).body).toHaveLength(1);

    const claimed = await call('POST', `/api/threads/${threadId}/claim`, 'u_alice', { reason: '自分で持つ' });
    expect(claimed.body.thread).toMatchObject({ assignee: { by: 'claim', userIds: ['u_alice'] }, triage: false, myTurn: ['assignee', 'list'] });
    expect((await call('GET', '/api/threads?filter=triage', 'u_bob')).body).toEqual([]);
    expect((await call('GET', '/api/threads?filter=my_turn', 'u_alice')).body.map((t: { id: string }) => t.id)).toEqual([threadId]);
    // Bob はリスト宛ての名指しを外すと自分の番から外れる
    expect((await call('GET', '/api/threads?filter=my_turn', 'u_bob')).body.map((t: { id: string }) => t.id)).toEqual([threadId]);
    const acked = await call('POST', `/api/threads/${threadId}/acknowledge`, 'u_bob', { reason: '目を通した' });
    expect(acked.body.thread.myTurn).toEqual([]);
    expect(acked.body.timeline.at(-1)).toMatchObject({ kind: 'acknowledged', list: true, actorUserId: 'u_bob', untilSignalId: r1.signalId });
    expect((await call('GET', '/api/threads?filter=my_turn', 'u_bob')).body).toEqual([]);
    expect((await call('POST', `/api/threads/${threadId}/acknowledge`, 'u_bob', { until_signal_id: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/acknowledge', 'u_alice', { thread_ids: [threadId] })).body).toEqual({ acknowledged: 1 });
    expect((await call('POST', `/api/threads/${threadId}/claim`, 'u_alice', { user_id: 'u_eve' })).status).toBe(400);
    const handed = await call('POST', `/api/threads/${threadId}/claim`, 'u_alice', { user_id: 'u_bob', reason: '引き継ぎ' });
    expect(handed.body.thread.assignee.userIds).toEqual(['u_bob']);

    clock.set('2026-10-16T10:00:00.000Z');
    // スタンドが To Do にタスクを作って記録する（宛先なし。タスクの ID が区切り。0039 の決定 3）
    const created = await call('POST', '/api/sent', 'u_alice', { data_source: 'ds_tasks_alice', subject: 'Carol さんの雨漏りの件', body: '期限は今週', sent_ref: 'AAMk-1' });
    expect(created.body.thread).toMatchObject({ title: 'Carol さんの雨漏りの件', dataSourceId: 'ds_tasks_alice', signalCount: 1 });
    const noteId = created.body.thread.id as string;
    const note = await call('POST', '/api/notes', 'u_alice', { thread_id: noteId, body: '電話で状況を聞いた' });
    expect(note.status).toBe(200);
    expect((await call('POST', '/api/notes', 'u_bob', { thread_id: noteId, body: 'x' })).status).toBe(404);
    // 共有リスト（support@）のスレッドにはメモを書けない
    expect((await call('POST', '/api/notes', 'u_alice', { thread_id: threadId, body: 'x' })).status).toBe(400);
    const more = await call('POST', '/api/notes', 'u_alice', { thread_id: noteId, body: '見積を依頼する', author: { kind: 'agent', name: 'orchestrator' } });
    expect(more.body.timeline.filter((e: { kind: string }) => e.kind === 'note').map((e: { note: { author: unknown } }) => e.note.author)).toEqual([
      { kind: 'user' },
      { kind: 'agent', name: 'orchestrator' },
    ]);
    expect((await call('POST', '/api/notes', 'u_alice', { thread_id: noteId, body: 'x', author: { kind: 'agent', name: '' } })).status).toBe(400);
    expect((await call('GET', '/api/threads?filter=mine', 'u_alice')).body.map((t: { id: string }) => t.id)).toEqual([noteId]);

    const linked = await call('POST', `/api/threads/${noteId}/links`, 'u_alice', { thread_id: threadId, reason: 'この件の問い合わせ' });
    expect(linked.body.thread.links).toMatchObject([{ threadId, route: 'manual' }]);
    expect(linked.body.timeline.map((e: { threadId: string }) => e.threadId)).toContain(threadId);
    // Bob には Alice のタスクが読めないので、辺も見えない（0033 の 3）
    const bobView = await call('GET', `/api/threads/${threadId}`, 'u_bob');
    expect(bobView.body.linked).toEqual([]);
    expect(bobView.body.thread.links).toEqual([]);
    expect(JSON.stringify(bobView.body)).not.toContain(noteId);
    expect(JSON.stringify(bobView.body)).not.toContain('電話で状況');

    // 本人が付ける属性はなくした（0039 の決定 5）。期限はタスクの写し
    expect((await call('POST', `/api/threads/${noteId}/attributes`, 'u_alice', { name: 'due', value: '2026-10-20' })).status).toBe(404);
    const since = await call('GET', `/api/threads/${noteId}?since=2026-10-16T09:30:00.000Z`, 'u_alice');
    expect(since.body.timeline.every((e: { at: string }) => e.at > '2026-10-16T09:30:00.000Z')).toBe(true);

    // list_threads の since: タスクは、結んだ先が動けば差分に入る（オフセット付きの時刻も受ける）
    clock.set('2026-10-16T11:00:00.000Z');
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r2', anchors: { inReplyTo: '<m1>' } }));
    const changed = await call('GET', '/api/threads?filter=mine&since=2026-10-16T19:30:00%2B09:00', 'u_alice');
    expect(changed.body.map((t: { id: string }) => t.id)).toEqual([noteId]);
    expect((await call('GET', '/api/threads?filter=mine&since=2026-10-16T12:00:00Z', 'u_alice')).body).toEqual([]);
    expect((await call('GET', '/api/threads?since=yesterday', 'u_alice')).status).toBe(400);

    const unlinked = await call('POST', `/api/threads/${noteId}/unlink`, 'u_alice', { thread_id: threadId });
    expect(unlinked.body.thread.links).toEqual([]);
  });

  it('H4 record_sent: 送ったスレッドを返し、返事期待はオフセット付きでも UTC にそろえる。期限を過ぎると overdue に出る', async () => {
    const { call, service, clock } = await app();
    const r1 = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', anchors: { messageId: '<m1>' } }));
    const threadId = r1.status === 'threaded' ? r1.threadId : '';
    const res = await call('POST', '/api/sent', 'u_alice', {
      data_source: 'ds_support',
      to: ['carol@example.com'],
      body: '調査します',
      sent_ref: '<u1@ubs.example>',
      reply_to_thread_id: threadId,
      reply_expected_by: '2026-10-16T21:00:00+09:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.thread).toMatchObject({ id: threadId, replyExpectedBy: '2026-10-16T12:00:00.000Z', awaiting: true });
    expect((await call('POST', '/api/sent', 'u_eve', { data_source: 'ds_support', to: ['x'], body: 'b', sent_ref: 's' })).status).toBe(404);
    expect((await call('POST', '/api/sent', 'u_alice', { data_source: 'ds_support', body: 'b', sent_ref: 's' })).status).toBe(400);
    expect((await call('POST', '/api/sent', 'u_alice', { data_source: 'ds_support', to: ['x'], body: 'b', sent_ref: 's', reply_expected_by: '明日' })).status).toBe(400);
    clock.set('2026-10-16T13:00:00.000Z');
    expect(await service.tick()).toEqual({ ingested: 0, overdue: 1 });
    expect((await call('GET', '/api/threads?filter=overdue', 'u_alice')).body.map((t: { id: string }) => t.id)).toEqual([threadId]);
  });

  it('入力の検証エラーは 400', async () => {
    const { call } = await app();
    expect((await call('GET', '/api/threads?filter=weird', 'u_alice')).status).toBe(400);
    expect((await call('POST', '/api/signals/s/move', 'u_alice', { reason: 'x' })).status).toBe(400);
    expect(MoveSignalBody.safeParse({ thread_id: 't', new_thread_title: 'n', reason: 'x' }).success).toBe(false);
  });

  it('Webhook は署名が合うときだけ取り込む', async () => {
    const { http, service } = await app();
    const body = JSON.stringify([email({ from: 'carol@example.com', sourceRef: 'w1' })]);
    const bad = await http.request('/webhooks/dummy', { method: 'POST', body, headers: { 'x-murmur-signature': '00' } });
    expect(bad.status).toBe(401);
    const ok = await http.request('/webhooks/dummy', { method: 'POST', body, headers: { 'x-murmur-signature': await signWebhook(body, 'whsec') } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject([{ status: 'threaded', newThread: true }]);
    expect(Object.keys((await service.state()).threads)).toHaveLength(1);
  });

  it('H9 Webhook は状態の写しも受け、シグナルと同じ順に処理する（課題のスレッドがまだなければ写さない）', async () => {
    const { http } = await app();
    const mirror = (threadKey: string) => ({ kind: 'mirror', dataSourceId: 'ds_support', channel: 'email', threadKey, fields: {}, sourceRef: `m-${threadKey}` });
    const body = JSON.stringify([mirror('K-1'), email({ from: 'carol@example.com', sourceRef: 'w1', anchors: { threadKey: 'K-1' } }), mirror('K-1')]);
    const res = await http.request('/webhooks/dummy', { method: 'POST', body, headers: { 'x-murmur-signature': await signWebhook(body, 'whsec') } });
    expect(res.status).toBe(200);
    const [before, sig, after] = (await res.json()) as { status: string; threadId?: string }[];
    expect(before).toEqual({ status: 'no_thread', threadKey: 'K-1' });
    expect(sig).toMatchObject({ status: 'threaded', newThread: true, by: 'anchor' });
    expect(after).toEqual({ status: 'unchanged', threadId: sig!.threadId });
  });

  it('timeline.html はトークンを知っている人にだけ、エスケープして返す', async () => {
    const { http, service } = await app();
    await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', body: '<script>alert(1)</script>' }));
    expect((await http.request('/timeline.html')).status).toBe(404);
    const res = await http.request('/timeline.html?token=tok');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('雨漏り');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('管理画面はトークンを知っている人にだけ、リスト一覧 → スレッドの一覧とリンク → 詳細を返す', async () => {
    const { http, service, call } = await app();
    const r1 = await service.ingest(email({ from: 'carol@example.com', sourceRef: 'r1', body: '<img src=x onerror=alert(1)>', anchors: { messageId: '<m1>' } }));
    const threadId = r1.status === 'threaded' ? r1.threadId : '';
    const note = await call('POST', '/api/sent', 'u_alice', { data_source: 'ds_tasks_alice', subject: 'Carol さんの件', body: 'タスク', sent_ref: 'AAMk-2', source_thread_id: threadId });
    await call('POST', '/api/notes', 'u_alice', { thread_id: note.body.thread.id, body: '電話した' });

    for (const path of ['/admin', '/admin/lists/l_support', `/admin/threads/${threadId}`]) {
      expect((await http.request(path)).status).toBe(404);
      expect((await http.request(`${path}?token=bad`)).status).toBe(404);
    }
    const index = await (await http.request('/admin?token=tok')).text();
    expect(index).toContain('support@');
    expect(index).toContain('/admin/lists/l_support?token=tok');

    const list = await (await http.request('/admin/lists/l_support?token=tok')).text();
    expect(list).toContain('雨漏り');
    expect(list).toContain('Carol さんの件');
    expect(list).toContain(`/admin/threads/${threadId}?token=tok`);
    expect((await http.request('/admin/lists/l_nope?token=tok')).status).toBe(404);

    const detail = await (await http.request(`/admin/threads/${threadId}?token=tok`)).text();
    expect(detail).toContain('&lt;img');
    expect(detail).not.toContain('<img src=x');
    expect(detail).toContain('Carol さんの件');
    const noteDetail = await (await http.request(`/admin/threads/${note.body.thread.id}?token=tok`)).text();
    // タスクのタイムラインに、結んだ先の受信とメモが並ぶ
    expect(noteDetail).toContain('&lt;img');
    expect(noteDetail).toContain('電話した');
    expect((await http.request('/admin/threads/thr_nope?token=tok')).status).toBe(404);
  });
});

describe('H3 外部コネクタの公開ルート（0024）', () => {
  async function app(withConnectors = true) {
    const ctx = await makeService(seed);
    const notified: unknown[] = [];
    const connectOutlook = async (userId: string, credentialId?: string) => ({ status: 'authorize', authorize_url: `https://gw/authorize?u=${userId}&c=${credentialId ?? ''}` });
    const connectJira = async (userId: string, input: unknown) => ({ status: 'connected', userId, input });
    const connectTeams = async (userId: string, input: unknown) => ({ status: 'connected', userId, input });
    const connectTodo = async (userId: string, input: unknown) => ({ status: 'connected', userId, input });
    const connectGoogleTasks = async (userId: string, input: unknown) => ({ status: 'connected', userId, input });
    const connectGmail = async (userId: string, credentialId?: string) => ({ status: 'authorize', authorize_url: `https://gw/authorize?u=${userId}&c=${credentialId ?? ''}&k=gmail` });
    const http = createApp({
      service: () => ctx.service,
      authenticate,
      webhookVerify: async () => false,
      connectors: withConnectors
        ? () => ({
            connections: { connectOutlook, connectJira, connectTeams, connectTodo, connectGoogleTasks, connectGmail, list: async () => [], disconnect: async () => [], callback: async () => ({ ok: true, message: '<b>つないだ</b>' }) } as never,
            notifications: async (body) => {
              notified.push(body);
              return 1;
            },
            jiraNotified: async (secret: string, body: unknown) => {
              notified.push({ secret, body });
              return secret === 'good' ? 1 : null;
            },
          })
        : undefined,
    });
    return { http, notified };
  }

  it('Graph の受け口: 作成時の検証は validationToken をそのまま text/plain で返し、通知は積んで 202', async () => {
    const { http, notified } = await app();
    const v = await http.request('/webhooks/graph?validationToken=Validation%3A%20abc', { method: 'POST' });
    expect(v.status).toBe(200);
    expect(v.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await v.text()).toBe('Validation: abc');
    const n = await http.request('/webhooks/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [{ subscriptionId: 's' }] }) });
    expect(n.status).toBe(202);
    expect(notified).toEqual([{ value: [{ subscriptionId: 's' }] }]);
    expect((await http.request('/webhooks/graph', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('同意のコールバックは公開、/api/connections は本人のトークンが要る', async () => {
    const { http } = await app();
    expect((await http.request('/oauth/client.json')).status).toBe(404);
    const cb = await http.request('/oauth/callback?state=s&code=c');
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('&lt;b&gt;つないだ&lt;/b&gt;');
    expect((await http.request('/api/connections/outlook', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/outlook', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credential_id: 'gw_1' }),
    });
    expect(await res.json()).toEqual({ status: 'authorize', authorize_url: 'https://gw/authorize?u=u_bob&c=gw_1' });
  });

  it('H9 Jira の受け口（0034）: URL の秘密が合えば 202（中身は使わない）、合わなければ 404', async () => {
    const { http, notified } = await app();
    const ok = await http.request('/webhooks/jira/good', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookEvent: 'comment_created' }) });
    expect(ok.status).toBe(202);
    expect((await http.request('/webhooks/jira/bad', { method: 'POST', body: 'not json' })).status).toBe(404);
    expect(notified).toEqual([{ secret: 'good', body: { webhookEvent: 'comment_created' } }, { secret: 'bad', body: null }]);
  });

  it('H3 /api/connections/jira はプロジェクトを渡す（本人のトークンが要る。0037）。範囲を変える PATCH はない', async () => {
    const { http } = await app();
    const auth = { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' };
    expect((await http.request('/api/connections/jira', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/jira', { method: 'POST', headers: auth, body: JSON.stringify({ site: 'cloud-1', project: 'SPW' }) });
    expect(await res.json()).toEqual({ status: 'connected', userId: 'u_bob', input: { credentialId: undefined, cloudId: 'cloud-1', projectKey: 'SPW' } });
    expect((await http.request('/api/connections/jira', { method: 'POST', headers: auth, body: JSON.stringify({ project: 'spw lower' }) })).status).toBe(400);
    expect((await http.request('/api/connections/ds_1', { method: 'PATCH', headers: auth, body: JSON.stringify({ jql: 'x' }) })).status).toBe(404);
  });

  it('H3 /api/connections/teams はチームとチャネルを渡す（本人のトークンが要る。0036・0037）', async () => {
    const { http } = await app();
    const auth = { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' };
    expect((await http.request('/api/connections/teams', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/teams', { method: 'POST', headers: auth, body: JSON.stringify({ team: 't1', channel: '19:c@thread.skype' }) });
    expect(await res.json()).toEqual({ status: 'connected', userId: 'u_bob', input: { credentialId: undefined, teamId: 't1', channelId: '19:c@thread.skype' } });
  });

  it('H3 /api/connections/todo はタスクのリストを渡す（本人のトークンが要る。0039）', async () => {
    const { http } = await app();
    const auth = { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' };
    expect((await http.request('/api/connections/todo', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/todo', { method: 'POST', headers: auth, body: JSON.stringify({ list: 'L_murmur' }) });
    expect(await res.json()).toEqual({ status: 'connected', userId: 'u_bob', input: { credentialId: undefined, listId: 'L_murmur' } });
  });

  it('H3 /api/connections/google-tasks はタスクのリストを渡す（本人のトークンが要る。0041）', async () => {
    const { http } = await app();
    const auth = { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' };
    expect((await http.request('/api/connections/google-tasks', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/google-tasks', { method: 'POST', headers: auth, body: JSON.stringify({ list: 'L_murmur', credential_id: 'gw_tasks' }) });
    expect(await res.json()).toEqual({ status: 'connected', userId: 'u_bob', input: { credentialId: 'gw_tasks', listId: 'L_murmur' } });
    expect((await http.request('/api/connections/google-tasks', { method: 'POST', headers: auth, body: JSON.stringify({ list: '' }) })).status).toBe(400);
  });

  it('H3 /api/connections/gmail は Outlook と同じ形（credential_id だけ。本人のトークンが要る。0041）', async () => {
    const { http } = await app();
    const auth = { authorization: `Bearer ${token('u_bob')}`, 'content-type': 'application/json' };
    expect((await http.request('/api/connections/gmail', { method: 'POST' })).status).toBe(401);
    const res = await http.request('/api/connections/gmail', { method: 'POST', headers: auth, body: JSON.stringify({ credential_id: 'gw_gmail' }) });
    expect(await res.json()).toEqual({ status: 'authorize', authorize_url: 'https://gw/authorize?u=u_bob&c=gw_gmail&k=gmail' });
    const none = await http.request('/api/connections/gmail', { method: 'POST', headers: auth, body: JSON.stringify({}) });
    expect(await none.json()).toEqual({ status: 'authorize', authorize_url: 'https://gw/authorize?u=u_bob&c=&k=gmail' });
    expect((await http.request('/api/connections/gmail', { method: 'POST', headers: auth, body: JSON.stringify({ credential_id: '' }) })).status).toBe(400);
  });

  it('設定がなければ 404', async () => {
    const { http } = await app(false);
    expect((await http.request('/oauth/callback?state=s&code=c')).status).toBe(404);
    expect((await http.request('/webhooks/graph', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
