import { canonicalJson } from '../domain';

// Claude 呼び出しの境界。Claude API の呼び出しは必ずこの層（記録・再生）を通す。

/** Claude を使うのは Ingest の 1 か所だけ（計画 v2 のアーキテクチャ） */
export type LlmPurpose = 'ingest_decision';

export interface LlmRequest {
  purpose: LlmPurpose;
  model: string;
  system: string;
  user: string;
  /** 構造化出力の JSON Schema。省略時はテキスト */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmClient {
  /** 構造化出力なら JSON 文字列、そうでなければ本文のテキストを返す */
  complete(req: LlmRequest): Promise<string>;
}

export class LlmRefusalError extends Error {}

/** fetch の形（Worker の fetch でもテストの偽物でもよい） */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicLlmOptions {
  apiKey: string;
  fetch?: HttpFetch;
  /** 429・5xx・通信の失敗を試し直す回数（SDK の既定と同じ 2） */
  maxRetries?: number;
  /** 試し直しの前に待つ（テストでは待たない） */
  sleep?: (ms: number) => Promise<void>;
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * 本物の Claude API（Messages API を fetch で直に呼ぶ。0023 の決定 7: 実行時の依存を足さない）。
 * ヘッダーと本文は、置き換える前の @anthropic-ai/sdk の beta.messages.create が送っていたものと同じ。
 * API の版も SDK が送っていた 2023-06-01 のまま（上げるときは記録を取り直す）。
 */
export class AnthropicLlm implements LlmClient {
  private readonly fetch: HttpFetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AnthropicLlmOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(req: LlmRequest): Promise<string> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      // 判断は軽い用途なので low。ポリシー判定で断られたときはサーバ側の既定のフォールバックに任せる
      output_config: {
        effort: 'low',
        ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
      },
      fallbacks: 'default',
    };
    const res = (await this.post(body)) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (res.stop_reason === 'refusal') throw new LlmRefusalError(`refused (${req.purpose})`);
    const text = (res.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text) throw new Error(`empty response (${req.purpose}, stop_reason=${res.stop_reason})`);
    return text;
  }

  private async post(body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.opts.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt, null));
          continue;
        }
        throw err;
      }
      if (res.ok) return res.json();
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      const detail = (await res.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null;
      throw new LlmApiError(res.status, detail?.error?.type ?? 'error', detail?.error?.message ?? res.statusText);
    }
  }
}

/** Claude API のエラー応答（試し直しても通らなかったもの） */
export class LlmApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(`claude api ${status} ${type}: ${message}`);
    this.name = 'LlmApiError';
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const s = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(s) && s >= 0 && s <= 60) return s * 1000;
  return Math.min(8000, 500 * 2 ** attempt);
}

export interface Recording {
  key: string;
  request: LlmRequest;
  response: string;
}

export interface RecordingStore {
  get(key: string): Promise<Recording | undefined>;
  put(rec: Recording): Promise<void>;
}

export async function recordingKey(req: LlmRequest): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(req));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export class RecordingMissingError extends Error {}

/**
 * 記録・再生モード。
 * - replay: 記録だけを返す。記録がなければ失敗（テストはこのモードのみ）
 * - record: 本物を呼んで記録する（既にあれば再利用）
 * - rerecord: 既存の記録を無視して呼び直す（モデルを変えたときの差分取り）
 */
export class RecordReplayLlm implements LlmClient {
  constructor(
    private readonly mode: 'replay' | 'record' | 'rerecord',
    private readonly store: RecordingStore,
    private readonly inner?: LlmClient,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const key = await recordingKey(req);
    if (this.mode !== 'rerecord') {
      const hit = await this.store.get(key);
      if (hit) return hit.response;
      if (this.mode === 'replay') throw new RecordingMissingError(`no recording for ${req.purpose} (${key})`);
    }
    if (!this.inner) throw new Error('record mode requires a live client');
    const response = await this.inner.complete(req);
    await this.store.put({ key, request: req, response });
    return response;
  }
}

export class MemoryRecordingStore implements RecordingStore {
  readonly recordings = new Map<string, Recording>();
  async get(key: string) {
    return this.recordings.get(key);
  }
  async put(rec: Recording) {
    this.recordings.set(rec.key, rec);
  }
}
