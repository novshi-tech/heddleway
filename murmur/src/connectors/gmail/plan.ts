import type { SourceState } from '../graph/state';
import { RETRY_MINUTES } from '../graph/subscriptions';
import { skippedLabel } from './normalize';
import type { HistoryPage } from './message';

// Gmail の見回りの計画（純関数。0041 の決定 1・2）。時刻は呼び出し側が渡す（now）。実行は sync.ts

/** 1 回の見回りで messages.get する通数の上限（メールボックス 1 つあたり）。超えたら読んだ履歴のところまで cursor を進めて次の見回りで続ける */
export const MAX_FETCH_PER_RUN = 50;
/** 取り込みの途中で位置を書く間隔（通）。履歴のレコードの切れ目で、これだけ進むたびに書く */
export const SAVE_EVERY = 10;
/** 拾い直しで集める ID の上限。超えたら新しい方だけを拾い直す（古い方は諦める） */
export const MAX_RECOVERY_IDS = 2000;
/** 種類の分からない失敗が同じメッセージで続いたら飛ばす回数（見回りごとに 1 回と数える） */
export const MAX_MESSAGE_FAILURES = 3;
/** 同じメッセージの失敗をもう一度数えるまでの間隔（分）。キューの再試行が数秒で回数を使い切らないように */
export const FAILURE_COUNT_INTERVAL_MINUTES = 4;
/** 1 回の見回りで読む history.list のページの上限（1 ページ最大 500 レコード） */
export const MAX_HISTORY_PAGES = 5;
/** cursor が切れたときの拾い直しで、1 回の見回りに読む messages.list のページの上限（1 ページ 100 通） */
export const MAX_RECOVERY_PAGES = 2;
/** 拾い直しの検索の起点を、最後に読めた時刻より手前に取る重なり（分）。検索の粒度（秒）と時計のずれの取りこぼしを避ける */
export const RECOVERY_OVERLAP_MINUTES = 10;

export type PollPlan = { kind: 'idle' } | { kind: 'retry' } | { kind: 'setup' } | { kind: 'poll' };

/** maintain でデータソース 1 つをどうするか。Gmail は見回りのたびに読む（間隔の設定はない） */
export function planPoll(source: SourceState, now: string): PollPlan {
  switch (source.status) {
    case 'disconnected':
      return { kind: 'idle' };
    case 'broken':
      return !source.lastRetryAt || (Date.parse(now) - Date.parse(source.lastRetryAt)) / 60_000 >= RETRY_MINUTES ? { kind: 'retry' } : { kind: 'idle' };
    case 'setup':
      return { kind: 'setup' };
    default:
      return { kind: 'poll' };
  }
}

export interface HistoryPlan {
  /** messages.get する ID。履歴の順で、重複とラベルで落とすものを除く */
  fetch: string[];
  /** 履歴のレコードが報せたラベル（ID → ラベル。届いたときのものとは限らない。実物で確かめる）。取り込む受信トレイ・送信済みの判定に、取ったメールのラベルと合わせて使う */
  labels: Record<string, string[]>;
  /** 処理を終えたあとの cursor。null は今のまま（進めるものがない） */
  nextCursor: string | null;
  /** レコードごとの取る ID（履歴の順。取るものがないレコードも入る）。取り込みの途中で位置を書く切れ目に使う */
  records: { id: string; ids: string[] }[];
  /** 読んだ分を全部処理したか。false なら、次の見回りが nextCursor から続ける */
  complete: boolean;
}

/**
 * history.list で読んだページから、取り込むメッセージと次の cursor を決める。
 * 履歴のレコードを順に見て、通数の上限（maxFetch）に達したらそこで止める。止めたときの cursor は、最後に処理し終えたレコードの id
 * （まだ見ていないレコードを飛ばさない）。レコード 1 つが上限より多くても、先頭のレコードは最後まで取る（進まなくなるのを避ける）。
 * cursor と同じ id のレコードは処理済みとして読み飛ばす（startHistoryId を含めて返す場合があっても、同じレコードで止まり続けない）。
 * 全部処理し、続きのページもなければ（exhausted）、最後のページの historyId（箱の最新）まで進める。変化がなくても進める
 * （cursor が古くなって切れるのを避ける）。続きのページがあるのに打ち切ったときは、最後のレコードの id までにする
 */
