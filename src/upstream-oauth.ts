import type { ClientAuthMethod, ClientCredentialsAuth, OAuth2Auth } from "./config";

export interface OAuthClient {
  id: string;
  secret: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  // Epoch milliseconds; absent when the upstream does not say.
  expires_at?: number;
}

export class UpstreamOAuthError extends Error {
  constructor(
    message: string,
    // The refresh token was rejected, so only reconnecting helps.
    readonly invalidGrant = false,
  ) {
    super(message);
  }
}

export function upstreamAuthorizationUrl(
  auth: OAuth2Auth,
  client: OAuthClient,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(auth.authorization_url);
  for (const [k, v] of Object.entries(auth.authorize_params ?? {})) url.searchParams.set(k, v);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scope) url.searchParams.set(auth.scope_param ?? "scope", auth.scope);
  return url.href;
}

// Codes meaning the refresh token is gone for good; Slack has its own.
const INVALID_GRANT = new Set(["invalid_grant", "invalid_refresh_token"]);

// RFC 6749 2.3.1: the ID and secret are form-urlencoded before they are joined and base64-encoded.
function basicClientAuthorization(client: OAuthClient): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  const pair = new TextEncoder().encode(`${encode(client.id)}:${encode(client.secret)}`);
  return `Basic ${btoa(String.fromCharCode(...pair))}`;
}

async function tokenRequest(
  auth: { token_url: string; token_key?: string; client_auth?: ClientAuthMethod },
  client: OAuthClient,
  grant: Record<string, string>,
): Promise<TokenSet> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  // With Basic, the secret stays out of the body; client_id stays in it, which X's examples send too.
  const form = new URLSearchParams({ ...grant, client_id: client.id });
  if (auth.client_auth === "basic") headers.authorization = basicClientAuthorization(client);
  else form.set("client_secret", client.secret);
  const res = await fetch(auth.token_url, { method: "POST", headers, body: form }).catch((error: unknown) => {
    throw new UpstreamOAuthError(`token request failed: ${error}`);
  });
  const response = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const nested = auth.token_key ? response[auth.token_key] : undefined;
  // Slack answers errors with 200 and `ok: false`; then only `error` is at the top level.
  const body =
    nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).access_token === "string"
      ? (nested as Record<string, unknown>)
      : response;
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : `status ${res.status}`;
    // The status and the upstream's explanation tell apart causes that share a code: freee, for
    // one, answers a wrong client secret with invalid_grant too, but with 401 rather than 400.
    const detail = typeof body.error === "string" ? `, status ${res.status}` : "";
    const description = typeof body.error_description === "string" ? ` (${body.error_description.slice(0, 300)})` : "";
    throw new UpstreamOAuthError(`token request failed: ${code}${detail}${description}`, INVALID_GRANT.has(String(body.error)));
  }
  const expiresIn = Number(body.expires_in);
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_at: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
  };
}

export function exchangeCode(
  auth: OAuth2Auth,
  client: OAuthClient,
  params: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(auth, client, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
}

// Upstreams that rotate refresh tokens return a new one; others keep the old one.
export async function refreshTokens(auth: OAuth2Auth, client: OAuthClient, current: TokenSet): Promise<TokenSet> {
  if (!current.refresh_token) throw new UpstreamOAuthError("no refresh token", true);
  const grant: Record<string, string> = { grant_type: "refresh_token", refresh_token: current.refresh_token };
  // Entra expects the scopes again on refresh.
  if (auth.scope && auth.refresh_scope !== false) grant.scope = auth.scope;
  const next = await tokenRequest(auth, client, grant);
  return { ...next, refresh_token: next.refresh_token ?? current.refresh_token };
}

// No refresh token: the caller asks again once the access token expires.
export function clientCredentialsToken(auth: ClientCredentialsAuth, client: OAuthClient): Promise<TokenSet> {
  const grant: Record<string, string> = { grant_type: "client_credentials" };
  if (auth.scope) grant.scope = auth.scope;
  return tokenRequest(auth, client, grant);
}
