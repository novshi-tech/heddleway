import type { SourceState, SubscriptionRecord } from './state';

// サブスクリプションの一生の計画（純関数）。実行は sync.ts。

/** Outlook の message は最長 10,080 分。少し手前にする */
export const SUBSCRIPTION_MINUTES = 10_070;
/** 残りがこれを切ったら延ばす */
export const RENEW_BEFORE_HOURS = 48;
/** 通知を全部落としても、この間隔で delta を回す（保険） */
export const SAFETY_SYNC_MINUTES = 30;
/** broken を試し直す間隔 */
export const RETRY_MINUTES = 60;

export type SubscriptionAction =
  | { kind: 'create'; folder: string }
  | { kind: 'renew'; subscription: SubscriptionRecord }
  | { kind: 'delete'; subscription: SubscriptionRecord };

export type MaintenancePlan =
  | { kind: 'idle' }
  /** broken から試し直す（作り直してから取り直す） */
  | { kind: 'retry' }
  | { kind: 'maintain'; actions: SubscriptionAction[]; sync: boolean };

/**
 * notificationUrl を渡すと、それと違う通知先で作ったサブスクリプション（通知先を記録していない古いものも）は
 * 生きていないものとして消し、作り直す
 */
export function planMaintenance(
  source: SourceState,
  subs: readonly SubscriptionRecord[],
  folders: readonly string[],
  now: string,
  notificationUrl?: string,
): MaintenancePlan {
  if (source.status === 'disconnected') {
    return subs.length > 0 ? { kind: 'maintain', actions: subs.map((s) => ({ kind: 'delete', subscription: s })), sync: false } : { kind: 'idle' };
  }
  if (source.status === 'broken') {
    return !source.lastRetryAt || minutesBetween(source.lastRetryAt, now) >= RETRY_MINUTES ? { kind: 'retry' } : { kind: 'idle' };
  }
  const actions: SubscriptionAction[] = [];
  for (const folder of folders) {
    const mine = subs.filter((s) => s.folder === folder);
    const live = mine.find((s) => s.expiresAt > now && (notificationUrl === undefined || s.notificationUrl === notificationUrl));
    if (!live) actions.push({ kind: 'create', folder });
    else if (minutesBetween(now, live.expiresAt) < RENEW_BEFORE_HOURS * 60) actions.push({ kind: 'renew', subscription: live });
    // 期限切れや重複は消す（Graph の側はもう消えているか、消しても困らない）
    for (const s of mine) if (s !== live) actions.push({ kind: 'delete', subscription: s });
  }
  for (const s of subs) if (!folders.includes(s.folder)) actions.push({ kind: 'delete', subscription: s });
  const sync = source.status === 'setup' || !source.lastSyncAt || minutesBetween(source.lastSyncAt, now) >= SAFETY_SYNC_MINUTES;
  return actions.length === 0 && !sync ? { kind: 'idle' } : { kind: 'maintain', actions, sync };
}

export type LifecycleEvent = 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';

/** ライフサイクルの通知への応答。再認可は PATCH（延長を兼ねる）、消えたら作り直して取り直す、取りこぼしは取り直す */
export function planLifecycle(event: string, sub: SubscriptionRecord): { actions: SubscriptionAction[]; sync: boolean } {
  switch (event) {
    case 'reauthorizationRequired':
      return { actions: [{ kind: 'renew', subscription: sub }], sync: false };
    case 'subscriptionRemoved':
      return { actions: [{ kind: 'delete', subscription: sub }, { kind: 'create', folder: sub.folder }], sync: true };
    case 'missed':
      return { actions: [], sync: true };
    default:
      return { actions: [], sync: false };
  }
}

export function expiresAfter(now: string, minutes = SUBSCRIPTION_MINUTES): string {
  return new Date(Date.parse(now) + minutes * 60_000).toISOString();
}

function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}
