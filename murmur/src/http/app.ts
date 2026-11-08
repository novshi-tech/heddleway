import { Router, type Context as RouterContext } from './router';
import { ZodError } from 'zod';
import { DomainError } from '../domain';
import type { MurmurService } from '../app/service';
import {
  AddAddressBody,
  AddNoteBody,
  ContactsQuery,
  CreateContactBody,
  CreateDataSourceBody,
  EndAddressBody,
  IdentityBody,
  MergeContactBody,
  RenameBody,
  AcknowledgeBody,
  AcknowledgeManyBody,
  ClaimBody,
  ConnectJiraBody, ConnectOutlookBody, ConnectTeamsBody,
  DismissBody,
  GetThreadQuery,
  InboundItemBody,
  LinkBody,
  ListThreadsQuery,
  MoveSignalBody,
  RecordSentBody,
  ReopenBody,
} from '../api/schemas';
import { bearerToken } from '../auth/bearer';
import type { Connections } from '../app/connections';
import { CALLBACK_PATH } from '../ports/gateway';
import { adminHref, renderAdminIndex, renderAdminList, renderAdminThread, renderTimeline } from './admin';

export interface HttpOptions {
  /** リクエストごとにサービスを組み立てる（Worker では DB 接続をリクエスト単位で張る） */
  service: (c: Context) => Promise<MurmurService> | MurmurService;
  /** API のトークンをゲートウェイの口で確かめて User ID を返す。失敗なら null */
  authenticate: (token: string) => Promise<string | null>;
  webhookVerify: (body: string, signature: string) => Promise<boolean>;
  timelineToken?: string;
  /** 外部コネクタ（0024）。設定がなければ /api/connections と Graph の口は 404 */
  connectors?: (c: Context) => Promise<ConnectorHttp | null> | ConnectorHttp | null;
}

export interface ConnectorHttp {
  connections: Connections;
  /** Graph の通知を照合してキューに積む。積んだ数を返す */
  notifications(body: unknown): Promise<number>;
  /** Jira の Webhook（0034）。URL の本人ごとの秘密を照合し、その本人の Jira を取り直すよう積む。照合できなければ null */
  jiraNotified(secret: string, body: unknown): Promise<number | null>;
}

type Vars = { userId: string; service: MurmurService };
type Context = RouterContext<Vars>;

