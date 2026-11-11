import type { ReadScope } from '../../ports/gateway';

/**
 * 本体が Google Tasks に対して呼べる口（0041 の決定 4、0023 の決定 4）。読み取りだけで、本人のタスクのリスト
 * （users/@me/lists）と、リストの下のタスク（lists/{id}/tasks）の一覧・取得に限る。
 * それに、つないだアカウントのメールアドレスを知るための userinfo（oauth2/v3/userinfo。Tasks の API にはプロフィールがない）。
 * 書き込み系（POST・PUT・PATCH・DELETE）は 1 つもない。タスクの作成・完了はスタンドがゲートウェイ経由で行う。
 * 組み立て時にゲートウェイの口の実装に渡し、ここにない呼び出しは送る前に断る（照合はパスだけ。ベースはサービスの https://www.googleapis.com。
 * Tasks の API はこのホストでも /tasks/v1/ の下で配信される）
 */
export const GTASKS_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/tasks\/v1\/users\/@me\/lists$/],
  ['GET', /^\/tasks\/v1\/users\/@me\/lists\/[^/?]+$/],
  ['GET', /^\/tasks\/v1\/lists\/[^/?]+\/tasks$/],
  ['GET', /^\/tasks\/v1\/lists\/[^/?]+\/tasks\/[^/?]+$/],
  ['GET', /^\/oauth2\/v3\/userinfo$/],
] as const);
