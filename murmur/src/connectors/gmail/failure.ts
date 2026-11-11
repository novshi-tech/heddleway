import { DomainError } from '../../domain';
import { LlmApiError, LlmRefusalError, RecordingMissingError } from '../../ingest/llm';
import { GatewayError, UpstreamRefused } from '../../ports/gateway';
import { ConcurrencyError } from '../../store/types';
import { GmailError } from './api';

// メッセージ 1 通の取り込みが失敗したときの分類（純関数。0041）。
// そのメッセージに固有の失敗だけが「飛ばす」に至ってよい。上限・障害・ゲートウェイや LLM の不調は、どれだけ続いても数えず、
// 見回りを止めて次の見回りで試し直す（障害のあいだにメールを失わない）

/**
 * - skip: そのメッセージ固有で、やり直しても直らない。すぐ飛ばす
 * - count: 種類が分からない失敗。同じ ID が見回りをまたいで MAX_MESSAGE_FAILURES 回続いたら飛ばす
 * - transient: 一時的・基盤の失敗。数えず、見回りを止めて試し直す（いつまでも）
 */
export type FailureClass = 'skip' | 'count' | 'transient';

export function classifyMessageFailure(err: unknown): FailureClass {
  if (err instanceof DomainError) return 'skip';
  if (err instanceof GmailError) {
    // 401・403（クォータ含む）・408・429 と 5xx は、そのメッセージのせいではない
    if ([401, 403, 408, 429].includes(err.status) || err.status >= 500) return 'transient';
    if (err.status >= 400) return 'skip';
    return 'count';
  }
  // ゲートウェイ自身の失敗（上流トークンの更新失敗の 502 など）
  if (err instanceof GatewayError || err instanceof UpstreamRefused) return 'transient';
  // 取り込みの AI 判断の基盤（過負荷・障害・残高切れ・記録なし）。状態に関わらず一時的として扱う
  if (err instanceof LlmApiError || err instanceof RecordingMissingError) return 'transient';
  // AI が判断を拒んだのは、そのメッセージの中身による。障害ではないので数える（続けば飛ばし、後ろのメールを止めない）
  if (err instanceof LlmRefusalError) return 'count';
  // 保存の競合
  if (err instanceof ConcurrencyError) return 'transient';
  // ネットワーク（fetch の失敗は TypeError、時間切れは AbortError / TimeoutError）
  if (err instanceof TypeError) return 'transient';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'transient';
  return 'count';
}
