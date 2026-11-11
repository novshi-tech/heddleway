import type { SourceState } from '../graph/state';
import { RETRY_MINUTES } from '../graph/subscriptions';

// Google Tasks の見回りの計画（純関数。0041 の決定 1）。時刻は呼び出し側が渡す（now）。実行は sync.ts

/** 1 回の見回りで読むページの上限（1 ページ 100 件）。超えたら位置（resume）を残して次の見回りで続ける */
export const MAX_PAGES_PER_RUN = 20;
/** リストの名前を確かめ直す間隔（分）。変更の通知がないので、見回りの間隔とは別に間引く（API の上限のため） */
export const LIST_CHECK_MINUTES = 60;
/** Cron の発火と処理の時刻は秒単位でぶれる。間隔の判定はその分だけ手前から通す（15 分の設定が 20 分にならないように） */
export const POLL_SLACK_MS = 30_000;
/** 読み切ったときの cursor を、読み始めた時刻からさらに手前に取る余裕（ms）。Google の updated と こちらの時計のずれの取りこぼしを避ける */
export const CURSOR_MARGIN_MS = 60_000;
/** つないだ直後に積んだ取り込みの仕事を待つ時間（分）。この間は見回りが同じ取り込みを重ねて始めない */
export const SETUP_FRESH_MINUTES = 10;

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
      return isSetupFresh(source, now) ? { kind: 'idle' } : { kind: 'setup' };
    default:
      // 読みかけ（ページの上限で止めた）は間隔を待たずに続ける
      if (source.gtasks?.resume) return { kind: 'poll' };
      return isPollDue(now, source.lastSyncAt, intervalMinutes) ? { kind: 'poll' } : { kind: 'idle' };
  }
}

/**
 * つないだ直後の取り込みの仕事がまだ新しく、キューが処理している途中か（見回りが重ねて始めない）。
 * 積んだ時刻（setupAt。なければ connectedAt）から SETUP_FRESH_MINUTES 分以内で、読みかけ（resume）がなければ true。
 * 読みかけがあるのは取り込みが途中まで進んだ印なので、見回りが続ける（失敗した取り込みを 1 ページ目からやり直さない）
 */
export function isSetupFresh(source: SourceState, now: string): boolean {
  if (source.gtasks?.resume) return false;
  const since = Date.parse(source.gtasks?.setupAt ?? source.connectedAt);
  const elapsed = Date.parse(now) - since;
  return !Number.isNaN(elapsed) && elapsed >= 0 && elapsed < SETUP_FRESH_MINUTES * 60_000;
}

/** 読みかけ（resume）の型。state.ts の GtasksCursor.resume から null を除いたもの */
export type Resume = NonNullable<NonNullable<SourceState['gtasks']>['resume']>;

export interface ReadPlan {
  mode: 'full' | 'delta';
  /** この読みの updatedMin（full は null） */
  updatedMin: string | null;
  /** 続きから読むときの pageToken。最初からなら null */
  pageToken: string | null;
  /** 続きのとき、これまでに読んだ分の一番新しい updated */
  maxUpdated: string | null;
  /** 続きのとき、読みを始めた時刻（resume のもの）。最初からなら null（呼び出し側が今の時刻を使う） */
  startedAt: string | null;
}

/**
 * これから読む問い合わせの決め方。読みかけの pageToken は、それが属する問い合わせでしか使わない:
 * - 全部読む（full）が頼まれた: 読みかけが full ならその続き。差分の読みかけは捨てて最初から
 * - 差分（delta）が頼まれた: 読みかけが full なら、その full の続きを読む（途中で差分に切り替えない）。
 *   差分の読みかけは、同じ updatedMin のときだけ続ける（違えば捨てる）
 */
export function planRead(input: { requested: 'full' | 'delta'; cursor: string | null; resume: Resume | null | undefined }): ReadPlan {
  const { requested, cursor, resume } = input;
  const fresh: ReadPlan = { mode: requested, updatedMin: requested === 'delta' ? cursor : null, pageToken: null, maxUpdated: null, startedAt: null };
  if (!resume) return fresh;
  const usable = resume.mode === 'full' || (requested === 'delta' && resume.updatedMin === cursor);
  if (!usable) return fresh;
  return { mode: resume.mode, updatedMin: resume.mode === 'full' ? null : resume.updatedMin, pageToken: resume.pageToken, maxUpdated: resume.maxUpdated, startedAt: resume.startedAt };
}

/**
 * 読み切ったときの cursor。見えた中で一番新しい updated まで進めるが、読み始めた時刻から余裕（CURSOR_MARGIN_MS）を引いた時刻より
 * 後にはしない（読んでいる間に、すでに読んだページのタスクが更新されても、次に読み直せるように。重複して読むのは無害）。
 * 今の cursor より前には戻さない
 */
export function finalCursor(current: string | null, seen: readonly string[], startedAt: string): string | null {
  const candidate = advanceCursor(current, seen);
  const limit = Date.parse(startedAt) - CURSOR_MARGIN_MS;
  if (candidate === null || Number.isNaN(limit) || Date.parse(candidate) <= limit) return candidate;
  const capped = new Date(limit).toISOString();
  return current !== null && Date.parse(current) >= limit ? current : capped;
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
