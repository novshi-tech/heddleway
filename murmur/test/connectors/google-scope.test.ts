import { describe, expect, it } from 'vitest';
import { GMAIL_SCOPE } from '../../src/connectors/gmail/scope';
import { GTASKS_SCOPE } from '../../src/connectors/gtasks/scope';
import { inScope, type UpstreamMethod } from '../../src/ports/gateway';

// Gmail と Google Tasks の読める口（0041 の決定 4）

const allowed = (scope: typeof GMAIL_SCOPE, method: UpstreamMethod, path: string) => inScope(scope, method, path);
const WRITES: UpstreamMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('GMAIL_SCOPE', () => {
  it('users/me の下の読み取りだけ通す（クエリは口を変えない）', () => {
    for (const path of [
      '/gmail/v1/users/me/profile',
      '/gmail/v1/users/me/history?startHistoryId=1&historyTypes=messageAdded',
      '/gmail/v1/users/me/messages',
      '/gmail/v1/users/me/messages?q=after:1700000000&maxResults=100',
      '/gmail/v1/users/me/messages/18c0ffee?format=full',
      '/gmail/v1/users/me/labels',
      '/gmail/v1/users/me/labels/Label_1',
      '/gmail/v1/users/me/settings/sendAs',
    ]) expect(allowed(GMAIL_SCOPE, 'GET', path), path).toBe(true);
  });

  it('書き込みの種類はどの口でも断る（送信・下書き・変更・削除・watch）', () => {
    for (const method of WRITES) {
      for (const path of [
        '/gmail/v1/users/me/messages/send',
        '/gmail/v1/users/me/messages',
        '/gmail/v1/users/me/messages/18c0ffee',
        '/gmail/v1/users/me/messages/18c0ffee/modify',
        '/gmail/v1/users/me/drafts',
        '/gmail/v1/users/me/labels',
        '/gmail/v1/users/me/watch',
        '/gmail/v1/users/me/profile',
      ]) expect(allowed(GMAIL_SCOPE, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('隣の口と他人の箱は断る', () => {
    for (const path of [
      '/gmail/v1/users/me/messages/send',
      '/gmail/v1/users/me/messages/batchModify',
      '/gmail/v1/users/me/messages/18c0ffee/attachments/a1',
      '/gmail/v1/users/me/messages/18c0ffee/trash',
      '/gmail/v1/users/me/drafts',
      '/gmail/v1/users/me/threads',
      '/gmail/v1/users/me/settings/filters',
      '/gmail/v1/users/me/settings/sendAs/x@example.com',
      '/gmail/v1/users/someone@example.com/profile',
      '/gmail/v1/users/me/profile/extra',
      '/gmail/v1/users/me',
      '/v1.0/me/messages',
    ]) expect(allowed(GMAIL_SCOPE, 'GET', path), path).toBe(false);
  });
});

describe('GTASKS_SCOPE', () => {
  it('タスクのリストとタスクの読み取りだけ通す', () => {
    for (const path of [
      '/tasks/v1/users/@me/lists',
      '/tasks/v1/users/@me/lists?maxResults=100',
      '/tasks/v1/users/@me/lists/MTIz',
      '/tasks/v1/lists/MTIz/tasks',
      '/tasks/v1/lists/MTIz/tasks?updatedMin=2026-11-01T00:00:00Z&showCompleted=true&showHidden=true&showDeleted=true',
      '/tasks/v1/lists/MTIz/tasks/dGFzaw',
    ]) expect(allowed(GTASKS_SCOPE, 'GET', path), path).toBe(true);
  });

  it('書き込みの種類は断る（作成・更新・完了・削除・移動・クリア）', () => {
    for (const method of WRITES) {
      for (const path of [
        '/tasks/v1/users/@me/lists',
        '/tasks/v1/users/@me/lists/MTIz',
        '/tasks/v1/lists/MTIz/tasks',
        '/tasks/v1/lists/MTIz/tasks/dGFzaw',
        '/tasks/v1/lists/MTIz/tasks/dGFzaw/move',
        '/tasks/v1/lists/MTIz/clear',
      ]) expect(allowed(GTASKS_SCOPE, method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('隣の口と他人のリストは断る', () => {
    for (const path of [
      '/tasks/v1/users/someone@example.com/lists',
      '/tasks/v1/users/@me/lists/MTIz/tasks',
      '/tasks/v1/lists/MTIz',
      '/tasks/v1/lists/MTIz/tasks/dGFzaw/move',
      '/tasks/v1/lists/MTIz/clear',
      '/tasks/v1/lists/MTIz/tasks/a/b',
      '/gmail/v1/users/me/profile',
    ]) expect(allowed(GTASKS_SCOPE, 'GET', path), path).toBe(false);
  });
});
