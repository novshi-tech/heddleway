import type { SourceState } from '../graph/state';
import { RETRY_MINUTES } from '../graph/subscriptions';

// Google Tasks の見回りの計画（純関数。0041 の決定 1）。時刻は呼び出し側が渡す（now）。実行は sync.ts

/** 1 回の見回りで読むページの上限（1 ページ 100 件）。超えたら位置（resume）を残して次の見回りで続ける */
export const MAX_PAGES_PER_RUN = 20;
/** リストの名前を確かめ直す間隔（分）。変更の通知がないので、見回りの間隔とは別に間引く（API の上限のため） */
export const LIST_CHECK_MINUTES = 60;
/** Cron の発火と処理の時刻は秒単位でぶれる。間隔の判定はその分だけ手前から通す（15 分の設定が 20 分にならないように） */
export const POLL_SLACK_MS = 30_000;

export type PollPlan =
  | { kind: 'idle' }
  /** broken から試し直す */
  | { kind: 'retry' }
  /** つないだ直後の取り込みが済んでいない（キューの取りこぼし）: リストを全部読む */
  | { kind: 'setup' }
  | { kind: 'poll' };

/**
 * 見回りの間隔の判定。最後に読み終えた時刻から intervalMinutes 分たっていれば true。
 * 間隔がない（未設定）か、まだ一度も読んでいなければ true（見回りのたび）
 */
export function isPollDue(now: string, lastPolledAt: string | null, intervalMinutes: number | undefined): boolean {
  if (!intervalMinutes || intervalMinutes <= 0 || !lastPolledAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastPolledAt);
  return Number.isNaN(elapsed) || elapsed + POLL_SLACK_MS >= intervalMinutes * 60_000;
}

/** maintain でデータソース 1 つをどうするか。lastSyncAt は最後に（ページの上限に達せず）読み終えた時刻 */
export function planPoll(source: SourceState, now: string, intervalMinutes: number | undefined): PollPlan {
  switch (source.status) {
    case 'disconnected':
      return { kind: 'idle' };
    case 'broken':
      return !source.lastRetryAt || (Date.parse(now) - Date.parse(source.lastRetryAt)) / 60_000 >= RETRY_MINUTES ? { kind: 'retry' } : { kind: 'idle' };
    case 'setup':
      return { kind: 'setup' };
    default:
      // 読みかけ（ページの上限で止めた）は間隔を待たずに続ける
      if (source.gtasks?.resume) return { kind: 'poll' };
      return isPollDue(now, source.lastSyncAt, intervalMinutes) ? { kind: 'poll' } : { kind: 'idle' };
  }
}

/**
 * cursor（updatedMin）の進め方。読み切ったあとに、見えた中で一番新しい updated まで進める。何も見えなければそのまま。
 * Google はタスクを更新順ではなく並び順で返すので、読み切るまで進めない（途中で進めると、まだ見ていない古い更新を飛ばす）
 */
export function advanceCursor(current: string | null, seen: readonly string[]): string | null {
  let best = current;
  for (const u of seen) if (!Number.isNaN(Date.parse(u)) && (best === null || Date.parse(u) > Date.parse(best))) best = u;
  return best;
}

/** リストの名前を確かめ直す時か */
export function isListCheckDue(now: string, listCheckedAt: string | null | undefined): boolean {
  return !listCheckedAt || (Date.parse(now) - Date.parse(listCheckedAt)) / 60_000 >= LIST_CHECK_MINUTES;
}
