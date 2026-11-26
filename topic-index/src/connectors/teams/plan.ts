import type { SpaceMember } from '../../domain';
import { teamsAddress } from '../../domain';
import type { ChannelMember, ChannelMessage, ChannelReply } from './message';

// Teams の取り込みの計画（純関数。0036 の決定 6）。実行は sync.ts。

/** 一覧の並びは厳密ではない（数時間の逆転。S0）ので、前回の同期からこれだけ重ねて読む。二重は sourceRef の重複排除で落ちる */
export const OVERLAP_MINUTES = 24 * 60;
/** 通知を落としても、この間隔で走査する（保険） */
export const SAFETY_SYNC_MINUTES = 10;
/** 1 回の仕事で読むページ（50 件）の上限 */
export const MAX_PAGES_PER_JOB = 10;
/** 読者の同期の間隔 */
export const READERS_SYNC_MINUTES = 60;
/** サブスクリプションの台帳の「フォルダ」（Outlook と台帳を共有する） */
export const TEAMS_FOLDER = 'messages';

/** 投稿が最後に動いた時刻（返信の作成・編集を含む。返信では投稿の lastModifiedDateTime は動かない。S0） */
export function lastActivity(m: ChannelMessage): string {
  let at = m.lastModifiedDateTime ?? m.createdDateTime;
  for (const r of m.replies ?? []) {
    const t = r.lastModifiedDateTime ?? r.createdDateTime;
    if (t > at) at = t;
  }
  return at;
}

export interface PageOutcome {
  /** 取り込む候補（投稿と、その返信。古い順）。つなぐ前に作られたものは除く */
  items: { msg: ChannelMessage | ChannelReply; root: ChannelMessage }[];
  /** これより古いページは読まなくてよい（ページの投稿がどれも重なりより前に動いたきり） */
  done: boolean;
}

export function planPage(page: readonly ChannelMessage[], syncedUntil: string, connectedAt: string): PageOutcome {
  const floor = new Date(Date.parse(syncedUntil) - OVERLAP_MINUTES * 60_000).toISOString();
  const items: PageOutcome['items'] = [];
  for (const root of page) {
    if (lastActivity(root) < floor) continue;
    const all = [root, ...(root.replies ?? [])].filter((m) => m.createdDateTime >= connectedAt);
    all.sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime) || (a === root ? -1 : 0));
    for (const msg of all) items.push({ msg, root });
  }
  items.sort((a, b) => a.msg.createdDateTime.localeCompare(b.msg.createdDateTime));
  return { items, done: page.length === 0 || page.every((m) => lastActivity(m) < floor) };
}

/**
 * ゲートウェイの User ID（Entra でサインインしたとき entra_<tenant>_<oid>）。チャネルのメンバーの Entra の ID から、
 * 名乗りなしで対応が付く（0037 の決定 2: サインインと同じ IdP）
 */
export function entraUserId(tenantId: string, objectId: string): string {
  return `entra_${tenantId}_${objectId}`;
}

export function teamsMembers(members: readonly ChannelMember[]): SpaceMember[] {
  return members
    .filter((m): m is ChannelMember & { userId: string; tenantId: string } => !!m.userId && !!m.tenantId)
    .map((m) => ({ address: { channel: 'teams' as const, value: teamsAddress(m.tenantId, m.userId) }, userId: entraUserId(m.tenantId, m.userId) }));
}
