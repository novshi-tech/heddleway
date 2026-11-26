import type { ReadScope } from '../../ports/gateway';

/**
 * 本体が Teams（Graph）に対して呼べる口（0036 の決定 6、0023 の決定 4）。読み取りはつなぐときの一覧と、
 * チャネルのメッセージ・返信・メンバーだけ。書き込み系はサブスクリプションの作成・延長・削除だけで、投稿・返信の口はない。
 * 組み立て時にゲートウェイの口の実装に渡し、ここにない呼び出しは送る前に断る（照合はパスだけ）
 */
export const TEAMS_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/v1\.0\/me\/joinedTeams$/],
  ['GET', /^\/v1\.0\/teams\/[^/]+\/channels$/],
  ['GET', /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages$/],
  ['GET', /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+\/replies$/],
  ['GET', /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/members$/],
  ['POST', /^\/v1\.0\/subscriptions$/],
  ['PATCH', /^\/v1\.0\/subscriptions\/[^/?]+$/],
  ['DELETE', /^\/v1\.0\/subscriptions\/[^/?]+$/],
] as const);
