import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { configDefaults, defineConfig } from "vitest/config";
import { experimental_readRawConfig } from "wrangler";

const CONFIG = "./wrangler.example.jsonc";
// The built-in plugins the Worker bundles (src/plugins.ts imports dist/plugins.js).
execFileSync("python3", ["tools/build-plugin-zip.py", "--bundle"], { stdio: ["ignore", "ignore", "inherit"] });
// Services beyond the built-in catalog: the example's own, an OAuth service whose
// client is never configured, two that share a client set from the admin screen, and an upstream that trusts the gateway's sign-in.
const SERVICES = {
  ...(experimental_readRawConfig({ config: CONFIG }).rawConfig.vars?.SERVICES as object),
  unclient: {
    base_url: "https://api.unclient.example",
    auth: { type: "oauth2", authorization_url: "https://unclient.example/authorize", token_url: "https://unclient.example/token" },
  },
  // Two services sharing one client that only an admin sets, from the admin screen (test/admin.test.ts).
  "shared-a": {
    display_name: "Shared A",
    base_url: "https://api.shared.example",
    auth: { type: "oauth2", client: "shared-oauth", authorization_url: "https://shared.example/authorize", token_url: "https://shared.example/token" },
  },
  "shared-b": {
    display_name: "Shared B",
    base_url: "https://api.shared.example",
    auth: { type: "oauth2", client: "shared-oauth", authorization_url: "https://shared.example/authorize", token_url: "https://shared.example/token" },
  },
  // Reached only through the Background entrypoint, with a token from the fake app sign-in below.
  "graph-app": {
    display_name: "Microsoft Graph(アプリ)",
    base_url: "https://graph.microsoft.com",
    auth: { type: "client_credentials", client: "murmur-app", token_url: "https://login.app.example/token", scope: "https://graph.microsoft.com/.default" },
  },
  "app-unclient": {
    base_url: "https://api.app-unclient.example",
    auth: { type: "client_credentials", token_url: "https://login.app.example/token" },
  },
  // Basic authentication: one with a fixed user name, as for a git host's token, and one where the user enters it.
  "git-host": {
    display_name: "Git host",
    base_url: "https://git.example",
    auth: { type: "basic", username: "x-access-token", password_label: "Git host のトークン" },
  },
  "basic-free": {
    base_url: "https://basic.example",
    auth: { type: "basic", username_label: "メールアドレス" },
  },
  murmur: {
    display_name: "トピック索引",
    base_url: "https://murmur.example/api",
    auth: { type: "identity", audience: "murmur" },
  },
};

// Murmur's tables, for the tests that turn the Murmur feature on (test/murmur-feature.test.ts).
// The database is bound under another name, so the other tests run with Murmur off.
const MURMUR_MIGRATIONS = await readD1Migrations("murmur/drizzle");

const IDP = "https://idp.test";
const OIDC_ISSUER = `${IDP}/tenant/v2.0`;
const OIDC_CLIENT_ID = "test-client";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
// The gateway's own key for signing user identities to "identity" upstreams.
const identityKey = (await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })).privateKey;
const IDENTITY_SIGNING_KEY = JSON.stringify(await exportJWK(identityKey));

