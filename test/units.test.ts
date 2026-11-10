import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../src/catalog";
import { oauthClient, organizationName, parseServices, type OAuth2Auth } from "../src/config";
import { basicAuthorization } from "../src/vault";
import { decryptJson, encryptJson, importAesKey } from "../src/crypto";
import { admit, SignInError } from "../src/idp";
import { getServices } from "../src/services";
import { exchangeCode, refreshTokens, upstreamAuthorizationUrl, UpstreamOAuthError } from "../src/upstream-oauth";
import { signToken, verifyToken } from "../src/tokens";
import { html, Html } from "../src/web/html";
import { isAdmin } from "../src/web/session";

const SECRET = "unit-test-signing-key-unit-test-signing-key";
const ISSUER = "https://gw.example.com";

describe("tokens", () => {
  it("verifies a token of the same kind", async () => {
    const { token } = await signToken(SECRET, ISSUER, "api", "user-1", { creds: { board: "c1" } }, 60);
    const claims = await verifyToken<{ creds: Record<string, string> }>(SECRET, ISSUER, "api", token);
    expect(claims?.sub).toBe("user-1");
    expect(claims?.creds).toEqual({ board: "c1" });
  });

  it("rejects a token of another kind", async () => {
    const { token } = await signToken(SECRET, ISSUER, "session", "user-1", {}, 60);
    expect(await verifyToken(SECRET, ISSUER, "api", token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await signToken(SECRET, ISSUER, "api", "user-1", {}, -1);
    expect(await verifyToken(SECRET, ISSUER, "api", token)).toBeNull();
  });

  it("rejects a token signed with another key", async () => {
    const { token } = await signToken(`${SECRET}-other`, ISSUER, "api", "user-1", {}, 60);
    expect(await verifyToken(SECRET, ISSUER, "api", token)).toBeNull();
  });

  it("rejects a short signing key", async () => {
    await expect(signToken("short", ISSUER, "api", "user-1", {}, 60)).rejects.toThrow();
  });
});

describe("crypto", () => {
  it("round-trips and binds to the additional data", async () => {
    const key = await importAesKey(btoa("k".repeat(32)));
    const sealed = await encryptJson(key, { a: "secret" }, "vault:1");
    expect(sealed).not.toContain("secret");
    expect(await decryptJson(key, sealed, "vault:1")).toEqual({ a: "secret" });
    await expect(decryptJson(key, sealed, "vault:2")).rejects.toThrow();
  });
});

describe("parseServices", () => {
  const auth = { type: "headers", headers: [{ name: "x-api-key", label: "key" }] };

  it("accepts a valid service and trims the trailing slash", () => {
    expect(parseServices({ board: { base_url: "https://api.example.com/", auth } }).board.base_url).toBe("https://api.example.com");
  });

  it("accepts a JSON string", () => {
    expect(Object.keys(parseServices(JSON.stringify({ board: { base_url: "https://a.example", auth } })))).toEqual(["board"]);
  });

  it("rejects non-https upstreams", () => {
    expect(() => parseServices({ board: { base_url: "http://api.example.com", auth } })).toThrow();
  });

  it("requires https OAuth endpoints", () => {
    const oauth = { type: "oauth2", authorization_url: "https://a.example/authorize", token_url: "http://a.example/token" };
    expect(() => parseServices({ freee: { base_url: "https://api.example.com", auth: oauth } })).toThrow(/token_url/);
    const ok = parseServices({ freee: { base_url: "https://api.example.com", auth: { ...oauth, token_url: "https://a.example/token" } } });
    expect(ok.freee.auth.type).toBe("oauth2");
  });

  it("accepts client_auth post or basic only", () => {
    const oauth = { type: "oauth2", authorization_url: "https://a.example/authorize", token_url: "https://a.example/token" };
    const parsed = parseServices({ x: { base_url: "https://api.example.com", auth: { ...oauth, client_auth: "basic" } } });
    expect(parsed.x.auth).toMatchObject({ client_auth: "basic" });
    expect(() => parseServices({ x: { base_url: "https://api.example.com", auth: { ...oauth, client_auth: "jwt" } } })).toThrow(/client_auth/);
    const cc = { type: "client_credentials", token_url: "https://a.example/token", client_auth: "private_key_jwt" };
    expect(() => parseServices({ app: { base_url: "https://api.example.com", auth: cc } })).toThrow(/client_auth/);
  });

  it("rejects invalid names", () => {
    expect(() => parseServices({ "../x": { base_url: "https://api.example.com", auth } })).toThrow();
  });

  it("accepts identity upstreams with an audience and a Service Binding", () => {
    const parsed = parseServices({
      murmur: { base_url: "https://murmur.internal/api", binding: "MURMUR", auth: { type: "identity", audience: "murmur" } },
    });
    expect(parsed.murmur).toEqual({
      display_name: "murmur",
      base_url: "https://murmur.internal/api",
      binding: "MURMUR",
      auth: { type: "identity", audience: "murmur" },
    });
    expect(parseServices({ board: { base_url: "https://a.example", auth } }).board).not.toHaveProperty("binding");
  });

  it("accepts basic auth with or without a fixed user name, but not one with a colon", () => {
    const parsed = parseServices({
      git: { base_url: "https://git.example", auth: { type: "basic", username: "x-access-token" } },
      jira: { base_url: "https://jira.example", auth: { type: "basic" } },
    });
    expect(parsed.git.auth).toEqual({ type: "basic", username: "x-access-token" });
    expect(parsed.jira.auth).toEqual({ type: "basic" });
    expect(() => parseServices({ git: { base_url: "https://git.example", auth: { type: "basic", username: "a:b" } } })).toThrow(/basic username/);
    expect(() => parseServices({ git: { base_url: "https://git.example", auth: { type: "basic", username: "" } } })).toThrow(/basic username/);
  });

  it("rejects identity upstreams without an audience and invalid binding names", () => {
    expect(() => parseServices({ m: { base_url: "https://a.example", auth: { type: "identity" } } })).toThrow(/audience/);
    expect(() => parseServices({ m: { base_url: "https://a.example", binding: "lower", auth } })).toThrow(/binding/);
  });
});

describe("admit", () => {
  const entra = { IDP_TYPE: "entra", ALLOWED_TENANTS: "t1", ALLOWED_DOMAINS: "" } as unknown as Env;
  const google = { IDP_TYPE: "google", ALLOWED_TENANTS: "", ALLOWED_DOMAINS: "example.com" } as unknown as Env;

  it("uses tid and oid for Entra", () => {
    expect(admit(entra, { tid: "t1", oid: "o1", sub: "s", name: "Ada" })).toMatchObject({ id: "entra_t1_o1", name: "Ada" });
  });

  it("rejects other Entra tenants", () => {
    expect(() => admit(entra, { tid: "t2", oid: "o1" })).toThrow(SignInError);
  });

  it("requires a verified email in an allowed Google domain", () => {
    expect(admit(google, { sub: "g1", hd: "example.com", email_verified: true }).id).toBe("google_g1");
    expect(() => admit(google, { sub: "g1", hd: "other.com", email_verified: true })).toThrow(SignInError);
    expect(() => admit(google, { sub: "g1", email_verified: true })).toThrow(SignInError);
    expect(() => admit(google, { sub: "g1", hd: "example.com", email_verified: false })).toThrow(SignInError);
  });

  it("refuses Google without a domain allowlist", () => {
    expect(() => admit({ ...google, ALLOWED_DOMAINS: "" } as Env, { sub: "g1", hd: "x.com", email_verified: true })).toThrow(
      SignInError,
    );
  });
});

describe("html", () => {
  it("escapes interpolated strings but not nested html", () => {
    const inner = html`<b>${"<i>"}</b>`;
    expect(html`<p title="${`"q"`}">${inner}</p>`.value).toBe('<p title="&#34;q&#34;"><b>&#60;i&#62;</b></p>');
  });

  it("joins arrays and drops null, undefined and false", () => {
    expect(html`${["a", html`<br>`, "&"]}|${null}${undefined}${false}|${0}`.value).toBe("a\n<br>\n&#38;||0");
  });

  it("passes Html built on purpose through unchanged", () => {
    expect(html`${new Html("<style>a > b {}</style>")}`.value).toBe("<style>a > b {}</style>");
  });
});

describe("oauthClient", () => {
  const env = {
    OAUTH_GOOGLE_CLIENT_ID: "shared",
    OAUTH_GOOGLE_CLIENT_SECRET: "shared-secret",
    OAUTH_GMAIL_CLIENT_ID: "old",
    OAUTH_GMAIL_CLIENT_SECRET: "old-secret",
    OAUTH_MY_API_CLIENT_ID: "mine",
    OAUTH_MY_API_CLIENT_SECRET: "mine-secret",
  } as unknown as Env;

  it("reads the client the service names, ignoring per-service names", () => {
    expect(oauthClient(env, "gmail", "google")).toEqual({ id: "shared", secret: "shared-secret" });
    expect(oauthClient({ ...env, OAUTH_GOOGLE_CLIENT_SECRET: "" } as Env, "gmail", "google")).toBeNull();
  });

  it("trims what was pasted around the values", () => {
    expect(oauthClient({ OAUTH_FREEE_CLIENT_ID: " 123\n", OAUTH_FREEE_CLIENT_SECRET: "s3cret \r\n" } as unknown as Env, "freee")).toEqual({ id: "123", secret: "s3cret" });
    expect(oauthClient({ OAUTH_FREEE_CLIENT_ID: "123", OAUTH_FREEE_CLIENT_SECRET: " \n" } as unknown as Env, "freee")).toBeNull();
  });

  it("uses the service name when no client is named", () => {
    expect(oauthClient(env, "my-api")).toEqual({ id: "mine", secret: "mine-secret" });
    expect(oauthClient(env, "freee", "freee")).toBeNull();
  });
});

describe("token request errors", () => {
  const auth = { type: "oauth2" as const, authorization_url: "https://up.example/authorize", token_url: "https://up.example/token" };
  const client = { id: "id", secret: "secret" };

  it("keeps the upstream's error_description, so causes that share a code can be told apart", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "invalid_grant", error_description: "redirect_uri does not match" }, { status: 400 }),
    );
    try {
      const error = await refreshTokens(auth, client, { access_token: "a", refresh_token: "r" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamOAuthError);
      expect((error as UpstreamOAuthError).message).toBe("token request failed: invalid_grant, status 400 (redirect_uri does not match)");
      expect((error as UpstreamOAuthError).invalidGrant).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  it("names the status when the upstream gives no error", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      const error = await refreshTokens(auth, client, { access_token: "a", refresh_token: "r" }).catch((e: unknown) => e);
      expect((error as UpstreamOAuthError).message).toBe("token request failed: status 500");
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("Slack and Atlassian token conventions", () => {
  const client = { id: "id", secret: "secret" };
  const services = catalog({} as Env);
  const slack = services.slack.auth as OAuth2Auth;
  const jira = services.jira.auth as OAuth2Auth;
  const params = { redirectUri: "https://gw.example.com/connect/callback", state: "s", codeChallenge: "c" };

  it("asks Slack for a user token through user_scope, and Atlassian for its API audience", () => {
    const slackUrl = new URL(upstreamAuthorizationUrl(slack, client, params));
    expect(slackUrl.searchParams.get("user_scope")).toContain("channels:history");
    expect(slackUrl.searchParams.has("scope")).toBe(false);
    const jiraUrl = new URL(upstreamAuthorizationUrl(jira, client, params));
    expect(jiraUrl.searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(jiraUrl.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(jiraUrl.searchParams.get("prompt")).toBe("consent");
  });

  it("connects Confluence through the same Atlassian client as Jira, with its own scopes", () => {
    const confluence = services.confluence.auth as OAuth2Auth;
    expect(confluence.client).toBe(jira.client);
    const url = new URL(upstreamAuthorizationUrl(confluence, client, params));
    const scopes = url.searchParams.get("scope")?.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["read:page:confluence", "write:page:confluence", "offline_access"]));
    expect(scopes?.some((s) => s.includes("jira"))).toBe(false);
    // Granular only ("<action>:<resource>:confluence"), apart from the identity scopes.
    expect(scopes?.filter((s) => !["read:me", "offline_access"].includes(s)).every((s) => /^(read|write):[a-z-]+:confluence$/.test(s))).toBe(true);
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
  });

  it("reads Slack's user token from authed_user, not the bot token at the top level", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, access_token: "xoxb-bot", authed_user: { id: "U1", access_token: "xoxp-user", token_type: "user" } }),
    );
    try {
      const tokens = await exchangeCode(slack, client, { code: "c", verifier: "v", redirectUri: params.redirectUri });
      expect(tokens).toEqual({ access_token: "xoxp-user", refresh_token: undefined, expires_at: undefined });
    } finally {
      fetch.mockRestore();
    }
  });

  it("reads a rotated Slack token from the top level, without sending the scopes again", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, access_token: "xoxe.xoxp-next", refresh_token: "xoxe-1-next", expires_in: 43200, token_type: "user" }),
    );
    try {
      const tokens = await refreshTokens(slack, client, { access_token: "a", refresh_token: "xoxe-1-old" });
      expect(tokens).toMatchObject({ access_token: "xoxe.xoxp-next", refresh_token: "xoxe-1-next" });
      const body = new URLSearchParams(fetch.mock.calls[0][1]!.body as URLSearchParams);
      expect(body.has("scope")).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });

  it("asks to reconnect when Slack refuses the refresh token, though it answers 200", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false, error: "invalid_refresh_token" }));
    try {
      const error = await refreshTokens(slack, client, { access_token: "a", refresh_token: "r" }).catch((e: unknown) => e);
      expect((error as UpstreamOAuthError).message).toBe("token request failed: invalid_refresh_token, status 200");
      expect((error as UpstreamOAuthError).invalidGrant).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("X token conventions", () => {
  const x = catalog({} as Env).x.auth as OAuth2Auth;
  const params = { redirectUri: "https://gw.example.com/connect/callback", state: "s", codeChallenge: "c" };

  it("asks X for a refresh token through offline.access", () => {
    const url = new URL(upstreamAuthorizationUrl(x, { id: "id", secret: "secret" }, params));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["tweet.read", "tweet.write", "users.read", "list.read", "list.write", "offline.access"]));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sends the client as Basic, keeping the secret out of the body", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ token_type: "bearer", access_token: "a1", refresh_token: "r1", expires_in: 7200, scope: "tweet.read" }));
    try {
      // RFC 6749 2.3.1: each part is form-urlencoded before base64.
      const client = { id: "client id", secret: "s:e/c" };
      const tokens = await exchangeCode(x, client, { code: "c", verifier: "v", redirectUri: params.redirectUri });
      expect(tokens).toMatchObject({ access_token: "a1", refresh_token: "r1" });
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe("https://api.x.com/2/oauth2/token");
      expect((init!.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("client+id:s%3Ae%2Fc")}`);
      const body = new URLSearchParams(init!.body as URLSearchParams);
      expect(body.get("client_id")).toBe("client id");
      expect(body.has("client_secret")).toBe(false);
      expect(body.get("code_verifier")).toBe("v");

      await refreshTokens(x, client, { access_token: "a1", refresh_token: "r1" });
      const refresh = fetch.mock.calls[1][1]!;
      expect((refresh.headers as Record<string, string>).authorization).toMatch(/^Basic /);
      const refreshBody = new URLSearchParams(refresh.body as URLSearchParams);
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.has("scope")).toBe(false);
      expect(refreshBody.has("client_secret")).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });

  it("still puts the secret in the body by default", async () => {
    const freee = catalog({} as Env).freee.auth as OAuth2Auth;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "a" }));
    try {
      await exchangeCode(freee, { id: "id", secret: "secret" }, { code: "c", verifier: "v", redirectUri: params.redirectUri });
      const init = fetch.mock.calls[0][1]!;
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      expect(new URLSearchParams(init.body as URLSearchParams).get("client_secret")).toBe("secret");
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("organizationName", () => {
  it("uses the configured name, or the public host when none is set", () => {
    expect(organizationName({ ORGANIZATION_NAME: " Acme ", PUBLIC_URL: "https://gw.example.com/" } as unknown as Env)).toBe("Acme");
    expect(organizationName({ ORGANIZATION_NAME: "", PUBLIC_URL: "https://gw.example.com/" } as unknown as Env)).toBe("gw.example.com");
  });
});

describe("catalog", () => {
  it("offers Graph only with a tenant, and puts the tenant in its sign-in URLs", () => {
    expect(catalog({} as Env)).not.toHaveProperty("graph");
    const graph = catalog({ MICROSOFT_TENANT_ID: "t-1" } as unknown as Env).graph;
    expect(graph.auth).toMatchObject({
      client: "microsoft",
      authorization_url: "https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize",
      token_url: "https://login.microsoftonline.com/t-1/oauth2/v2.0/token",
    });
  });

  it("passes the same checks as SERVICES", () => {
    expect(() => parseServices(catalog({ MICROSOFT_TENANT_ID: "t-1" } as unknown as Env))).not.toThrow();
  });

  it("lets SERVICES add services and replace a built-in one by name", async () => {
    const auth = { type: "headers", headers: [{ name: "x-key", label: "key" }] };
    const services = await getServices({
      ...env,
      SERVICES: { board: { base_url: "https://board.example", auth }, mine: { base_url: "https://mine.example", auth } },
    } as unknown as Env);
    expect(services.board.base_url).toBe("https://board.example");
    expect(services.mine.display_name).toBe("mine");
    expect(services.gmail.provider).toBe("Google");
  });

  it("rejects a scope parameter or token key that is not a plain name", () => {
    const auth = { type: "oauth2", authorization_url: "https://a.example", token_url: "https://a.example", scope_param: "a&b" };
    expect(() => parseServices({ x: { base_url: "https://a.example", auth } })).toThrow("invalid scope_param");
  });

  it("rejects an OAuth client name that cannot be a secret name", () => {
    const auth = { type: "oauth2", client: "Bad Name", authorization_url: "https://a.example", token_url: "https://a.example" };
    expect(() => parseServices({ x: { base_url: "https://a.example", auth } })).toThrow("invalid client name");
  });
});

describe("isAdmin", () => {
  it("matches user IDs listed in ADMINS", () => {
    const env = { ADMINS: "entra_t_a, google_b" } as unknown as Env;
    expect(isAdmin(env, { sub: "google_b", name: "B" })).toBe(true);
    expect(isAdmin(env, { sub: "entra_t_c", name: "C" })).toBe(false);
    expect(isAdmin({ ADMINS: "" } as unknown as Env, { sub: "", name: "" })).toBe(false);
  });
});

describe("basicAuthorization", () => {
  it("encodes the user name and password as RFC 7617 with UTF-8", () => {
    expect(basicAuthorization("x-access-token", "ghp_abc123")).toBe(`Basic ${btoa("x-access-token:ghp_abc123")}`);
    expect(basicAuthorization("é", "p")).toBe("Basic w6k6cA==");
  });
});
