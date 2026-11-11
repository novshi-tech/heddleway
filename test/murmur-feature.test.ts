import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConsentRequired, UpstreamRefused } from "../murmur/src/ports/gateway";
import { GRAPH_SCOPE } from "../murmur/src/connectors/graph/scope";
import { JIRA_SCOPE } from "../murmur/src/connectors/jira/api";
import { GMAIL_SCOPE } from "../murmur/src/connectors/gmail/scope";
import { GTASKS_SCOPE } from "../murmur/src/connectors/gtasks/scope";
import { TEAMS_SCOPE } from "../murmur/src/connectors/teams/scope";
import { parsePollMinutes } from "../src/murmur-feature";
import { publicUrl } from "../src/config";
import { featurePort } from "../src/feature-port";
import { features } from "../src/features";
import { buildServer } from "../src/mcp";
import worker from "../src/index";
import { signToken } from "../src/tokens";
import { vaultFor } from "../src/vault";
import { upstream } from "./helpers";

// Murmur as a feature of this Worker (docs/adr/0005, Murmur's 0023 step 3).

const BASE = publicUrl(env);
const testEnv = env as unknown as Env & { TEST_MURMUR_DB: D1Database; TEST_MURMUR_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
// The deployment's config with Murmur turned on.
const on = { ...env, MURMUR_DB: testEnv.TEST_MURMUR_DB, ANTHROPIC_API_KEY: "test-key", MURMUR_WEBHOOK_SECRET: "test-webhook-secret" } as unknown as Env;

let bob: string, mallory: string;
beforeAll(() => applyD1Migrations(testEnv.TEST_MURMUR_DB, testEnv.TEST_MURMUR_MIGRATIONS));
beforeEach(() => {
  [bob, mallory] = [crypto.randomUUID(), crypto.randomUUID()];
});

async function call(target: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const request = new Request(`${BASE}${path}`, { redirect: "manual", ...init }) as Parameters<typeof worker.fetch>[0];
  const res = await worker.fetch(request, target, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function apiToken(userId: string, creds: Record<string, string>) {
  return (await signToken(env.SIGNING_KEY, BASE, "api", userId, { creds }, 60)).token;
}

async function sessionCookie(userId: string) {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: userId }, 60);
  return `__Host-gw-session=${token}`;
}

const origin = new URL(BASE).origin;

describe("Murmur off (no MURMUR_DB)", () => {
  it("adds no feature, no routes and no home section", async () => {
    expect(features(env)).toEqual([]);
    expect((await call(env, "/murmur/timeline.html")).status).toBe(404);
    expect((await call(env, "/features/murmur/consent?state=aaaaaaaaaaaaaaaaaaaa", { headers: { cookie: await sessionCookie(bob) } })).status).toBe(404);
    const home = await (await call(env, "/", { headers: { cookie: await sessionCookie(bob) } })).text();
    expect(home).not.toContain("このゲートウェイの機能");
  });
});

describe("Murmur on", () => {
  it("serves Murmur's API behind the token proxy, for a token that covers identity:murmur", async () => {
    const res = await call(on, "/api/murmur/me", { headers: { authorization: `Bearer ${await apiToken(bob, { murmur: "identity" })}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: bob } });

    // A token for other services does not reach Murmur, and Murmur checks the token itself too.
    expect((await call(on, "/api/murmur/me", { headers: { authorization: `Bearer ${await apiToken(bob, { board: "x" })}` } })).status).toBe(403);
    expect((await call(on, "/api/murmur/me")).status).toBe(401);
  });

  it("routes Murmur's public pages under /murmur, but not its API", async () => {
    expect((await call(on, "/murmur/api/me", { headers: { authorization: `Bearer ${await apiToken(bob, { murmur: "identity" })}` } })).status).toBe(404);
    // TIMELINE_TOKEN is not set: Murmur's operator pages answer 404 themselves.
    expect((await call(on, "/murmur/timeline.html")).status).toBe(404);
    // Graph's subscription validation reaches Murmur's webhook.
    const v = await call(on, "/murmur/webhooks/graph?validationToken=hello", { method: "POST" });
    expect(v.status).toBe(200);
    expect(await v.text()).toBe("hello");
  });

  it("asks the user to turn Murmur on at the gateway, and returns to Murmur with a code for that user", async () => {
    const token = await apiToken(bob, { murmur: "identity" });
    const asked = await call(on, "/api/murmur/connections/outlook", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    const body = (await asked.json()) as { status: string; authorize_url: string };
    expect(body.status).toBe("authorize");
    const consentUrl = new URL(body.authorize_url);
    expect(consentUrl.origin + consentUrl.pathname).toBe(`${BASE}/features/murmur/consent`);
    const state = consentUrl.searchParams.get("state")!;

    // Not signed in: sign in first, then come back here.
    const anon = await call(on, `/features/murmur/consent?state=${state}`);
    expect(anon.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/features/murmur/consent?state=${state}`)}`);

    const cookie = await sessionCookie(bob);
    expect(await (await call(on, `/features/murmur/consent?state=${state}`, { headers: { cookie } })).text()).toContain("トピック索引を有効にしますか");
    const allowed = await call(on, "/features/murmur/consent", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, decision: "allow" }),
    });
    expect(allowed.status).toBe(303);
    const back = new URL(allowed.headers.get("location")!, BASE);
    expect(back.pathname).toBe("/murmur/oauth/callback");
    expect(await vaultFor(env, bob).consented("murmur")).toBe(true);

    // Bob has no mail connection yet: Murmur says so, and keeps the consent.
    const callback = await call(on, back.pathname + back.search);
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("Microsoft Graph の接続がありません");
    expect(await vaultFor(env, bob).consented("murmur")).toBe(true);
  });

  it("does not accept another user's consent code", async () => {
    const port = featurePort(on, { feature: "murmur", kinds: { graph: { service: "board", scope: GRAPH_SCOPE }, jira: { service: "jira", scope: JIRA_SCOPE }, teams: { service: "board", scope: TEAMS_SCOPE }, gmail: { service: "gmail", scope: GMAIL_SCOPE }, gtasks: { service: "tasks", scope: GTASKS_SCOPE } } });
    await vaultFor(env, mallory).setConsent("murmur", true);
    const code = (await signToken(env.SIGNING_KEY, BASE, "consent", mallory, { feature: "murmur" }, 60)).token;
    expect(await port.consent.complete({ userId: bob, code, secret: "", kind: "graph" })).toBe("wrong_user");
  });

  it("lists identity:murmur once (the feature takes the name over the configured identity service) and issues tokens for it", async () => {
    const server = buildServer(on, { userId: bob, name: bob }, createExecutionContext());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const listed = text(await client.callTool({ name: "list_credentials", arguments: {} })) as { credentials: { id: string; label: string }[] };
    expect(listed.credentials.filter((c) => c.id === "identity:murmur")).toEqual([{ id: "identity:murmur", service: "murmur", label: "トピック索引(サインイン中のユーザー)" }]);
    const issued = text(await client.callTool({ name: "issue_token", arguments: { credential_ids: ["identity:murmur"] } })) as { token: string };
    expect((await call(on, "/api/murmur/me", { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(200);
    // The MCP tools reach the feature too, through the same check of the gateway token.
    const got = text(await client.callTool({ name: "api_get", arguments: { credential_id: "identity:murmur", path: "/me" } })) as { status: number; service: string };
    expect(got).toMatchObject({ status: 200, service: "murmur" });
  });

  it("can be turned off from the home page", async () => {
    await vaultFor(env, bob).setConsent("murmur", true);
    const cookie = await sessionCookie(bob);
    expect(await (await call(on, "/", { headers: { cookie } })).text()).toContain("このゲートウェイの機能");
    const res = await call(on, "/features/murmur/disable", { method: "POST", headers: { cookie, origin } });
    expect(res.headers.get("location")).toBe("/?disabled=1");
    expect(await vaultFor(env, bob).consented("murmur")).toBe(false);
  });
});

describe("the gateway's port for Murmur", () => {
  // `board` stands in for Graph here: an API key service, so no OAuth flow is needed.
  const port = () => featurePort(on, { feature: "murmur", kinds: { graph: { service: "board", scope: GRAPH_SCOPE }, jira: { service: "jira", scope: JIRA_SCOPE }, teams: { service: "board", scope: TEAMS_SCOPE }, gmail: { service: "gmail", scope: GMAIL_SCOPE }, gtasks: { service: "tasks", scope: GTASKS_SCOPE } } });

  async function addBoard(userId: string) {
    const result = await vaultFor(env, userId).add(await upstream("board"), { "x-api-key": "the-key", authorization: "board-token" });
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  it("needs the user's consent", async () => {
    const cred = await addBoard(bob);
    await expect(port().credentials(bob, "graph")).rejects.toBeInstanceOf(ConsentRequired);
    await expect(port().upstream(bob, cred.id, "graph")).rejects.toBeInstanceOf(ConsentRequired);
  });

  it("reads with the user's own credential and keeps it inside the gateway", async () => {
    const cred = await addBoard(bob);
    await vaultFor(env, bob).setConsent("murmur", true);
    expect(await port().credentials(bob, "graph")).toEqual([{ id: cred.id, service: "board", label: "board" }]);
    const read = await port().upstream(bob, cred.id, "graph");
    const res = await read("GET", "/v1.0/me?$select=id", { headers: { prefer: "x" } });
    const echoed = (await res.json()) as { method: string; url: string; headers: Record<string, string> };
    expect(echoed.method).toBe("GET");
    expect(echoed.url).toBe("https://api.the-board.jp/v1.0/me?$select=id");
    expect(echoed.headers["x-api-key"]).toBe("the-key");
    expect(echoed.headers.prefer).toBe("x");
  });

  it("matches the read scope on the path only, so Jira's searches with a query go through", async () => {
    const jiraCred = await vaultFor(env, bob).add(await upstream("board"), { "x-api-key": "k", authorization: "t" });
    if ("error" in jiraCred) throw new Error(jiraCred.error);
    await vaultFor(env, bob).setConsent("murmur", true);
    // `board` stands in for Jira here (the scope is Jira's).
    const p = featurePort(on, { feature: "murmur", kinds: { graph: { service: "board", scope: GRAPH_SCOPE }, jira: { service: "board", scope: JIRA_SCOPE }, teams: { service: "board", scope: TEAMS_SCOPE }, gmail: { service: "gmail", scope: GMAIL_SCOPE }, gtasks: { service: "tasks", scope: GTASKS_SCOPE } } });
    const read = await p.upstream(bob, jiraCred.id, "jira");
    const res = await read("GET", "/ex/jira/cloud-1/rest/api/3/search/jql?jql=project%20%3D%20SPW&fields=summary");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe("https://api.the-board.jp/ex/jira/cloud-1/rest/api/3/search/jql?jql=project%20%3D%20SPW&fields=summary");
    await expect(read("POST", "/ex/jira/cloud-1/rest/api/3/issue?x=1", { body: {} })).rejects.toBeInstanceOf(UpstreamRefused);
  });

  it("refuses calls outside the read scope before sending them", async () => {
    const cred = await addBoard(bob);
    await vaultFor(env, bob).setConsent("murmur", true);
    const read = await port().upstream(bob, cred.id, "graph");
    await expect(read("POST", "/v1.0/me/sendMail", { body: {} })).rejects.toBeInstanceOf(UpstreamRefused);
    await expect(read("DELETE", "/v1.0/me/messages/1")).rejects.toBeInstanceOf(UpstreamRefused);
  });

  it("reads Teams with the Graph credential through the narrower Teams scope (no mail)", async () => {
    const cred = await addBoard(bob);
    await vaultFor(env, bob).setConsent("murmur", true);
    const read = await port().upstream(bob, cred.id, "teams");
    expect((await read("GET", "/v1.0/teams/t1/channels/19:c@thread.skype/messages?$top=50&$expand=replies")).status).toBe(200);
    await expect(read("GET", "/v1.0/me/messages")).rejects.toBeInstanceOf(UpstreamRefused);
    await expect(read("POST", "/v1.0/teams/t1/channels/19:c@thread.skype/messages", { body: {} })).rejects.toBeInstanceOf(UpstreamRefused);
  });

  it("does not use another user's credential", async () => {
    const cred = await addBoard(mallory);
    await vaultFor(env, bob).setConsent("murmur", true);
    await expect(port().upstream(bob, cred.id, "graph")).rejects.toThrow(/unknown credential/);
  });

  it("tells Murmur who the gateway's admins are (ADMINS)", async () => {
    const p = featurePort({ ...on, ADMINS: `x,${bob}` } as unknown as Env, { feature: "murmur", kinds: { graph: { service: "board", scope: GRAPH_SCOPE }, jira: { service: "jira", scope: JIRA_SCOPE }, teams: { service: "board", scope: TEAMS_SCOPE }, gmail: { service: "gmail", scope: GMAIL_SCOPE }, gtasks: { service: "tasks", scope: GTASKS_SCOPE } } });
    expect(await p.isAdmin(bob)).toBe(true);
    expect(await p.isAdmin(mallory)).toBe(false);
  });

  it("authenticates only gateway tokens that cover identity:murmur", async () => {
    expect(await port().authenticate(await apiToken(bob, { murmur: "identity" }))).toBe(bob);
    expect(await port().authenticate(await apiToken(bob, { board: "x" }))).toBeNull();
    expect(await port().authenticate("not-a-token")).toBeNull();
  });
});

describe("MURMUR_TASKS_POLL_MINUTES", () => {
  it("reads a positive integer; unset or invalid means every tick", () => {
    expect(parsePollMinutes("15")).toBe(15);
    expect(parsePollMinutes(" 30 ")).toBe(30);
    for (const bad of [undefined, "", "0", "-5", "1.5", "abc", "10m", "1e3", "Infinity"]) expect(parsePollMinutes(bad), String(bad)).toBeUndefined();
  });
});
