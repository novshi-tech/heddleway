import { describe, expect, it } from 'vitest';
import { GatewayGmailApi } from '../../src/connectors/gmail/api';
import { GMAIL_SCOPE } from '../../src/connectors/gmail/scope';
import { GatewayGraphApi } from '../../src/connectors/graph/api';
import { GRAPH_SCOPE } from '../../src/connectors/graph/scope';
import { GatewayGtasksApi } from '../../src/connectors/gtasks/api';
import { GTASKS_SCOPE } from '../../src/connectors/gtasks/scope';
import { GatewayJiraApi, JIRA_SCOPE } from '../../src/connectors/jira/api';
import { GatewayTeamsApi } from '../../src/connectors/teams/api';
import { TEAMS_SCOPE } from '../../src/connectors/teams/scope';
import { GatewayTodoApi } from '../../src/connectors/todo/api';
import { inScope, scopeTarget, UpstreamRefused, type ReadScope, type UpstreamCall, type UpstreamMethod } from '../../src/ports/gateway';

// 読める口の照合は、実際に送るパスと同じものに当てる（パスのすり抜けの封じ。全種類共通）

const SCOPES: Record<string, { scope: ReadScope; ok: string; traversal: string[] }> = {
  gmail: {
    scope: GMAIL_SCOPE,
    ok: '/gmail/v1/users/me/labels/Label_1',
    traversal: [
      '/gmail/v1/users/me/labels/..\\..\\..\\..\\..\\gmail\\v1\\users\\me\\drafts',
      '/gmail/v1/users/me/labels/%2e%2e',
      '/gmail/v1/users/me/labels/%2E%2E',
      '/gmail/v1/users/me/labels/..',
      '/gmail/v1/users/me/labels/.',
      '/gmail/v1/users/me/messages/a%2Fb',
      '/gmail/v1/users/me/messages/a%5Cb',
      '/gmail/v1/users/me/messages/abc#/../../drafts',
      '/gmail/v1/users/me/messages/../drafts',
    ],
  },
  gtasks: {
    scope: GTASKS_SCOPE,
    ok: '/tasks/v1/lists/MTIz/tasks/dGFzaw',
    traversal: [
      '/tasks/v1/lists/..\\..\\users\\@me\\lists/tasks',
      '/tasks/v1/lists/%2e%2e/tasks',
      '/tasks/v1/lists/../tasks',
      '/tasks/v1/lists/MTIz/tasks/%2e%2e',
      '/tasks/v1/lists/MTIz/tasks/..',
      '/tasks/v1/lists/a%2Fb/tasks',
      '/tasks/v1/lists/MTIz/tasks#x',
    ],
  },
  graph: {
    scope: GRAPH_SCOPE,
    ok: '/v1.0/me/messages/AAMk-AD_k=',
    traversal: [
      '/v1.0/me/..\\..\\subscriptions',
      '/v1.0/me/%2e%2e/%2e%2e/users',
      '/v1.0/me/../users/x',
      '/v1.0/me/messages/a%2Fb',
      '/v1.0/me/messages/..',
      '/v1.0/me#/../x',
    ],
  },
  teams: {
    scope: TEAMS_SCOPE,
    ok: '/v1.0/teams/t1/channels/19%3Aabc%40thread.skype/messages',
    traversal: [
      '/v1.0/teams/t1/channels/..\\..\\..\\me\\messages',
      '/v1.0/teams/t1/channels/%2e%2e/messages',
      '/v1.0/teams/..',
      '/v1.0/teams/t1/channels/a%2Fb/messages',
      '/v1.0/teams/t1/channels/x/messages#',
    ],
  },
  jira: {
    scope: JIRA_SCOPE,
    ok: '/ex/jira/cloud-1/rest/api/3/issue/ABC-12/comment',
    traversal: [
      '/ex/jira/..\\..\\..\\oauth\\token\\accessible-resources',
      '/ex/jira/%2e%2e/rest/api/3/myself',
      '/ex/jira/../x/rest/api/3/myself',
      '/ex/jira/a%2Fb/rest/api/3/myself',
      '/ex/jira/cloud-1/rest/api/3/myself#',
    ],
  },
};

describe('読める口のパスのすり抜けを封じる', () => {
  for (const [kind, { scope, ok, traversal }] of Object.entries(SCOPES)) {
    it(`${kind}: 正しいパスは通り、すり抜けの形は全部断る`, () => {
      expect(inScope(scope, 'GET', ok), ok).toBe(true);
      for (const path of traversal) expect(inScope(scope, 'GET', path), path).toBe(false);
    });
  }

  it('送るパスは照合したパスそのもの（正規化で変わるものは断る）', () => {
    const url = scopeTarget(GMAIL_SCOPE, 'GET', '/gmail/v1/users/me/messages/abc?format=full');
    expect(url?.pathname).toBe('/gmail/v1/users/me/messages/abc');
    expect(url?.search).toBe('?format=full');
    for (const path of ['//evil.example/gmail/v1/users/me/profile', ' /gmail/v1/users/me/profile', '/gmail/v1/users/me/pro\tfile', 'gmail/v1/users/me/profile', '/gmail/v1/users/me/pro file'])
      expect(scopeTarget(GMAIL_SCOPE, 'GET', path), JSON.stringify(path)).toBeNull();
  });

  it('クエリの中の符号化された記号や空白は口を変えない', () => {
    expect(inScope(GRAPH_SCOPE, 'GET', "/v1.0/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge 2026-11-01T00:00:00Z&$select=id")).toBe(true);
    expect(inScope(GMAIL_SCOPE, 'GET', '/gmail/v1/users/me/messages?q=a%2Fb%5C..&maxResults=1')).toBe(true);
  });
});

