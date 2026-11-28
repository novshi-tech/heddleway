import { z } from 'zod';
import { GatewayAuthError, GatewayError, type UpstreamCall } from '../../ports/gateway';

// 受け口（業務システム）の LINE の原本を読む（ゲートウェイの GraphQL 経由。0049 の決定 2）。
// 呼べる口は LINE_SCOPE（scope.ts。GET の /graphql だけ）。クエリはこのファイルの固定の文字列だけで、送信の mutation は持たない

/** 受け口の会話の画面（トピックの詳細から開く。ADR 0055）。to は友だちの userId か、グループ・トークルームの ID */
export const LINE_TALK_PAGE = 'https://platform.bm-next.ai/line/';

export function lineTalkUrl(conversationId: string): string {
  return `${LINE_TALK_PAGE}${encodeURIComponent(conversationId)}`;
}

/** 1 ページの件数（受け口の上限は 500） */
export const LINE_PAGE_SIZE = 200;

export const LineEventDirection = z.enum(['INBOUND', 'OUTBOUND']);

/** 受け口の LineEvent のうち、取り込みに使う項目 */
export const LineEvent = z.object({
  id: z.string(),
  direction: LineEventDirection,
  type: z.string(),
  sourceType: z.string().nullish(),
  lineUserId: z.string().nullish(),
  groupId: z.string().nullish(),
  messageId: z.string().nullish(),
  messageType: z.string().nullish(),
  text: z.string().nullish(),
  quotedMessageId: z.string().nullish(),
  postbackData: z.string().nullish(),
  fileName: z.string().nullish(),
  /** 友だちの表示名（受け口が保存したもの。送信には付かない） */
  displayName: z.string().nullish(),
  occurredAt: z.string(),
});
export type LineEvent = z.infer<typeof LineEvent>;

const LineEventsPage = z.object({
  events: z.array(z.unknown()),
  endCursor: z.string().nullish(),
  hasMore: z.boolean(),
});

export const EVENT_FIELDS = 'id direction type sourceType lineUserId groupId messageId messageType text quotedMessageId postbackData fileName displayName occurredAt';

/** 読めるかの確かめ（0049 の決定 4）: 接続の組織と、メッセージを読む権限 */
export const PROBE_QUERY = 'query TopicIndexLineProbe { myOrganization { id name } lineEvents(first: 1) { hasMore } }';

/** 差分読み（0049 の決定 2）。after がなければ since（つないだ時刻）から */
export const EVENTS_QUERY = `query TopicIndexLineEvents($after: String, $since: DateTime, $first: Int) { lineEvents(after: $after, since: $since, first: $first) { events { ${EVENT_FIELDS} } endCursor hasMore } }`;

export interface LineOrganization {
  id: string;
  name: string;
}

export interface LineEventsResult {
  events: LineEvent[];
  endCursor: string | null;
  hasMore: boolean;
}

export interface LineApi {
  /** 接続の組織と、メッセージを読めるか。読めなければ（スコープがない・組織に入っていない）LineNotReadable */
  probe(): Promise<LineOrganization>;
  /** 保存の順のイベントの 1 ページ */
  events(opts: { after: string | null; since: string; first?: number }): Promise<LineEventsResult>;
}

/**
 * その接続ではメッセージを読めない（受け口のスコープがない・組織に入っていない・API キーが無効）。
 * 資格情報の問題の 1 つなので、取り込みでは broken にし、読者の確かめ直しでは読めない人として扱う
 */
export class LineNotReadable extends GatewayAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'LineNotReadable';
  }
}

const GraphQLResponse = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(z.object({ message: z.string().optional(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
});

/** 認可の失敗（HotChocolate の既定のコード）。読めないこととして扱う */
const AUTH_CODES = new Set(['AUTH_NOT_AUTHORIZED', 'AUTH_NOT_AUTHENTICATED', 'AUTH_NO_DEFAULT_POLICY', 'AUTH_POLICY_NOT_FOUND']);

export class GatewayLineApi implements LineApi {
  constructor(private readonly upstream: UpstreamCall) {}

  async probe(): Promise<LineOrganization> {
    const data = await this.query(PROBE_QUERY, {});
    const org = z.object({ id: z.string(), name: z.string() }).safeParse(data.myOrganization);
    if (!org.success) throw new GatewayError('bm-next: myOrganization の形が想定外', 502);
    return org.data;
  }

  async events(opts: { after: string | null; since: string; first?: number }): Promise<LineEventsResult> {
    const data = await this.query(EVENTS_QUERY, { after: opts.after, since: opts.after ? null : opts.since, first: opts.first ?? LINE_PAGE_SIZE });
    const page = LineEventsPage.safeParse(data.lineEvents);
    if (!page.success) throw new GatewayError('bm-next: lineEvents の形が想定外', 502);
    const events = page.data.events.map((raw) => LineEvent.safeParse(raw)).flatMap((e) => (e.success ? [e.data] : []));
    return { events, endCursor: page.data.endCursor ?? null, hasMore: page.data.hasMore };
  }

  private async query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ query, variables: JSON.stringify(variables) });
    // GET の GraphQL を CSRF の対策で断るサーバ向けに、プリフライトの印を付ける（HotChocolate の GraphQL-Preflight）
    const res = await this.upstream('GET', `/graphql?${q}`, { headers: { accept: 'application/json', 'graphql-preflight': '1' } });
    const json = (await res.json().catch(() => ({}))) as { error?: unknown };
    // ゲートウェイ自身のエラー（同意・接続の問題）は本文が { error: "..." }
    if (typeof json.error === 'string') {
      if (res.status === 401 || res.status === 403) throw new GatewayAuthError(json.error);
      throw new GatewayError(json.error, res.status);
    }
    if (res.status === 401 || res.status === 403) throw new LineNotReadable(`bm-next ${res.status}`);
    const body = GraphQLResponse.safeParse(json);
    if (!body.success) throw new GatewayError(`bm-next ${res.status}: GraphQL の応答でない`, res.status >= 400 ? res.status : 502);
    const errors = body.data.errors ?? [];
    const auth = errors.find((e) => e.extensions?.code && AUTH_CODES.has(e.extensions.code));
    if (auth) throw new LineNotReadable(`bm-next: ${auth.extensions?.code}`);
    if (errors.length > 0 || !body.data.data) throw new GatewayError(`bm-next: ${errors[0]?.message ?? 'no data'}`, res.status >= 400 ? res.status : 502);
    return body.data.data;
  }
}
