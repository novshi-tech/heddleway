import { WorkerEntrypoint } from "cloudflare:workers";
import type { ClientCredentialsAuth } from "./config";
import { denied, forward, upstreamFetcher } from "./proxy";
import { getUpstream } from "./services";
import { clientCredentialsToken, UpstreamOAuthError, type OAuthClient } from "./upstream-oauth";

// Fetch this long before the upstream says the access token expires.
const RENEW_MARGIN_MS = 60 * 1000;

// Access tokens per service, token endpoint, client and scope, so a changed definition
// gets a new token. Kept only in this isolate's memory; nothing is stored.
const tokens = new Map<string, { accessToken: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();

async function accessToken(service: string, auth: ClientCredentialsAuth, client: OAuthClient): Promise<string> {
  const key = [service, auth.token_url, client.id, auth.scope ?? ""].join(" ");
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) return cached.accessToken;
  let request = pending.get(key);
  if (!request) {
    request = clientCredentialsToken(auth, client)
      .then((set) => {
        // An upstream that does not say when the token expires gets asked every time.
        if (set.expires_at !== undefined) tokens.set(key, { accessToken: set.access_token, expiresAt: set.expires_at });
        return set.access_token;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

// For Workers on the same Cloudflare account (the topic index) that work when no one is signed in.
// A named entrypoint is not routed from the internet: only a Service Binding with
// `"entrypoint": "Background"` reaches it, so arriving here proves the caller is a Worker
// on this account, and no shared secret is needed. Requests are `/<service>/<upstream path>`
// and reach only client_credentials services, never a user's credential: that would skip
// the user's consent.
export class Background extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const rest = pathname.slice(1);
    const slash = rest.indexOf("/");
    const service = slash === -1 ? rest : rest.slice(0, slash);
    const upstreamPath = slash === -1 ? "" : rest.slice(slash);

    const target = await getUpstream(this.env, service);
    const auth = target?.config.auth;
    if (!target || auth?.type !== "client_credentials") return denied(404, `unknown service: ${service}`);
    if (!target.client) return denied(502, `the gateway has no client for ${service}`);

    let token: string;
    try {
      token = await accessToken(service, auth, target.client);
    } catch (error) {
      if (!(error instanceof UpstreamOAuthError)) throw error;
      console.warn(JSON.stringify({ type: "client_credentials_failed", service, reason: error.message }));
      return denied(502, `could not get an access token for ${service}; try again later`);
    }
    return forward(request, target.config, upstreamFetcher(this.env, target.config), upstreamPath, { authorization: `Bearer ${token}` }, {
      caller: "background",
      service,
    });
  }
}