/** 口で照合してから記録する上流。照合に落ちたら UpstreamRefused（本物の口と同じ）。応答は空の JSON */
function recording(scope: ReadScope) {
  const calls: string[] = [];
  const upstream: UpstreamCall = async (method: UpstreamMethod, path: string) => {
    if (!scopeTarget(scope, method, path)) throw new UpstreamRefused(method, path);
    calls.push(`${method} ${path}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, upstream };
}

/** 応答の形が合わないエラーは無視し、口に断られたときだけ失敗にする */
async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UpstreamRefused) throw err;
  }
}

describe('本物らしい ID で組み立てたパスは新しい照合でも通る', () => {
  const GRAPH_ID = 'AAMkAGI2THVSAAA=';
  const GRAPH_ID_DASH = 'AQMkADAwATM3ZmYAZS0xMC1jZi04-Y_ADQAAAA==';
  const TEAMS_CHANNEL = '19:abc_def-1@thread.skype';

  it('Graph（Outlook・To Do）: フォルダとリストの ID、次のリンク', async () => {
    const { calls, upstream } = recording(GRAPH_SCOPE);
    const api = new GatewayGraphApi(upstream);
    const todo = new GatewayTodoApi(upstream);
    await run(() => api.deltaStart(GRAPH_ID, '2026-11-01T00:00:00Z'));
    await run(() => api.deltaStart(GRAPH_ID_DASH, '2026-11-01T00:00:00Z'));
    await run(() => todo.deltaStart(GRAPH_ID_DASH));
    await run(() => api.deltaNext(`https://graph.microsoft.com/v1.0/me/mailFolders('${GRAPH_ID}')/messages/delta?$skiptoken=abc123%3D&$select=id`));
    await run(() => todo.deltaNext(`https://graph.microsoft.com/v1.0/me/todo/lists/${GRAPH_ID_DASH}/tasks/delta?$deltatoken=x_y-z`));
    await run(() => api.renewSubscription('b0bb7e9c-1111-2222-3333-444455556666', '2026-11-12T00:00:00Z'));
    expect(calls).toHaveLength(6);
  });

  it('Teams: チャネル ID（コロンと @ を符号化）、次のリンク', async () => {
    const { calls, upstream } = recording(TEAMS_SCOPE);
    const api = new GatewayTeamsApi(upstream);
    await run(() => api.channels('team-1'));
    await run(() => api.messages('00000000-aaaa-bbbb-cccc-dddddddddddd', TEAMS_CHANNEL));
    await run(() => api.members('00000000-aaaa-bbbb-cccc-dddddddddddd', TEAMS_CHANNEL));
    await run(() =>
      api.messages('t', TEAMS_CHANNEL, `https://graph.microsoft.com/v1.0/teams/t/channels/${encodeURIComponent(TEAMS_CHANNEL)}/messages?$top=50&$skiptoken=%5B%5D`),
    );
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('/channels/19%3Aabc_def-1%40thread.skype/messages');
  });

  it('Jira: cloudId・課題キー・ページトークン', async () => {
    const { calls, upstream } = recording(JIRA_SCOPE);
    const api = new GatewayJiraApi(upstream);
    await run(() => api.myself('1324a887-45db-1bf4-1e99-ef0ff456d421'));
    await run(() => api.search('1324a887-45db-1bf4-1e99-ef0ff456d421', 'project = SPW', 'tok/en+='));
    await run(() => api.comments('1324a887-45db-1bf4-1e99-ef0ff456d421', 'SPW_X1-123'));
    await run(() => api.browsers('cloud-1', 'SPW'));
    expect(calls).toHaveLength(4);
  });

  it('Google（Gmail・Tasks）: ID と pageToken', async () => {
    const g = recording(GMAIL_SCOPE);
    const gmail = new GatewayGmailApi(g.upstream);
    await run(() => gmail.message('18c0ffee12345678'));
    await run(() => gmail.history('123456', 'tok/en+=='));
    await run(() => gmail.list(1_700_000_000, 'CgsI4_-x'));
    expect(g.calls).toHaveLength(3);
    const t = recording(GTASKS_SCOPE);
    const tasks = new GatewayGtasksApi(t.upstream);
    await run(() => tasks.list('MDEyMzQ1Njc4OTAxMjM0NTY3ODk6MDow'));
    await run(() => tasks.tasks('MDEyMzQ1Njc4OTAxMjM0NTY3ODk6MDow', { updatedMin: '2026-11-01T00:00:00.000Z', pageToken: 'a/b+c==' }));
    await run(() => tasks.account());
    expect(t.calls).toHaveLength(3);
  });

  it('id が ".." のものは符号化しても通らない（呼び出しが断られる）', async () => {
    const g = recording(GTASKS_SCOPE);
    await expect(new GatewayGtasksApi(g.upstream).list('..')).rejects.toBeInstanceOf(UpstreamRefused);
    const m = recording(GMAIL_SCOPE);
    await expect(new GatewayGmailApi(m.upstream).message('..')).rejects.toBeInstanceOf(UpstreamRefused);
    const tm = recording(TEAMS_SCOPE);
    await expect(new GatewayTeamsApi(tm.upstream).channels('..')).rejects.toBeInstanceOf(UpstreamRefused);
  });
});