export function planHistory(input: { cursor: string; pages: readonly HistoryPage[]; exhausted: boolean; maxFetch?: number }): HistoryPlan {
  const maxFetch = input.maxFetch ?? MAX_FETCH_PER_RUN;
  const fetch: string[] = [];
  const labels: Record<string, string[]> = {};
  const records: { id: string; ids: string[] }[] = [];
  const seen = new Set<string>();
  let lastProcessed: string | null = null;
  for (const page of input.pages) {
    for (const record of page.history ?? []) {
      if (record.id === input.cursor) continue;
      const fresh: string[] = [];
      for (const { message } of record.messagesAdded ?? []) {
        if (seen.has(message.id) || fresh.includes(message.id)) continue;
        if (skippedLabel(message.labelIds)) continue;
        fresh.push(message.id);
        labels[message.id] = [...(message.labelIds ?? [])];
      }
      if (fetch.length > 0 && fetch.length + fresh.length > maxFetch) return { fetch, labels, records, nextCursor: lastProcessed, complete: false };
      for (const id of fresh) {
        seen.add(id);
        fetch.push(id);
      }
      records.push({ id: record.id, ids: fresh });
      lastProcessed = record.id;
    }
  }
  const last = input.pages.at(-1);
  if (input.exhausted && last) return { fetch, labels, records, nextCursor: last.historyId, complete: true };
  return { fetch, labels, records, nextCursor: lastProcessed, complete: input.exhausted };
}

/** cursor が切れたときの拾い直しの検索の起点（エポック秒）。最後に読めた時刻から重なりの分だけ手前 */
export function recoveryAfter(lastSyncAt: string | null, connectedAt: string): number {
  const base = Date.parse(lastSyncAt ?? connectedAt);
  const t = Number.isNaN(base) ? Date.parse(connectedAt) : base;
  return Math.max(0, Math.floor((t - RECOVERY_OVERLAP_MINUTES * 60_000) / 1000));
}

/**
 * 拾い直しで取り込む分を決める。集めた ID は messages.list の順（新しい順）で持つので、古い方（配列の末尾）から max 通取る。
 * chunk は取り込む順（古い方から）、remaining は残り（新しい順のまま）。スレッドの順は取り込んだ順なので、古い方から取り込む
 */
export function planRecoveryChunk(ids: readonly string[], max: number): { chunk: string[]; remaining: string[] } {
  const keep = Math.max(0, ids.length - max);
  return { chunk: ids.slice(keep).reverse(), remaining: ids.slice(0, keep) };
}

/** 拾い直しの ID の一覧に、検索の 1 ページの分を足す（重ねない）。上限を超えたら、先に来た方（新しい方）だけ残して truncated */
export function appendRecoveryIds(ids: readonly string[], add: readonly string[], max = MAX_RECOVERY_IDS): { ids: string[]; truncated: boolean } {
  const out = [...ids];
  const seen = new Set(out);
  let truncated = false;
  for (const id of add) {
    if (seen.has(id)) continue;
    if (out.length >= max) {
      truncated = true;
      break;
    }
    seen.add(id);
    out.push(id);
  }
  return { ids: out, truncated };
}

/**
 * 止まっているメッセージの失敗の回数（種類の分からない失敗だけ。failure.ts）。同じ ID が続けば足し、違う ID なら 1 から。
 * MAX_MESSAGE_FAILURES 回目で飛ばす。前に数えてから FAILURE_COUNT_INTERVAL_MINUTES 以内なら数え直さない（counted: false）
 */
export function nextFailure(
  blocked: { id: string; count: number; at?: string } | null | undefined,
  id: string,
  now: string,
): { count: number; skip: boolean; counted: boolean } {
  if (blocked && blocked.id === id) {
    const since = blocked.at ? (Date.parse(now) - Date.parse(blocked.at)) / 60_000 : Infinity;
    if (since < FAILURE_COUNT_INTERVAL_MINUTES) return { count: blocked.count, skip: blocked.count >= MAX_MESSAGE_FAILURES, counted: false };
    const count = blocked.count + 1;
    return { count, skip: count >= MAX_MESSAGE_FAILURES, counted: true };
  }
  return { count: 1, skip: 1 >= MAX_MESSAGE_FAILURES, counted: true };
}
