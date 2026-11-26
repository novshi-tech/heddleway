import { env, SELF } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publicUrl } from "../src/config";
import { registryFor } from "../src/registry";
import { forgetRegistry, getUpstream } from "../src/services";
import { signToken } from "../src/tokens";
import { vaultFor } from "../src/vault";

const BASE = publicUrl(env);
const ADMIN = "admin-user";
const APP_CLIENT = { id: "topic-index-app-client", secret: "topic-index-app-secret" };

// What a Worker with `{ "binding": "GATEWAY", "entrypoint": "Background" }` sees. The host is ignored.
const background = (exports as unknown as { Background: Fetcher }).Background;
const call = (path: string, init?: RequestInit) => background.fetch(`https://gateway${path}`, init);

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

// Access tokens the fake sign-in issued for one scope.
async function issued(scope: string): Promise<number> {
  const stats = await fetch(`https://login.app.example/stats?scope=${encodeURIComponent(scope)}`);
  return ((await stats.json()) as { issued: number }).issued;
}

// Registers a client_credentials service the way the admin screen does, with a scope of its own.
async function addAppService(scopePrefix = "https://graph.microsoft.com/.default", client = APP_CLIENT) {
  const name = unique("app");
  const scope = `${scopePrefix} ${name}`;
  const config = {
    base_url: `https://${name}.example`,
    auth: { type: "client_credentials" as const, token_url: "https://login.app.example/token", scope },
  };
  await registryFor(env).put(name, config, client, ADMIN);
  forgetRegistry();
  return { name, scope };
}

type Echo = { url: string; method: string; body: string; headers: Record<string, string> };

describe("background entrypoint", () => {
  it("calls a client_credentials service with the gateway's own access token", async () => {
    const res = await call("/graph-app/v1.0/users/shared@example.com/messages/delta?$select=id", {
      method: "POST",
      headers: { authorization: "Bearer from-the-caller", cookie: "a=1", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const echoed = (await res.json()) as Echo;
    expect(echoed.url).toBe("https://graph.microsoft.com/v1.0/users/shared@example.com/messages/delta?$select=id");
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("{}");
    expect(echoed.headers.authorization).toMatch(/^Bearer app-token-\d+$/);
    expect(echoed.headers.cookie).toBeUndefined();
  });

  it("reuses the access token until it is about to expire, sharing one request between callers", async () => {
    const { name, scope } = await addAppService();
    const responses = await Promise.all([call(`/${name}/a`), call(`/${name}/b`)]);
    const later = await call(`/${name}/c`);
    const tokens = await Promise.all([...responses, later].map(async (r) => ((await r.json()) as Echo).headers.authorization));
    expect(new Set(tokens).size).toBe(1);
    expect(await issued(scope)).toBe(1);

    const short = await addAppService("short");
    await call(`/${short.name}/a`);
    await call(`/${short.name}/b`);
    expect(await issued(short.scope)).toBe(2);
  });

  it("reaches only client_credentials services", async () => {
    for (const service of ["gmail", "board", "topic-index", "no-such-service", ""]) {
      const res = await call(`/${service}/anything`);
      expect(res.status, service).toBe(404);
    }
  });

  it("says so when the gateway has no client or the upstream refuses it", async () => {
    const unclient = await call("/app-unclient/x");
    expect(unclient.status).toBe(502);
    expect(((await unclient.json()) as { error: string }).error).toContain("no client");

    const refused = await call(`/${(await addAppService(undefined, { id: APP_CLIENT.id, secret: "wrong" })).name}/x`);
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain("could not get an access token");
  });
});

describe("client_credentials services and users", () => {
  it("are not reachable through the user REST endpoint, even with a token naming them", async () => {
    const { token } = await signToken(env.SIGNING_KEY, BASE, "api", "user-1", { creds: { "graph-app": "anything" } }, 60);
    const res = await SELF.fetch(`${BASE}/api/graph-app/v1.0/users`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it("cannot be stored as a user's credential", async () => {
    const target = await getUpstream(env, "graph-app");
    expect(await vaultFor(env, "user-1").add(target!, {})).toEqual({ error: "graph-app is not connected by users" });
  });
});
