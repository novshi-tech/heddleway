import type { ReadScope } from '../../ports/gateway';

/**
 * 本体が Gmail に対して呼べる口（0041 の決定 4、0023 の決定 4）。読み取りだけで、本人の箱（users/me）の下の
 * プロフィール・履歴・メッセージ・送信元の別名（settings/sendAs）に限る（ラベルの一覧は読まない。ラベルの ID はメッセージの labelIds で足りる）。書き込み系（POST・PUT・PATCH・DELETE）は 1 つもない。
 * 送信・下書き・ラベルの変更・削除・watch（Pub/Sub は使わない）の口はない。
 * 組み立て時にゲートウェイの口の実装に渡し、ここにない呼び出しは送る前に断る（照合はパスだけ。messages/ の直下の動詞（send・import・insert・batchDelete・batchModify）はメッセージの ID として読ませない。ベースはサービスの https://gmail.googleapis.com）
 */
export const GMAIL_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/gmail\/v1\/users\/me\/profile$/],
  ['GET', /^\/gmail\/v1\/users\/me\/history$/],
  ['GET', /^\/gmail\/v1\/users\/me\/messages$/],
  ['GET', /^\/gmail\/v1\/users\/me\/messages\/(?!(?:send|import|insert|batchDelete|batchModify)$)[^/?]+$/],
  ['GET', /^\/gmail\/v1\/users\/me\/settings\/sendAs$/],
] as const);
