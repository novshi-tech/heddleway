// Calling upstream APIs directly from MCP tools (docs/adr/0007). The tools build the same
// request a script would send to `/api/<service>/...`, with a gateway token of their own, and
// hand it to the proxy, so credentials, features and the audit log work as for REST. What
// comes back goes into the conversation, so only text is returned, cut to a size.

import { handleProxy } from "./proxy";
import { signToken } from "./tokens";

export type QueryValue = string | number | boolean | string[];

export interface ApiCall {
  // The app the call is made for, carried into the token so the proxy checks its ports.
  app?: string;
  method: string;
  service: string;
  credential: string;
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  maxChars: number;
}

export const DEFAULT_MAX_CHARS = 50_000;
export const MAX_MAX_CHARS = 100_000;

// The token only has to live while the proxy checks it, here and in a feature's port.
const CALL_TOKEN_TTL_SECONDS = 60;

// Response headers worth showing: what the body is, where a redirect goes, and paging and rate limits.
const SHOWN_HEADERS = ["content-type", "content-disposition", "content-length", "location", "link", "retry-after", "etag"];
const SHOWN_PREFIXES = ["x-ratelimit-", "ratelimit", "x-total", "x-next", "x-ms-"];

function isTextType(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "") return true;
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    ["application/json", "application/xml", "application/javascript", "application/x-www-form-urlencoded", "application/graphql", "application/x-ndjson"].includes(type)
  );
}

function shownHeaders(headers: Headers): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (SHOWN_HEADERS.includes(name) || SHOWN_PREFIXES.some((p) => name.startsWith(p))) shown[name] = value;
  }
  return shown;
}

export type ApiResult = { error: string } | { status: number; result: Record<string, unknown> };

export async function callApi(env: Env, ctx: ExecutionContext, base: string, userId: string, call: ApiCall): Promise<ApiResult> {
  if (!call.path.startsWith("/")) return { error: "path must start with /" };
  if (call.json !== undefined && call.text !== undefined) return { error: "pass json or text, not both" };

  const prefix = `/api/${call.service}`;
  let url: URL;
  try {
    url = new URL(`${base}${prefix}${call.path}`);
  } catch {
    return { error: `invalid path: ${call.path}` };
  }
  // `..` and its encodings are resolved by the URL parser; the result must stay under the service.
  if (url.origin !== new URL(base).origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) {
    return { error: `path leaves the service: ${call.path}` };
  }
  for (const [key, value] of Object.entries(call.query ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
  }

  const headers = new Headers(call.headers ?? {});
  headers.set("user-agent", "heddleway-mcp");
  let body: string | undefined;
  if (call.json !== undefined) {
    body = JSON.stringify(call.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (call.text !== undefined) {
    body = call.text;
    if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  }
  const { token } = await signToken(env.SIGNING_KEY, base, "api", userId, { creds: { [call.service]: call.credential }, ...(call.app ? { app: call.app } : {}) }, CALL_TOKEN_TTL_SECONDS);
  headers.set("authorization", `Bearer ${token}`);

  const response = await handleProxy(new Request(url, { method: call.method, headers, body }), env, ctx, "mcp");
  const result: Record<string, unknown> = {
    status: response.status,
    url: `${call.path.split("?")[0]}${url.search}`,
    headers: shownHeaders(response.headers),
  };

  const contentType = response.headers.get("content-type") ?? "";
  const binaryNote =
    "The body is not text, so it is not returned here. Download it with a script: issue_token, then gw_request.py with -o (heddleway skill).";
  if (!isTextType(contentType)) {
    await response.body?.cancel();
    result.body_omitted = binaryNote;
    return { status: response.status, result };
  }
  const bytes = await response.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    result.body_omitted = binaryNote;
    return { status: response.status, result };
  }

  let parsed: unknown = undefined;
  if (contentType.toLowerCase().includes("json") && text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not valid JSON after all: returned as text.
    }
  }
  // Compact JSON keeps more of the body within the limit.
  const serialized = parsed !== undefined ? JSON.stringify(parsed) : text;
  if (serialized.length > call.maxChars) {
    result.truncated = true;
    result.total_chars = serialized.length;
    result.note =
      `The body has ${serialized.length} characters; only the first ${call.maxChars} are returned. ` +
      "Narrow the request (fields, filters, a smaller page size), raise max_chars, or use a script for bulk data.";
    result.body = serialized.slice(0, call.maxChars);
  } else {
    result.body = parsed !== undefined ? parsed : text;
  }
  return { status: response.status, result };
}
