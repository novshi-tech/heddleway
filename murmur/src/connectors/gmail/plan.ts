import type { SourceState } from '../graph/state';
import { RETRY_MINUTES } from '../graph/subscriptions';
import { skippedLabel } from './normalize';
import type { HistoryPage } from './message';

// Gmail の見回りの計画（純関数。0041 の決定 1・2）。時刻は呼び出し側が渡す（now）。実行は sync.ts

/** 1 回の見回りで messages.get する通数の上限。超えたら読んだ履歴のところまで cursor を進めて次の見回りで続ける */
export const MAX_FETCH_PER_RUN = 200;
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
  /** 処理を終えたあとの cursor。null は今のまま（進めるものがない） */
  nextCursor: string | null;
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
      }
      if (fetch.length > 0 && fetch.length + fresh.length > maxFetch) return { fetch, nextCursor: lastProcessed, complete: false };
      for (const id of fresh) {
        seen.add(id);
        fetch.push(id);
      }
      lastProcessed = record.id;
    }
  }
  const last = input.pages.at(-1);
  if (input.exhausted && last) return { fetch, nextCursor: last.historyId, complete: true };
  return { fetch, nextCursor: lastProcessed, complete: input.exhausted };
}

/** cursor が切れたときの拾い直しの検索の起点（エポック秒）。最後に読めた時刻から重なりの分だけ手前 */
export function recoveryAfter(lastSyncAt: string | null, connectedAt: string): number {
  const base = Date.parse(lastSyncAt ?? connectedAt);
  const t = Number.isNaN(base) ? Date.parse(connectedAt) : base;
  return Math.max(0, Math.floor((t - RECOVERY_OVERLAP_MINUTES * 60_000) / 1000));
}
