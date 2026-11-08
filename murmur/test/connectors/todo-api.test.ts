import { describe, expect, it } from 'vitest';
import { GatewayTodoApi } from '../../src/connectors/todo/api';
import { normalizeTask } from '../../src/connectors/todo/normalize';
import { TodoTask } from '../../src/connectors/todo/task';
import type { UpstreamCall } from '../../src/ports/gateway';

// To Do の読み取りの口（ゲートウェイの REST 経由）。上流は偽物の関数

describe('H9 To Do の期限は本人のタイムゾーンで受け取る（0039）', () => {
  it('メールボックスのタイムゾーンを 1 回だけ引き、delta に Prefer: outlook.timezone を付ける。その日付が写しの due になる', async () => {
    const calls: { path: string; prefer?: string }[] = [];
    const upstream: UpstreamCall = async (_method, path, init) => {
      calls.push({ path, prefer: init?.headers?.prefer });
      if (path.startsWith('/v1.0/me/mailboxSettings')) return Response.json({ timeZone: 'Tokyo Standard Time' });
      const zoned = init?.headers?.prefer?.includes('outlook.timezone="Tokyo Standard Time"');
      return Response.json({
        value: [{ id: 'T1', title: '見積', status: 'notStarted', dueDateTime: zoned ? { dateTime: '2026-11-20T00:00:00.0000000', timeZone: 'Tokyo Standard Time' } : { dateTime: '2026-11-19T15:00:00.0000000', timeZone: 'UTC' } }],
        '@odata.nextLink': path.includes('skiptoken') ? undefined : 'https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/delta?$skiptoken=x',
      });
    };
    const api = new GatewayTodoApi(upstream);
    const first = await api.deltaStart('L1');
    await api.deltaNext(first['@odata.nextLink']!);
    expect(calls.map((c) => c.path)).toEqual(['/v1.0/me/mailboxSettings?$select=timeZone', '/v1.0/me/todo/lists/L1/tasks/delta', '/v1.0/me/todo/lists/L1/tasks/delta?$skiptoken=x']);
    expect(calls.slice(1).every((c) => c.prefer?.endsWith('outlook.timezone="Tokyo Standard Time"'))).toBe(true);
    const n = normalizeTask({ dataSourceId: 'd', account: 'a@x', listName: 'L', connectedAt: '2026-11-01T00:00:00Z' }, TodoTask.parse(first.value[0]));
    expect(n.kind === 'mirror' && n.mirror.fields.due).toBe('2026-11-20');
  });

  it('タイムゾーンが取れなければ付けない（既定の UTC のまま）', async () => {
    const prefers: (string | undefined)[] = [];
    const api = new GatewayTodoApi(async (_m, path, init) => {
      prefers.push(init?.headers?.prefer);
      return Response.json(path.startsWith('/v1.0/me/mailboxSettings') ? {} : { value: [] });
    });
    await api.deltaStart('L1');
    expect(prefers[1]).not.toContain('outlook.timezone');
  });
});