const STATUS: Record<DomainError['code'], 400 | 403 | 404 | 409> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export function createApp(opts: HttpOptions) {
  const app = new Router<Vars>();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, STATUS[err.code]);
    if (err instanceof ZodError) return c.json({ error: 'invalid', message: err.issues }, 400);
    console.error(err);
    return c.json({ error: 'internal', message: 'internal error' }, 500);
  });

  app.use(async (c, next) => {
    c.set('service', await opts.service(c));
    await next();
  });

  // ---- スタンド向け API（ゲートウェイの中継の後ろ。ゲートウェイのトークンを必須にする） ----

  const api = new Router<Vars>();
  api.use(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const userId = token ? await opts.authenticate(token) : null;
    if (!userId) return c.json({ error: 'unauthenticated' }, 401);
    c.set('userId', userId);
    // サインインした sub の User がなければ作る（名前は空、Contact はなし。0030 の 6）
    await c.var.service.ensureUser(userId);
    await next();
  });

  const json = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };

  api.get('/me', async (c) => c.json(await c.var.service.me(c.var.userId)));

  api.patch('/me', async (c) => c.json(await c.var.service.renameMe(c.var.userId, RenameBody.parse(await json(c)).name)));

  // ---- リストとアイデンティティ（0030 の 7） ----

  api.post('/data-sources', async (c) => {
    const b = CreateDataSourceBody.parse(await json(c));
    return c.json(
      await c.var.service.createDataSource(c.var.userId, {
        channel: b.channel,
        name: b.name,
        description: b.description,
        identity: b.identity,
        gatewayCredentialId: b.gateway_credential_id,
        group: b.group,
      }),
    );
  });

  api.post('/lists/:id/identity', async (c) => {
    const b = IdentityBody.parse(await json(c));
    return c.json(await c.var.service.setIdentity(c.var.userId, c.req.param('id'), b.identity));
  });

  // ---- 名寄せと直す操作（0030 の 8・9） ----

  api.get('/addresses/unresolved', async (c) => c.json(await c.var.service.unresolvedAddresses(c.var.userId)));

  api.get('/contacts', async (c) => c.json(await c.var.service.searchContacts(c.var.userId, ContactsQuery.parse(c.req.query()).q)));

  api.get('/contacts/:id', async (c) => c.json(await c.var.service.getContact(c.var.userId, c.req.param('id'))));

  api.post('/contacts', async (c) => c.json(await c.var.service.createContact(c.var.userId, CreateContactBody.parse(await json(c)))));

  api.patch('/contacts/:id', async (c) =>
    c.json(await c.var.service.renameContact(c.var.userId, c.req.param('id'), RenameBody.parse(await json(c)).name)),
  );

  api.post('/contacts/:id/addresses', async (c) => {
    const b = AddAddressBody.parse(await json(c));
    return c.json(
      await c.var.service.addContactAddress(c.var.userId, c.req.param('id'), {
        address: { channel: b.channel, value: b.value },
        validFrom: b.valid_from,
        reason: b.reason,
      }),
    );
  });

  api.post('/contacts/:id/addresses/:addressId/end', async (c) => {
    const b = EndAddressBody.parse(await json(c));
    return c.json(
      await c.var.service.endContactAddress(c.var.userId, c.req.param('id'), c.req.param('addressId'), { validTo: b.valid_to, reason: b.reason }),
    );
  });

  api.post('/contacts/:id/merge', async (c) => {
    const b = MergeContactBody.parse(await json(c));
    return c.json(await c.var.service.mergeContacts(c.var.userId, c.req.param('id'), b.from, b.reason));
  });

  api.post('/contacts/:id/unbind', async (c) => c.json(await c.var.service.unbindContact(c.var.userId, c.req.param('id'))));

  api.get('/threads', async (c) => {
    const q = ListThreadsQuery.parse(c.req.query());
    return c.json(await c.var.service.listThreads(c.var.userId, { filter: q.filter, dataSourceId: q.data_source, since: q.since }));
  });

  api.get('/threads/:id', async (c) => {
    const q = GetThreadQuery.parse(c.req.query());
    return c.json(await c.var.service.getThread(c.var.userId, c.req.param('id'), { since: q.since }));
  });

  api.post('/notes', async (c) => {
    const b = AddNoteBody.parse(await json(c));
    return c.json(await c.var.service.addNote(c.var.userId, { threadId: b.thread_id, body: b.body, author: b.author }));
  });

  api.post('/threads/:id/claim', async (c) => {
    const b = ClaimBody.parse(await json(c));
    const userId = b.user_id === undefined ? c.var.userId : b.user_id;
    return c.json(await c.var.service.claimThread(c.var.userId, { threadId: c.req.param('id'), userId, reason: b.reason }));
  });

  api.post('/threads/:id/acknowledge', async (c) => {
    const b = AcknowledgeBody.parse(await json(c));
    return c.json(
      await c.var.service.acknowledge(c.var.userId, {
        threadId: c.req.param('id'),
        untilSignalId: b.until_signal_id,
        addresses: b.addresses,
        reason: b.reason,
      }),
    );
  });

  api.post('/acknowledge', async (c) => {
    const b = AcknowledgeManyBody.parse(await json(c));
    return c.json(await c.var.service.acknowledgeMany(c.var.userId, { threadIds: b.thread_ids, reason: b.reason }));
  });

  api.post('/threads/:id/links', async (c) => {
    const b = LinkBody.parse(await json(c));
    return c.json(await c.var.service.linkThreads(c.var.userId, { threadId: c.req.param('id'), otherThreadId: b.thread_id, reason: b.reason }));
  });

  api.post('/threads/:id/unlink', async (c) => {
    const b = LinkBody.parse(await json(c));
    return c.json(await c.var.service.unlinkThreads(c.var.userId, { threadId: c.req.param('id'), otherThreadId: b.thread_id, reason: b.reason }));
  });

  api.post('/sent', async (c) => {
    const b = RecordSentBody.parse(await json(c));
    const a = b.anchors;
    return c.json(
      await c.var.service.recordSent(c.var.userId, {
        dataSourceId: b.data_source,
        to: b.to,
        toContactIds: b.to_contact_ids,
        from: b.from,
        subject: b.subject,
        body: b.body,
        sentRef: b.sent_ref,
        anchors: {
          inReplyTo: a.in_reply_to,
          threadTs: a.thread_ts,
          quotedMessageId: a.quoted_message_id,
          threadKey: a.thread_key,
          jiraKeys: a.jira_keys,
          prRefs: a.pr_refs,
        },
        replyToThreadId: b.reply_to_thread_id,
        sourceThreadId: b.source_thread_id,
        replyExpectedBy: b.reply_expected_by,
        acknowledge: b.acknowledge,
      }),
    );
  });

  api.post('/threads/:id/dismiss', async (c) => {
    const b = DismissBody.parse(await json(c));
    return c.json(await c.var.service.dismissThread(c.var.userId, { threadId: c.req.param('id'), reason: b.reason }));
  });

  api.post('/threads/:id/reopen', async (c) => {
    const b = ReopenBody.parse(await json(c));
    return c.json(await c.var.service.reopenThread(c.var.userId, { threadId: c.req.param('id'), reason: b.reason }));
  });

  api.post('/signals/:id/move', async (c) => {
    const b = MoveSignalBody.parse(await json(c));
    const to = b.thread_id !== undefined ? { kind: 'existing' as const, threadId: b.thread_id } : { kind: 'new' as const, title: b.new_thread_title! };
    return c.json(
      await c.var.service.moveSignal(c.var.userId, { signalId: c.req.param('id'), to, reason: b.reason }),
    );
  });

  const connectors = async (c: Context) => {
    const k = opts.connectors ? await opts.connectors(c) : null;
    if (!k) throw new DomainError('not_found', 'connectors are not configured');
    return k;
  };

  api.get('/connections', async (c) => c.json(await (await connectors(c)).connections.list(c.var.userId)));

  api.post('/connections/outlook', async (c) => {
    const b = ConnectOutlookBody.parse(await json(c));
    return c.json(await (await connectors(c)).connections.connectOutlook(c.var.userId, b.credential_id));
  });

  api.post('/connections/teams', async (c) => {
    const b = ConnectTeamsBody.parse(await json(c));
    return c.json(await (await connectors(c)).connections.connectTeams(c.var.userId, { credentialId: b.credential_id, teamId: b.team, channelId: b.channel }));
  });

  api.post('/connections/jira', async (c) => {
    const b = ConnectJiraBody.parse(await json(c));
    return c.json(await (await connectors(c)).connections.connectJira(c.var.userId, { credentialId: b.credential_id, cloudId: b.site, projectKey: b.project }));
  });

  api.post('/connections/:id/disconnect', async (c) =>
    c.json(await (await connectors(c)).connections.disconnect(c.var.userId, c.req.param('id'))),
  );

  api.get('/lists', async (c) => c.json(await c.var.service.listLists(c.var.userId)));

  api.get('/lists/:id', async (c) => c.json(await c.var.service.getList(c.var.userId, c.req.param('id'))));

  app.route('/api', api);

  // ---- 公開ルート: Webhook と、TIMELINE_TOKEN で守る参照専用の画面（timeline.html・/admin）だけ ----

  app.post('/webhooks/dummy', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-murmur-signature') ?? '';
    if (!(await opts.webhookVerify(raw, sig))) return c.json({ error: 'bad signature' }, 401);
    const parsed = InboundItemBody.array().parse(JSON.parse(raw));
    const results = [];
    for (const item of parsed) results.push(await c.var.service.ingestItem(item));
    return c.json(results);
  });

  // Graph の変更通知とライフサイクルの通知（0024）。3 秒以内に返すため、照合してキューに積むだけ
  app.post('/webhooks/graph', async (c) => {
    const validationToken = c.req.query('validationToken');
    if (validationToken !== undefined) return c.text(validationToken, 200, { 'content-type': 'text/plain' });
    const k = await connectors(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid' }, 400);
    }
    await k.notifications(body);
    return c.body(null, 202);
  });

  // Jira の動的 Webhook（0034）。URL の本人ごとの秘密で照合し、中身は使わずに差分の取り直しを積むだけ
  app.post('/webhooks/jira/:secret', async (c) => {
    const k = await connectors(c);
    const body = await c.req.json().catch(() => null);
    const n = await k.jiraNotified(c.req.param('secret'), body);
    return n === null ? c.json({ error: 'not found' }, 404) : c.body(null, 202);
  });

  app.get(CALLBACK_PATH, async (c) => {
    const k = await connectors(c);
    let result;
    try {
      result = await k.connections.callback({ state: c.req.query('state') ?? null, code: c.req.query('code') ?? null, error: c.req.query('error') ?? null });
    } catch (err) {
      console.error(err);
      result = { ok: false, message: 'つなぐ途中で失敗しました。しばらくしてから、スタンドからもう一度頼んでください。' };
    }
    return c.html(renderCallback(result), result.ok ? 200 : 400);
  });

  // 参照専用の画面。全データソースが見えるので TIMELINE_TOKEN を知っている人だけ（知らなければ 404）
  const operatorOnly = (c: Context) => !!opts.timelineToken && c.req.query('token') === opts.timelineToken;

  app.get('/timeline.html', async (c) => {
    if (!operatorOnly(c)) return c.text('not found', 404);
    const service = c.var.service;
    const [p, dir] = await Promise.all([service.state(), service.directory()]);
    return c.html(renderTimeline(dir, p));
  });

  app.get('/admin', async (c) => {
    if (!operatorOnly(c)) return c.text('not found', 404);
    const service = c.var.service;
    const [p, dir] = await Promise.all([service.state(), service.directory()]);
    return c.html(renderAdminIndex(dir, p, adminHref(opts.timelineToken!)));
  });

  app.get('/admin/lists/:id', async (c) => {
    if (!operatorOnly(c)) return c.text('not found', 404);
    const service = c.var.service;
    const [p, dir] = await Promise.all([service.state(), service.directory()]);
    const html = renderAdminList(dir, p, c.req.param('id'), adminHref(opts.timelineToken!));
    return html ? c.html(html) : c.text('not found', 404);
  });

  app.get('/admin/threads/:id', async (c) => {
    if (!operatorOnly(c)) return c.text('not found', 404);
    const service = c.var.service;
    const [p, dir] = await Promise.all([service.state(), service.directory()]);
    const html = renderAdminThread(dir, p, c.req.param('id'), adminHref(opts.timelineToken!));
    return html ? c.html(html) : c.text('not found', 404);
  });

  return app;
}

function renderCallback(r: { ok: boolean; message: string }): string {
  const esc = r.message.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murmur</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>${r.ok ? 'つなぎました' : 'つなげませんでした'}</h1><p>${esc}</p><p>このタブは閉じてかまいません。</p></body></html>`;
}
