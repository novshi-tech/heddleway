// Google の API のエラーの読み取り（Gmail と Google Tasks が共有する。0041）。
// 分類は構造化されたエラー（HTTP の状態・error.status・errors[].reason・details[].reason）だけで行い、メッセージの文面は見ない

/** Google のエラー本体（{ error: { code, message, status, errors: [{ reason, domain, message }], details: [{ reason }] } }） */
export interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  errors?: { reason?: string; domain?: string; message?: string }[];
  details?: { reason?: string }[];
}

/**
 * - quota: 上限（レート・クォータ）に当たった。同意の問題ではなく、試し直せば通る（データソースは ok のまま、次の見回りが試し直す）
 * - api_disabled: ゲートウェイの Google Cloud プロジェクトでその API が有効になっていない（デプロイの問題。本人の同意の問題ではない）
 * - other: それ以外（401 と 403 は従来どおり同意・資格情報の問題、そのほかは一時的な失敗）
 */
export type GoogleErrorClass = 'quota' | 'api_disabled' | 'other';

const QUOTA_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded', 'dailylimitexceeded', 'quotaexceeded']);
const API_DISABLED_REASONS = new Set(['accessnotconfigured', 'service_disabled']);

const reasonsOf = (e: GoogleErrorBody): string[] => [...(e.errors ?? []), ...(e.details ?? [])].map((x) => (x.reason ?? '').toLowerCase());

export function classifyGoogleError(httpStatus: number, e: GoogleErrorBody | undefined): GoogleErrorClass {
  if (httpStatus === 429) return 'quota';
  if (httpStatus !== 403 || !e) return 'other';
  const reasons = reasonsOf(e);
  if (e.status === 'RESOURCE_EXHAUSTED' || (e.errors ?? []).some((x) => QUOTA_REASONS.has((x.reason ?? '').toLowerCase()))) return 'quota';
  if (e.status === 'SERVICE_DISABLED' || reasons.some((r) => API_DISABLED_REASONS.has(r))) return 'api_disabled';
  return 'other';
}

/** Google の API がゲートウェイの Google Cloud プロジェクトで有効になっていない。本人の同意の問題ではないので GatewayAuthError にしない */
export class GoogleApiNotEnabled extends Error {
  constructor(readonly api: string) {
    super(`${api} がゲートウェイの Google Cloud プロジェクトで有効になっていない（管理者が Google Cloud コンソールで ${api} を有効にしてください。本人の接続の問題ではありません）`);
    this.name = 'GoogleApiNotEnabled';
  }
}
