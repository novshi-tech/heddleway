import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { publicUrl } from "../src/config";
import { s256 } from "../src/crypto";
import { signToken } from "../src/tokens";
import { vaultFor } from "../src/vault";
import { upstream } from "./helpers";

const BASE = publicUrl(env);
const REDIRECT_URI = "https://client.test/callback";

class CookieJar {
  private cookies = new Map<string, string>();

  store(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [name, ...value] = pair.split("=");
      this.cookies.set(name, value.join("="));
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function idpCode(claims: Record<string, unknown>): string {
  return btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function register(): Promise<string> {
  const registered = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  return ((await registered.json()) as { client_id: string }).client_id;
}

// Drives the whole MCP authorization flow: registration, consent, upstream
// sign-in through the fake IdP, callback, and token exchange.
async function authorize(claims: (nonce: string) => Record<string, unknown>, clientId?: string) {
  const client_id = clientId ?? (await register());

  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const authorizeUrl = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    state: "client-state",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
    scope: "gateway",
  })) {
    authorizeUrl.searchParams.set(k, v);
  }

  const jar = new CookieJar();
  const consent = await SELF.fetch(authorizeUrl);
  expect(consent.status).toBe(200);
  jar.store(consent);
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];

  const approved = await SELF.fetch(authorizeUrl, {
    method: "POST",
    headers: { cookie: jar.header() },
    body: new URLSearchParams({ handle, decision: "approve" }),
    redirect: "manual",
  });
  expect(approved.status).toBe(302);
  jar.store(approved);
  const toIdp = new URL(approved.headers.get("location")!);
  expect(toIdp.origin).toBe("https://idp.test");
  expect(toIdp.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`);

  const callback = await SELF.fetch(
    `${BASE}/oauth/callback?code=${idpCode(claims(toIdp.searchParams.get("nonce")!))}&state=${toIdp.searchParams.get("state")}`,
    { headers: { cookie: jar.header() }, redirect: "manual" },
  );
  expect(callback.status).toBe(302);
  const back = new URL(callback.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT_URI);
  expect(back.searchParams.get("state")).toBe("client-state");
  return { back, client_id, verifier };
}

async function exchange(code: string, client_id: string, verifier: string) {
  const res = await SELF.fetch(`${BASE}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function refresh(refresh_token: string, client_id: string) {
  const res = await SELF.fetch(`${BASE}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, resource: `${BASE}/mcp` }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function callTool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0].text);
}

describe("MCP authorization flow", () => {
  it("signs in through the IdP and serves MCP tools for that user", async () => {
    const oid = crypto.randomUUID();
    const { back, client_id, verifier } = await authorize((nonce) => ({ nonce, tid: "tenant-1", oid, name: "Ada" }));
    const token = await exchange(back.searchParams.get("code")!, client_id, verifier);
    expect(token.status).toBe(200);
    expect(token.body.refresh_token).toBeTruthy();

    const userId = `entra_tenant-1_${oid}`;
    const added = await vaultFor(env, userId).add(await upstream("board"), { "x-api-key": "k", authorization: "t" });
    const listed = await callTool(token.body.access_token, "list_credentials");
    expect(listed.credentials).toEqual([
      expect.objectContaining({ id: (added as { id: string }).id }),
      expect.objectContaining({ id: "identity:topic-index" }),
    ]);
  });

  // claude.ai, Cowork and Claude Desktop share one client ID and redirect URI, so
  // connecting in one of them must not cut off the others.
  it("keeps earlier grants when the same user connects the same client again", async () => {
    const oid = crypto.randomUUID();
    const claims = (nonce: string) => ({ nonce, tid: "tenant-1", oid, name: "Ada" });
    const first = await authorize(claims);
    const firstToken = await exchange(first.back.searchParams.get("code")!, first.client_id, first.verifier);

    const second = await authorize(claims, first.client_id);
    const secondToken = await exchange(second.back.searchParams.get("code")!, second.client_id, second.verifier);
    expect(secondToken.status).toBe(200);

    const refreshed = await refresh(firstToken.body.refresh_token, first.client_id);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
  });

  it("denies users from other tenants", async () => {
    const { back } = await authorize((nonce) => ({ nonce, tid: "tenant-2", oid: "o", name: "Eve" }));
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("denies a replayed IdP nonce", async () => {
    const { back } = await authorize(() => ({ nonce: "wrong", tid: "tenant-1", oid: "o", name: "Ada" }));
    expect(back.searchParams.get("error")).toBe("access_denied");
  });
});

describe("apps the user allowed", () => {
  async function asUser(userId: string, path: string, method = "GET") {
    const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: userId }, 60);
    return SELF.fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: `__Host-gw-session=${token}`, origin: new URL(BASE).origin },
      redirect: "manual",
    });
  }

  it("lists each grant on the home page and revokes it after asking", async () => {
    const oid = crypto.randomUUID();
    const userId = `entra_tenant-1_${oid}`;
    const { back, client_id, verifier } = await authorize((nonce) => ({ nonce, tid: "tenant-1", oid, name: "Ada" }));
    const token = await exchange(back.searchParams.get("code")!, client_id, verifier);

    const home = await (await asUser(userId, "/")).text();
    expect(home).toContain("アクセスを許可したアプリ");
    expect(home).toContain("Test");
    expect(home).toContain("client.test");
    const grantId = home.match(/href="\/grants\/([^/"]+)\/revoke"/)![1];

    // Someone else can neither see nor revoke it.
    expect((await asUser("someone-else", `/grants/${grantId}/revoke`)).headers.get("location")).toBe("/");
    await asUser("someone-else", `/grants/${grantId}/revoke`, "POST");
    expect((await refresh(token.body.refresh_token, client_id)).status).toBe(200);

    expect(await (await asUser(userId, `/grants/${grantId}/revoke`)).text()).toContain("「Test」のアクセスを取り消しますか?");
    const revoked = await asUser(userId, `/grants/${grantId}/revoke`, "POST");
    expect(revoked.headers.get("location")).toBe("/?revoked=1");
    expect((await refresh(token.body.refresh_token, client_id)).status).toBe(400);
    const mcp = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.body.access_token}` } });
    expect(mcp.status).toBe(401);
    expect(await (await asUser(userId, "/?revoked=1")).text()).toContain("アクセスを許可したアプリはありません");
  });

  it("refuses a cross-site revoke", async () => {
    const res = await SELF.fetch(`${BASE}/grants/abc/revoke`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
