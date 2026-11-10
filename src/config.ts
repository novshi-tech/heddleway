export interface HeaderField {
  name: string;
  label: string;
  prefix?: string;
}

export interface HeadersAuth {
  type: "headers";
  headers: HeaderField[];
}

// HTTP Basic authentication (RFC 7617): the user enters a user name and a password, and
// the gateway sends `Authorization: Basic base64(user:password)`. With `username`, the
// user name is fixed by the definition and the user enters only the password, e.g.
// `x-access-token` for a GitHub token, `x-token-auth` for a Bitbucket access token.
export interface BasicAuth {
  type: "basic";
  username?: string;
  // Labels of the input fields in the web UI.
  username_label?: string;
  password_label?: string;
}

// The client ID and secret come from OAUTH_<CLIENT>_CLIENT_ID / _CLIENT_SECRET, where
// <CLIENT> is `client` (one client can serve many services, e.g. "google"), or the
// service name when `client` is not set.
export interface OAuth2Auth {
  type: "oauth2";
  client?: string;
  authorization_url: string;
  token_url: string;
  scope?: string;
  // The authorization URL's parameter for `scope`; Slack takes a user token's scopes as `user_scope`.
  scope_param?: string;
  authorize_params?: Record<string, string>;
  // Whether a refresh sends `scope` again (Entra expects it). Off for upstreams that do not document it.
  refresh_scope?: boolean;
  // A property of the token response that holds the user's tokens when present, e.g. Slack's `authed_user`.
  token_key?: string;
  // How the token request authenticates the client: "post" (the default) puts the ID and secret in the
  // form body (client_secret_post); "basic" sends them as `Authorization: Basic` (client_secret_basic),
  // which X requires of confidential clients.
  client_auth?: ClientAuthMethod;
}

export type ClientAuthMethod = "post" | "basic";

// OAuth2 client credentials: the deployment, not a user, owns the access. The client
// comes from Registry (admin-registered) or OAUTH_<CLIENT>_CLIENT_ID / _CLIENT_SECRET as
// for oauth2. Only the Background entrypoint (Service Binding) can use such a service;
// users never see it.
export interface ClientCredentialsAuth {
  type: "client_credentials";
  client?: string;
  token_url: string;
  scope?: string;
  client_auth?: ClientAuthMethod;
}

// For an upstream that trusts the gateway's sign-in: no stored credential, the
// gateway signs the user's ID (EdDSA, IDENTITY_SIGNING_KEY) for this audience and
// sends it as `Authorization: Bearer`. Upstreams verify it with /.well-known/jwks.json.
export interface IdentityAuth {
  type: "identity";
  audience: string;
}

export interface ServiceConfig {
  // Shown in the web UI; defaults to the service name.
  display_name?: string;
  // Groups services in the web UI ("Google", "Microsoft", ...); others are listed last.
  provider?: string;
  base_url: string;
  // Name of a Service Binding to reach the upstream through instead of the public internet.
  binding?: string;
  auth: HeadersAuth | BasicAuth | OAuth2Auth | ClientCredentialsAuth | IdentityAuth;
}

export type Services = Record<string, ServiceConfig>;

const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PARAM_NAME = /^[a-z][a-z0-9_]*$/;
const BINDING_NAME = /^[A-Z][A-Z0-9_]*$/;
// RFC 7617: the user name cannot contain a colon; no control characters either.
const BASIC_USERNAME = /^[^:\x00-\x1f\x7f]+$/;

export function parseServices(raw: unknown): Services {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("SERVICES must be an object");
  const services: Services = {};
  for (const [name, config] of Object.entries(value as Record<string, ServiceConfig>)) {
    if (!SERVICE_NAME.test(name)) throw new Error(`invalid service name: ${name}`);
    requireHttps(name, "base_url", config.base_url);
    const auth = config.auth;
    if (auth?.type === "oauth2") {
      requireHttps(name, "authorization_url", auth.authorization_url);
      requireHttps(name, "token_url", auth.token_url);
      if (auth.client !== undefined && !SERVICE_NAME.test(auth.client)) throw new Error(`service ${name}: invalid client name`);
      for (const field of ["scope_param", "token_key"] as const) {
        if (auth[field] !== undefined && !PARAM_NAME.test(auth[field])) throw new Error(`service ${name}: invalid ${field}`);
      }
      requireClientAuth(name, auth.client_auth);
    } else if (auth?.type === "client_credentials") {
      requireHttps(name, "token_url", auth.token_url);
      if (auth.client !== undefined && !SERVICE_NAME.test(auth.client)) throw new Error(`service ${name}: invalid client name`);
      requireClientAuth(name, auth.client_auth);
    } else if (auth?.type === "basic") {
      if (auth.username !== undefined && !BASIC_USERNAME.test(auth.username)) throw new Error(`service ${name}: invalid basic username`);
    } else if (auth?.type === "identity") {
      if (typeof auth.audience !== "string" || !auth.audience) throw new Error(`service ${name}: identity needs an audience`);
    } else if (auth?.type !== "headers" || !Array.isArray(auth.headers) || auth.headers.length === 0) {
      throw new Error(`service ${name}: unsupported auth`);
    }
    if (config.binding !== undefined && !BINDING_NAME.test(config.binding)) throw new Error(`service ${name}: invalid binding name`);
    services[name] = {
      display_name: config.display_name || name,
      ...(config.provider ? { provider: config.provider } : {}),
      base_url: config.base_url.replace(/\/+$/, ""),
      ...(config.binding ? { binding: config.binding } : {}),
      auth: config.auth,
    };
  }
  return services;
}

function requireClientAuth(service: string, value: unknown): void {
  if (value !== undefined && value !== "post" && value !== "basic") throw new Error(`service ${service}: client_auth must be "post" or "basic"`);
}

function requireHttps(service: string, field: string, value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`service ${service}: ${field} must be https`);
  }
}

export function oauthClient(env: Env, service: string, client?: string): { id: string; secret: string } | null {
  const vars = env as unknown as Record<string, unknown>;
  const prefix = `OAUTH_${(client ?? service).toUpperCase().replace(/-/g, "_")}_CLIENT_`;
  // Trimmed: a value pasted into `wrangler secret put` can keep a trailing space or newline,
  // which the upstream then rejects as a wrong secret.
  const id = typeof vars[`${prefix}ID`] === "string" ? (vars[`${prefix}ID`] as string).trim() : "";
  const secret = typeof vars[`${prefix}SECRET`] === "string" ? (vars[`${prefix}SECRET`] as string).trim() : "";
  return id && secret ? { id, secret } : null;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function publicUrl(env: Env): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}

// The organization this deployment serves (ADR 0004: one deployment = one organization).
// Falls back to the host so that gateways connected side by side stay distinguishable.
export function organizationName(env: Env): string {
  return env.ORGANIZATION_NAME?.trim() || new URL(publicUrl(env)).host;
}
