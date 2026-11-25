import type { TeamsChatRecord } from '../graph/state';
import type { TeamsMessage } from '../teams/message';
import type { Chat, ChatMember } from './message';

// Teams のチャットの取り込みの計画（純関数。0044 の決定 5）。実行は sync.ts。

/**
 * チャットの一覧は最後のメッセージの順に正確に並び、メッセージは lastModifiedDateTime で絞れる（S0）。
 * 重なりは通知の遅れと取りこぼしの保険の分だけでよい。二重は sourceRef の重複排除で落ちる
 */
export const OVERLAP_MINUTES = 30;
/** 通知を落としても、この間隔でチャットの一覧を見回る（保険） */
export const SAFETY_SYNC_MINUTES = 10;
/** チャットの種類とメンバーを読み直す間隔（グループのメンバーの出入り） */
export const CHAT_RECHECK_MINUTES = 24 * 60;
/** 1 回の仕事で読むページ（50 件）の上限（チャット 1 つのメッセージ、一覧） */
export const MAX_PAGES_PER_JOB = 10;
/** 1 回の見回りで読むチャットの上限。超えたら位置を進めずに続きを積む */
export const MAX_CHATS_PER_SCAN = 50;
/** サブスクリプションの台帳の「フォルダ」（Outlook・Teams のチャネルと台帳を共有する） */
export const CHATS_FOLDER = 'chats';

export function minus(at: string, minutes: number): string {
  return new Date(Date.parse(at) - minutes * 60_000).toISOString();
}

/**
 * チャットの種類（0044 の決定 1）。取り込むのは 1 対 1 とグループだけ（許すものを並べる）。会議のチャットと、
 * 委任では読めない種類（unknownFutureValue）は取り込まない。1 対 1 で人のメンバーが本人だけ（相手がアプリ）なら取り込まない
 */
export function chatRecord(chat: Chat, members: readonly ChatMember[] | null, selfObjectId: string, now: string): TeamsChatRecord {
  const people = (members ?? [])
    .filter((m): m is ChatMember & { userId: string } => !!m.userId)
    .map((m) => ({ objectId: m.userId, tenantId: m.tenantId ?? null }));
  const tenantId = chat.tenantId ?? null;
  const type = chat.chatType;
  if ((type !== 'oneOnOne' && type !== 'group') || members === null) return { kind: 'skip', tenantId, members: [], checkedAt: now };
  if (type === 'oneOnOne' && !people.some((m) => m.objectId !== selfObjectId)) return { kind: 'skip', tenantId, members: people, checkedAt: now };
  return { kind: type === 'oneOnOne' ? 'direct' : 'group', tenantId, members: people, checkedAt: now };
}

/** 種類とメンバーを読み直すか（覚えていない・古い） */
export function needsCheck(record: TeamsChatRecord | undefined, now: string): boolean {
  return !record || Date.parse(now) - Date.parse(record.checkedAt) >= CHAT_RECHECK_MINUTES * 60_000;
}

/** チャットのメッセージを読む起点（このチャットの位置か、つないだ時刻から重なりを引いた時刻） */
export function chatFloor(record: TeamsChatRecord | undefined, connectedAt: string): string {
  return minus(record?.syncedUntil ?? connectedAt, OVERLAP_MINUTES);
}

/**
 * 保険の見回りで、一覧の 1 ページから読むチャットを選ぶ。一覧は最後のメッセージの新しい順なので、最後のメッセージが
 * 一覧の重なりより古いチャットに当たったら、そこから先は読まなくてよい（done）。
 * 読むのは、最後のメッセージがそのチャットの位置（から重なりを引いた時刻）より新しいもの
 */
export function planChatsPage(
  page: readonly Chat[],
  listFloor: string,
  records: Readonly<Record<string, TeamsChatRecord>>,
  connectedAt: string,
  now: string,
): { read: Chat[]; done: boolean } {
  const read: Chat[] = [];
  for (const chat of page) {
    const last = chat.lastMessagePreview?.createdDateTime;
    if (!last || last < listFloor) return { read, done: true };
    const record = records[chat.id];
    // 取り込まないチャットは、種類を読み直す時期までは読まない
    if (record?.kind === 'skip' && !needsCheck(record, now)) continue;
    if (last >= chatFloor(record, connectedAt)) read.push(chat);
  }
  return { read, done: page.length === 0 };
}

/** 取り込むメッセージ（古い順）。つなぐ前に作られたものは除く */
export function planMessages(page: readonly TeamsMessage[], connectedAt: string): TeamsMessage[] {
  return page.filter((m) => m.createdDateTime >= connectedAt).sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
}
