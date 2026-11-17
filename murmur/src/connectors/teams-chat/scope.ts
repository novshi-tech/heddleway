import type { ReadScope } from '../../ports/gateway';

/**
 * 本体が Teams のチャット（Graph）に対して呼べる口（0044 の決定 6）。読み取りは本人の表示名、本人が参加しているチャットの一覧、
 * チャット 1 つ・そのメンバー・メッセージだけ。書き込み系はサブスクリプションの作成・延長・削除だけで、投稿の口はない。
 * チャネルの口（TEAMS_SCOPE）とは別に持ち、チャネルの共有リストの経路からチャットを読めないようにする
 */
export const TEAMS_CHAT_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/v1\.0\/me$/],
  ['GET', /^\/v1\.0\/me\/chats$/],
  ['GET', /^\/v1\.0\/chats\/[^/]+$/],
  ['GET', /^\/v1\.0\/chats\/[^/]+\/members$/],
  ['GET', /^\/v1\.0\/chats\/[^/]+\/messages$/],
  ['POST', /^\/v1\.0\/subscriptions$/],
  ['PATCH', /^\/v1\.0\/subscriptions\/[^/?]+$/],
  ['DELETE', /^\/v1\.0\/subscriptions\/[^/?]+$/],
] as const);
