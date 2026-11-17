import type { ReadScope } from '../../ports/gateway';

// 本体が Google Chat に対して呼べる口（0045 の決定 5、0023 の決定 4）。読み取り（GET）だけで、投稿の口はない
// （エージェントが投稿するのはゲートウェイの chat のサービスを直接使うスキルの側）。組み立て時にゲートウェイの口の実装に渡し、
// ここにない呼び出しは送る前に断る（照合はパスだけ。ベースはサービスの https://chat.googleapis.com）。
// スペースの名前は spaces/<ID>（ID は英数字・_・-）。ID はそのまま組み立て、/ を含む値は口が断る

const SPACE = 'spaces\\/[A-Za-z0-9_-]+';

/**
 * スペースの共有リスト（0045 の決定 1）: つなぐときのスペースの一覧と 1 つの取得、スペースのメンバーとメッセージの一覧だけ。
 * DM の個人リストとは種類（UpstreamKind）を分ける。ただ、スペースも DM も spaces/<ID> で、照合はパスだけなので、口では区別が付かない。
 * コネクタはデータソースのスペースと、SPACE に絞った一覧で得たスペースだけを呼ぶ（0044 の決定 6・0042 の決定 6 と同じ割り切り）
 */
export const GOOGLE_CHAT_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/v1\/spaces$/],
  ['GET', new RegExp(`^\\/v1\\/${SPACE}$`)],
  ['GET', new RegExp(`^\\/v1\\/${SPACE}\\/members$`)],
  ['GET', new RegExp(`^\\/v1\\/${SPACE}\\/messages$`)],
] as const);

/** 本人の DM・グループの個人リスト（0045 の決定 2）: 本人のスペースの一覧、DM・グループのメンバーとメッセージの一覧だけ */
export const GOOGLE_CHAT_DM_SCOPE: ReadScope = Object.freeze([
  ['GET', /^\/v1\/spaces$/],
  ['GET', new RegExp(`^\\/v1\\/${SPACE}\\/members$`)],
  ['GET', new RegExp(`^\\/v1\\/${SPACE}\\/messages$`)],
] as const);