// A fake OpenID provider. The authorization code is base64url JSON of the
// claims the test wants in the ID token, so tests choose who signs in.
async function idp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/tenant/v2.0/.well-known/openid-configuration") {
    return Response.json({
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${IDP}/authorize`,
      token_endpoint: `${IDP}/token`,
      jwks_uri: `${IDP}/jwks`,
    });
  }
  if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
  if (url.pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    if (form.get("client_id") !== OIDC_CLIENT_ID || !form.get("code_verifier")) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const claims = JSON.parse(Buffer.from(form.get("code")!, "base64url").toString());
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(OIDC_ISSUER)
      .setAudience(OIDC_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return Response.json({ access_token: "idp-access", token_type: "Bearer", id_token: idToken });
  }
  return new Response("not found", { status: 404 });
}

const FREEE_ACCOUNTS = "https://accounts.secure.freee.co.jp";
const FREEE = { tokenPath: "/public_api/token", client: { id: "freee-client", secret: "freee-secret" } };
const ENTRA = "https://login.microsoftonline.com";
const GRAPH = {
  tokenPath: "/tenant-1/oauth2/v2.0/token",
  client: { id: "graph-client", secret: "graph-secret" },
  requireScope: true,
};
const GOOGLE_OAUTH = "https://oauth2.googleapis.com";
const DOCS = { tokenPath: "/token", client: { id: "docs-client", secret: "docs-secret" } };
const usedRefreshTokens = new Set<string>();
const refreshCalls = new Map<string, number>();

// A fake OAuth server for freee, Entra, and Google. The authorization code is base64url
// JSON of { challenge, tokens }: the token response to return once the PKCE
// check passes. Refresh tokens rotate; "revoked-*" is refused, "down-*" fails,
// and "short-*" yields an access token that is already expired. With
// `requireScope`, a refresh must send the scopes again, as Entra expects.
async function oauthServer(
  request: Request,
  server: { tokenPath: string; client: { id: string; secret: string }; requireScope?: boolean },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/stats") return Response.json({ calls: refreshCalls.get(url.searchParams.get("rt") ?? "") ?? 0 });
  if (url.pathname !== server.tokenPath || request.method !== "POST") return new Response("not found", { status: 404 });
  const form = new URLSearchParams(await request.text());
  if (form.get("client_id") !== server.client.id || form.get("client_secret") !== server.client.secret) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  if (form.get("grant_type") === "authorization_code") {
    const { challenge, tokens } = JSON.parse(Buffer.from(form.get("code")!, "base64url").toString());
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== challenge || !form.get("redirect_uri")) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json(tokens);
  }
  if (form.get("grant_type") === "refresh_token") {
    const rt = form.get("refresh_token") ?? "";
    refreshCalls.set(rt, (refreshCalls.get(rt) ?? 0) + 1);
    await sleep(50);
    if (server.requireScope && !form.get("scope")?.split(" ").includes("offline_access")) return Response.json({ error: "invalid_scope" }, { status: 400 });
    if (rt.startsWith("down-")) return new Response("unavailable", { status: 503 });
    if (rt.startsWith("revoked-") || usedRefreshTokens.has(rt)) return Response.json({ error: "invalid_grant" }, { status: 400 });
    usedRefreshTokens.add(rt);
    return Response.json({ access_token: `access-after-${rt}`, refresh_token: `next-${rt}`, expires_in: rt.startsWith("short-") ? 0 : 21600, token_type: "bearer" });
  }
  return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
}

const APP_LOGIN = "https://login.app.example";
const APP_CLIENT = { id: "murmur-app-client", secret: "murmur-app-secret" };
const appTokens = new Map<string, number>();

// A fake token endpoint for client credentials. Tokens are counted per scope, so tests can
// tell a reused token from a new one; a scope starting with "short" yields one that is already expired.
async function appLogin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/stats") return Response.json({ issued: appTokens.get(url.searchParams.get("scope") ?? "") ?? 0 });
  if (url.pathname !== "/token" || request.method !== "POST") return new Response("not found", { status: 404 });
  const form = new URLSearchParams(await request.text());
  if (form.get("client_id") !== APP_CLIENT.id || form.get("client_secret") !== APP_CLIENT.secret) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  if (form.get("grant_type") !== "client_credentials") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  await sleep(50);
  const scope = form.get("scope") ?? "";
  const n = (appTokens.get(scope) ?? 0) + 1;
  appTokens.set(scope, n);
  return Response.json({ access_token: `app-token-${n}`, token_type: "Bearer", expires_in: scope.startsWith("short") ? 0 : 3599 });
}

// Client metadata documents of apps (test/apps.test.ts, docs/adr/0008). The path names the
// document: /<variant>/<name>.json, where the variant changes the definition. /live/<name>.json
// serves the variant last set with POST /_set/<name>/<variant>, so one document can change.
const APPS = "https://apps.example";
const liveVariants = new Map<string, string>();
function appDocument(request: Request): Response {
  const url = new URL(request.url);
  const set = url.pathname.match(/^\/_set\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (set && request.method === "POST") {
    liveVariants.set(set[1], set[2]);
    return new Response(null, { status: 204 });
  }
  const m = url.pathname.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\.json$/);
  if (!m) return new Response("not found", { status: 404 });
  const name = m[2];
  const variant = m[1] === "live" ? (liveVariants.get(name) ?? "plain") : m[1];
  const ports: { service: string; method: string; path: string }[] = [{ service: "murmur", method: "GET", path: "^/threads$" }];
  if (variant === "wide") ports.push({ service: "murmur", method: "POST", path: "^/notes$" });
  const app: Record<string, unknown> = {
    name,
    description: "決まったリストを見張り、エージェントを起動します",
    ports: variant === "unanchored" ? [{ service: "murmur", method: "GET", path: "/threads" }] : ports,
    examples: {
      allow: ["GET murmur /threads?since=2026-11-01T00:00:00Z"],
      deny: variant === "wrong-example" ? ["GET murmur /threads"] : ["POST murmur /sent", "GET murmur /threads/thr_1"],
    },
  };
  return Response.json({
    client_id: `${APPS}${url.pathname}`,
    client_name: `App ${name}`,
    redirect_uris: ["https://client.test/callback"],
    token_endpoint_auth_method: "none",
    ...(variant === "missing" ? {} : { heddleway_app: app }),
  });
}

// Stands in for every upstream API: echoes the request it received.
async function upstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === IDP) return idp(request);
  if (url.origin === APPS) return appDocument(request);
  if (url.origin === FREEE_ACCOUNTS) return oauthServer(request, FREEE);
  if (url.origin === ENTRA) return oauthServer(request, GRAPH);
  if (url.origin === GOOGLE_OAUTH) return oauthServer(request, DOCS);
  if (url.origin === APP_LOGIN) return appLogin(request);
  if (url.pathname === "/redirect") {
    return new Response(null, { status: 302, headers: { location: "https://download.example.com/file" } });
  }
  if (url.pathname === "/binary") {
    return new Response(await request.arrayBuffer(), {
      headers: { "content-type": "application/octet-stream", "set-cookie": "upstream=1" },
    });
  }
  return Response.json(
    {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    },
    { headers: { "set-cookie": "upstream=1", "x-upstream": "yes" } },
  );
}

export default defineConfig({
  // murmur/ is its own package with its own tests (npm test in murmur/). See murmur/docs/adr/0023.
  test: { exclude: [...configDefaults.exclude, "murmur/**"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: CONFIG },
      miniflare: {
        d1Databases: ["TEST_MURMUR_DB"],
        bindings: {
          TEST_MURMUR_MIGRATIONS: MURMUR_MIGRATIONS,
          SERVICES,
          ORGANIZATION_NAME: "Acme",
          SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
          IDENTITY_SIGNING_KEY,
          ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          OIDC_CLIENT_SECRET: "test",
          OIDC_ISSUER,
          OIDC_CLIENT_ID,
          ALLOWED_TENANTS: "tenant-1",
          ADMINS: "admin-user",
          OAUTH_FREEE_CLIENT_ID: FREEE.client.id,
          OAUTH_FREEE_CLIENT_SECRET: FREEE.client.secret,
          MICROSOFT_TENANT_ID: "tenant-1",
          OAUTH_MICROSOFT_CLIENT_ID: GRAPH.client.id,
          OAUTH_MICROSOFT_CLIENT_SECRET: GRAPH.client.secret,
          OAUTH_GOOGLE_CLIENT_ID: DOCS.client.id,
          OAUTH_GOOGLE_CLIENT_SECRET: DOCS.client.secret,
          OAUTH_MURMUR_APP_CLIENT_ID: APP_CLIENT.id,
          OAUTH_MURMUR_APP_CLIENT_SECRET: APP_CLIENT.secret,
        },
        outboundService: upstream,
      },
    }),
  ],
});
