import type { SourceState } from '../graph/state';

// Jira の取り込みの計画（純関数。0034 の決定 3）。実行は sync.ts。

/** 前回の同期からの分数に足す重なり。二重に取った分は sourceRef の重複排除で落ちる */
export const OVERLAP_MINUTES = 5;
/** Webhook を取りこぼしても・ウォッチだけの課題も、この間隔で差分を取る */
export const SAFETY_SYNC_MINUTES = 10;
/** Webhook の寿命（30 日）の残りがこれを切ったら延ばす */
export const REFRESH_BEFORE_DAYS = 7;
/** broken を試し直す間隔 */
export const RETRY_MINUTES = 60;
/** key in (...) に並べる課題キーの数 */
export const KEYS_PER_QUERY = 50;

export const WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'comment_created'];

export type JiraMaintenance =
  | { kind: 'idle' }
  | { kind: 'retry' }
  | { kind: 'cleanup' }
  | { kind: 'maintain'; register: boolean; refresh: boolean; sync: boolean };

/** webhookUrlHash を渡すと、それと違う受け口で登録した Webhook（記録のない古いものも）は登録し直す */
export function planJiraMaintenance(source: SourceState, now: string, webhooks: boolean, webhookUrlHash?: string): JiraMaintenance {
  const j = source.jira;
  if (source.status === 'disconnected') return j && j.webhookIds.length > 0 ? { kind: 'cleanup' } : { kind: 'idle' };
  if (source.status === 'broken') return !source.lastRetryAt || minutesBetween(source.lastRetryAt, now) >= RETRY_MINUTES ? { kind: 'retry' } : { kind: 'idle' };
  const moved = webhookUrlHash !== undefined && j?.webhookUrlHash !== webhookUrlHash;
  const register = webhooks && (!j || j.webhookIds.length === 0 || !j.webhookExpiresAt || j.webhookExpiresAt <= now || moved);
  const refresh = webhooks && !register && !!j?.webhookExpiresAt && minutesBetween(now, j.webhookExpiresAt) < REFRESH_BEFORE_DAYS * 24 * 60;
  const sync = source.status === 'setup' || !source.lastSyncAt || minutesBetween(source.lastSyncAt, now) >= SAFETY_SYNC_MINUTES;
  return register || refresh || sync ? { kind: 'maintain', register, refresh, sync } : { kind: 'idle' };
}

/**
 * 差分の JQL。時刻は相対（-<N>m）で書く（JQL の絶対時刻は本人のプロフィールのタイムゾーンで読まれる。0034 の決定 3）。
 * 範囲から外れても、開いているスレッドの課題（keys）は取り続ける
 */
export function deltaJql(scope: string, keys: readonly string[], since: string, now: string): string {
  const minutes = Math.max(1, Math.ceil(minutesBetween(since, now))) + OVERLAP_MINUTES;
  const range = keys.length > 0 ? `(${scope}) OR key in (${keys.join(', ')})` : scope;
  return `(${range}) AND updated >= -${minutes}m ORDER BY updated ASC`;
}

/**
 * Webhook の jqlFilter。jqlFilter では watcher が使えない（S0）ので、watcher を含む範囲なら担当・起票に広げる。
 * ウォッチだけの課題は見回りの差分で拾う
 */
export function webhookFilter(scope: string): string {
  return /\bwatcher\b/i.test(scope) ? 'assignee = currentUser() OR reporter = currentUser()' : scope;
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

export function minutesBefore(at: string, minutes: number): string {
  return new Date(Date.parse(at) - minutes * 60_000).toISOString();
}
