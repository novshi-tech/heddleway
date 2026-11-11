// Google の API のエラーの読み取り（Gmail と Google Tasks が共有する。0041）

/** Google のエラー本体（{ error: { code, message, status, errors: [{ reason }] } }） */
export interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  errors?: { reason?: string }[];
}

/** 上限（クォータ・レート）に当たった 403 は、同意の問題ではない（試し直せば通る） */
export function isQuota(e: GoogleErrorBody | undefined): boolean {
  if (!e) return false;
  return (
    e.status === 'RESOURCE_EXHAUSTED' ||
    (e.errors ?? []).some((x) => /ratelimit|limitexceeded|quota/i.test(x.reason ?? '')) ||
    /rate limit|quota/i.test(e.message ?? '')
  );
}
