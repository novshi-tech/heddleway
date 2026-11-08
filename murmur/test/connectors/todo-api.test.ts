import { describe, expect, it } from 'vitest';
import { GatewayTodoApi } from '../../src/connectors/todo/api';
import { dueDate } from '../../src/connectors/todo/normalize';
import { TodoTask } from '../../src/connectors/todo/task';
import type { UpstreamCall } from '../../src/ports/gateway';

// To Do の読み取りの口（ゲートウェイの REST 経由）と、期限の日付への直し。上流は偽物の関数

const task = (dueDateTime: unknown) => TodoTask.parse({ id: 'T', title: 't', dueDateTime });

describe('H9 To Do の期限の日付（0039）', () => {
  it('UTC で返った期限は一番近い 0 時に丸める（2026-11-08 に実物で確かめた形）', () => {
    // 東京の 2/13 の期限は、Prefer なしだと 2/12 15:00 UTC で返る
    expect(dueDate(task({ dateTime: '2026-02-12T15:00:00.0000000', timeZone: 'UTC' }))).toBe('2026-02-13');
    // 西のタイムゾーン（ニューヨークの 2/13 は 2/13 05:00 UTC）
    expect(dueDate(task({ dateTime: '2026-02-13T05:00:00.0000000', timeZone: 'UTC' }))).toBe('2026-02-13');
    expect(dueDate(task({ dateTime: '2026-02-13T00:00:00.0000000', timeZone: 'UTC' }))).toBe('2026-02-13');
  });

  it('ほかのタイムゾーンで返れば、日付の部分がそのまま期限。期限がなければ null', () => {
    expect(dueDate(task({ dateTime: '2026-02-13T00:00:00.0000000', timeZone: 'Tokyo Standard Time' }))).toBe('2026-02-13');
    expect(dueDate(task(null))).toBeNull();
    expect(dueDate(TodoTask.parse({ id: 'T' }))).toBeNull();
  });
});

describe('H9 To Do の読み取りの口', () => {
  it('delta は本人の箱の下だけを読み、メールボックスの設定（MailboxSettings.Read が要る）は読まない', async () => {
    const paths: string[] = [];
    const upstream: UpstreamCall = async (_method, path) => {
      paths.push(path);
      return Response.json({
        value: [],
        ...(path.includes('skiptoken') ? { '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/delta?$deltatoken=y' } : { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/delta?$skiptoken=x' }),
      });
    };
    const api = new GatewayTodoApi(upstream);
    const first = await api.deltaStart('L1');
    await api.deltaNext(first['@odata.nextLink']!);
    expect(paths).toEqual(['/v1.0/me/todo/lists/L1/tasks/delta', '/v1.0/me/todo/lists/L1/tasks/delta?$skiptoken=x']);
  });
});
