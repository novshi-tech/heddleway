import { googleChatAccount, googleUserId, type SpaceMember } from '../../domain';
import type { GoogleChatDmRecord, SourceState } from '../graph/state';
import { RETRY_MINUTES } from '../graph/subscriptions';
import type { ChatMembership, ChatMessage, ChatSpace } from './message';

// Google Chat の取り込みの計画（純関数。0045 の決定 4）。実行は sync.ts。時刻は呼び出し側が渡す

/**
 * 一覧は createTime の古い順で、位置は取り込んだ最後のメッセージの createTime。
 * 重なりは、作られてから一覧に出るまでの遅れの保険の分だけ。二重は sourceRef の重複排除で落ちる
 */
export const OVERLAP_MINUTES = 10;
/** 1 回の見回りで、スペース 1 つについて読むページ（CHAT_PAGE_SIZE 件）の上限。超えたら位置まで進めて、次の見回りで続ける */
export const MAX_PAGES_PER_SPACE = 5;
/** 1 回の見回りで読む DM・グループの上限。超えた分は位置が進まないので、次の見回りで読む */
export const MAX_SPACES_PER_RUN = 50;
/** 共有リストの読者を写す間隔 */
export const READERS_SYNC_MINUTES = 60;
/** DM・グループの種類とメンバーを読み直す間隔 */
export const DM_RECHECK_MINUTES = 24 * 60;
/** つないだ直後に積んだ取り込みの仕事を待つ時間。この間は見回りが同じ取り込みを重ねて始めない */
export const SETUP_FRESH_MINUTES = 10;

export function minus(at: string, minutes: number): string {
  return new Date(Date.parse(at) - minutes * 60_000).toISOString();
}

export function minutesSince(at: string | null | undefined, now: string): number {
  if (!at) return Infinity;
  const ms = Date.parse(now) - Date.parse(at);
  return Number.isNaN(ms) ? Infinity : ms / 60_000;
}

export type PollPlan = { kind: 'idle' } | { kind: 'retry' } | { kind: 'setup' } | { kind: 'poll' };

/**
 * maintain でデータソース 1 つをどうするか。setupAt はつないだ（つなぎ直した）直後の取り込みの仕事を積んだ時刻。
 * 見回りの間隔は Cron（5 分）のまま（0041 の決定 1）
 */
export function planPoll(source: SourceState, setupAt: string | null | undefined, now: string): PollPlan {
  switch (source.status) {
    case 'disconnected':
      return { kind: 'idle' };
    case 'broken':
      return minutesSince(source.lastRetryAt, now) >= RETRY_MINUTES ? { kind: 'retry' } : { kind: 'idle' };
    case 'setup':
      return minutesSince(setupAt ?? source.connectedAt, now) < SETUP_FRESH_MINUTES ? { kind: 'idle' } : { kind: 'setup' };
    default:
      return { kind: 'poll' };
  }
}

/** 取り込むメッセージ（古い順）。つなぐ前に作られたものは除く */
export function planMessages(page: readonly ChatMessage[], connectedAt: string): ChatMessage[] {
  return page.filter((m) => m.createTime >= connectedAt).sort((a, b) => a.createTime.localeCompare(b.createTime));
}

/** 読んだメッセージから位置を進める（読んだ中で一番新しい createTime。前の位置より戻さない） */
export function advance(syncedUntil: string, page: readonly ChatMessage[]): string {
  let at = syncedUntil;
  for (const m of page) if (m.createTime > at) at = m.createTime;
  return at;
}

/** スペースのメンバー → 共有リストの読者の候補（0037 の決定 2）。人だけ。Chat の users/<ID> の ID は sub と同じなので、名乗りなしで User が付く */
export function chatMembers(memberships: readonly ChatMembership[]): SpaceMember[] {
  const out: SpaceMember[] = [];
  for (const m of memberships) {
    if (m.state && m.state !== 'JOINED') continue;
    if (m.member?.type !== 'HUMAN') continue;
    const account = googleChatAccount(m.member.name);
    if (!account) continue;
    out.push({ address: { channel: 'google-chat', value: account }, userId: googleUserId(account) });
  }
  return out;
}

/** スペースがスレッドを使うか（THREADED_MESSAGES。分からなければ使う側に倒す: 返信がばらけるより、スレッドが 1 つずつのほうが害が小さい） */
export function isThreaded(space: ChatSpace): boolean {
  return space.spaceThreadingState !== 'UNTHREADED_MESSAGES';
}

/**
 * DM・グループの種類（決定 2）。グループのチャットは group。DM は、アプリとの DM（singleUserBotDm、
 * 人の相手がいずアプリがいる）なら skip、ほかは direct。メンバーが読めなければ（null）skip
 */
export function dmRecord(space: ChatSpace, memberships: readonly ChatMembership[] | null, self: string, now: string): GoogleChatDmRecord {
  if (memberships === null) return { kind: 'skip', members: [], checkedAt: now };
  const people = memberships.filter((m) => m.member?.type === 'HUMAN').flatMap((m) => googleChatAccount(m.member?.name) ?? []);
  const bots = memberships.some((m) => m.member?.type === 'BOT');
  if (space.spaceType === 'GROUP_CHAT') return { kind: 'group', members: people, checkedAt: now };
  if (space.spaceType !== 'DIRECT_MESSAGE') return { kind: 'skip', members: [], checkedAt: now };
  if (space.singleUserBotDm || (bots && !people.some((p) => p !== self))) return { kind: 'skip', members: people, checkedAt: now };
  return { kind: 'direct', members: people, checkedAt: now };
}

export function needsCheck(record: GoogleChatDmRecord | undefined, now: string): boolean {
  return !record || minutesSince(record.checkedAt, now) >= DM_RECHECK_MINUTES;
}

/**
 * 見回りで読む DM・グループを選ぶ（lastActiveTime の新しい順、上限 MAX_SPACES_PER_RUN）。
 * 読むのは、最後に動いた時刻がそのスペースの位置（なければつないだ時刻）より後のもの。取り込まないもの（skip）は、読み直す時期まで読まない
 */
export function planDmSpaces(spaces: readonly ChatSpace[], records: Readonly<Record<string, GoogleChatDmRecord>>, connectedAt: string, now: string): ChatSpace[] {
  return spaces
    .filter((s) => {
      if (!s.lastActiveTime) return false;
      const record = records[s.name];
      if (record?.kind === 'skip' && !needsCheck(record, now)) return false;
      return s.lastActiveTime > (record?.syncedUntil ?? connectedAt);
    })
    .sort((a, b) => (b.lastActiveTime ?? '').localeCompare(a.lastActiveTime ?? ''))
    .slice(0, MAX_SPACES_PER_RUN);
}
