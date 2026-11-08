import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { handleProxy } from "../src/proxy";
import { publicUrl } from "../src/config";
import { buildServer } from "../src/mcp";
import { getUpstream } from "../src/services";
import { signToken, verifyToken } from "../src/tokens";
import { vaultFor } from "../src/vault";
import { upstream } from "./helpers";

const BASE = publicUrl(env);
const BOARD = { "x-api-key": "the-key", authorization: "board-token" };

// Durable Object storage persists across tests, so each test gets fresh users.
let alice: string, bob: string, carol: string, mallory: string;
beforeEach(() => {
  [alice, bob, carol, mallory] = Array.from({ length: 4 }, () => crypto.randomUUID());
});

async function addBoard(userId: string) {
  const result = await vaultFor(env, userId).add(await upstream("board"), BOARD);
  if ("error" in result) throw new Error(result.error);
  return result;
}

async function apiToken(userId: string, creds: Record<string, string>, ttl = 60) {
  return (await signToken(env.SIGNING_KEY, BASE, "api", userId, { creds }, ttl)).token;
}

describe("vault", () => {
  it("stores credentials per user and builds headers from the service config", async () => {
    const cred = await addBoard(alice);
    expect(await vaultFor(env, alice).list()).toEqual([expect.objectContaining({ id: cred.id, service: "board", label: "board" })]);
    expect(await vaultFor(env, bob).list()).toEqual([]);
    expect(await vaultFor(env, alice).headers(cred.id, await upstream("board"))).toEqual({ headers: { "x-api-key": "the-key", authorization: "Bearer board-token" } });
    expect(await vaultFor(env, bob).headers(cred.id, await upstream("board"))).toEqual({ error: "missing" });
    expect(await vaultFor(env, alice).headers(cred.id, await upstream("serper"))).toEqual({ error: "missing" });
  });

  it("rejects unknown services and missing fields", async () => {
    expect(await getUpstream(env, "nope")).toBeNull();
    expect(await getUpstream(env, "constructor")).toBeNull();
    expect(await vaultFor(env, alice).add(await upstream("board"), { "x-api-key": "k" })).toEqual({ error: "missing value for authorization" });
  });

  it("sends secrets only to the upstream they were entered for", async () => {
    const cred = await addBoard(alice);
    const board = await upstream("board");
    const samePlace = { ...board, config: { ...board.config, base_url: "https://api.the-board.jp/v2" } };
    expect(await vaultFor(env, alice).headers(cred.id, samePlace)).toHaveProperty("headers");

    const elsewhere = { ...board, config: { ...board.config, base_url: "https://evil.example" } };
    expect(await vaultFor(env, alice).headers(cred.id, elsewhere)).toEqual({ error: "reconnect" });
    expect(await vaultFor(env, alice).get(cred.id)).toMatchObject({ needsReconnect: true });
    // Moving the definition back does not undo it: the user re-enters the key.
    expect(await vaultFor(env, alice).headers(cred.id, board)).toEqual({ error: "reconnect" });
  });

  it("ties an OAuth credential to its token endpoint and client", async () => {
    const freee = await upstream("freee");
    const tokens = { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
    const first = await vaultFor(env, alice).addOAuth(freee, tokens);
    const second = await vaultFor(env, bob).addOAuth(freee, tokens);
    if ("error" in first || "error" in second) throw new Error("not stored");
    expect(await vaultFor(env, alice).headers(first.id, freee)).toEqual({ headers: { authorization: "Bearer a" } });
    const newClient = { ...freee, client: { id: "another-client", secret: "s" } };
    expect(await vaultFor(env, alice).headers(first.id, newClient)).toEqual({ error: "reconnect" });
    const auth = freee.config.auth as { token_url: string };
    const newTokenUrl = { ...freee, config: { ...freee.config, auth: { ...auth, token_url: "https://evil.example/token" } } };
    expect(await vaultFor(env, bob).headers(second.id, newTokenUrl as typeof freee)).toEqual({ error: "reconnect" });
  });

  it("keeps one credential per service for each user, but lets OAuth reconnect in place", async () => {
    const cred = await addBoard(alice);
    expect(cred.label).toBe("board");
    expect(await vaultFor(env, alice).add(await upstream("board"), BOARD)).toEqual({ error: "already connected" });
    expect(await addBoard(bob)).toHaveProperty("id");

    const freee = await upstream("freee");
    const tokens = { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
    const first = await vaultFor(env, alice).addOAuth(freee, tokens);
    if ("error" in first) throw new Error("not stored");
    expect(await vaultFor(env, alice).addOAuth(freee, tokens)).toEqual({ error: "already connected" });
    expect(await vaultFor(env, alice).addOAuth(freee, { ...tokens, access_token: "b" }, first.id)).toMatchObject({ id: first.id });
    expect((await vaultFor(env, alice).list()).map((c) => c.service)).toEqual(["board", "freee"]);
  });

  it("records the upstream of an older credential on first use", async () => {
    const cred = await addBoard(alice);
    const stub = vaultFor(env, alice);
    await runInDurableObject(stub, async (_, state) => {
      const stored = (await state.storage.get<Record<string, unknown>>(`cred:${cred.id}`))!;
      delete stored.target;
      await state.storage.put(`cred:${cred.id}`, stored);
    });
    expect(await stub.headers(cred.id, await upstream("board"))).toHaveProperty("headers");
    const target = await runInDurableObject(stub, async (_, state) => (await state.storage.get<{ target?: string }>(`cred:${cred.id}`))!.target);
    expect(target).toBe("https://api.the-board.jp");
  });

  it("builds Basic authorization from a fixed user name and the entered password", async () => {
    const cred = await vaultFor(env, alice).add(await upstream("git-host"), { password: " ghp_abc123 ", username: "ignored" });
    if ("error" in cred) throw new Error(cred.error);
    expect(await vaultFor(env, alice).headers(cred.id, await upstream("git-host"))).toEqual({
      headers: { authorization: `Basic ${btoa("x-access-token:ghp_abc123")}` },
    });
    expect(await vaultFor(env, bob).add(await upstream("git-host"), {})).toEqual({ error: "missing value for password" });
  });

  it("builds Basic authorization from an entered user name and password", async () => {
    expect(await vaultFor(env, alice).add(await upstream("basic-free"), { password: "p" })).toEqual({ error: "missing value for username" });
    const cred = await vaultFor(env, alice).add(await upstream("basic-free"), { username: "me@example.com", password: "p" });
    if ("error" in cred) throw new Error(cred.error);
    expect(await vaultFor(env, alice).headers(cred.id, await upstream("basic-free"))).toEqual({
      headers: { authorization: `Basic ${btoa("me@example.com:p")}` },
    });
  });

  it("removes credentials", async () => {
    const cred = await addBoard(alice);
    expect(await vaultFor(env, alice).remove(cred.id)).toBe(true);
    expect(await vaultFor(env, alice).list()).toEqual([]);
  });
});

describe("proxy", () => {
  it("sends the gBizINFO API token in its own header", async () => {
    const cred = await vaultFor(env, alice).add(await upstream("gbizinfo"), { "x-hojininfo-api-token": "gbiz-token" });
    expect("error" in cred).toBe(false);
    const id = (cred as { id: string }).id;
    const res = await SELF.fetch(`${BASE}/api/gbizinfo/hojin/v2/hojin?name=%E3%83%86%E3%82%B9%E3%83%88`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { gbizinfo: id })}` },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("https://api.info.gbiz.go.jp/hojin/v2/hojin?name=%E3%83%86%E3%82%B9%E3%83%88");
    expect(echoed.headers["x-hojininfo-api-token"]).toBe("gbiz-token");
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it("replaces the caller's gateway token with Basic authorization for git's smart HTTP", async () => {
    const cred = await vaultFor(env, alice).add(await upstream("git-host"), { password: "ghp_abc123" });
    if ("error" in cred) throw new Error(cred.error);
    const res = await SELF.fetch(`${BASE}/api/git-host/owner/repo.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { "git-host": cred.id })}`, "git-protocol": "version=2" },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("https://git.example/owner/repo.git/info/refs?service=git-upload-pack");
    expect(echoed.headers.authorization).toBe(`Basic ${btoa("x-access-token:ghp_abc123")}`);
    expect(echoed.headers["git-protocol"]).toBe("version=2");
  });

  it("sends the Serper API key in its own header", async () => {
    const cred = await vaultFor(env, alice).add(await upstream("serper"), { "x-api-key": "serper-key" });
    expect("error" in cred).toBe(false);
    const id = (cred as { id: string }).id;
    const res = await SELF.fetch(`${BASE}/api/serper/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${await apiToken(alice, { serper: id })}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "test", gl: "jp", hl: "ja" }),
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("https://google.serper.dev/search");
    expect(echoed.headers["x-api-key"]).toBe("serper-key");
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it("forwards to the upstream with injected credentials", async () => {
    const cred = await addBoard(alice);
    const res = await SELF.fetch(`${BASE}/api/board/v1/clients?page=2`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await apiToken(alice, { board: cred.id })}`,
        cookie: "session=secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream")).toBe("yes");
    const echoed = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe("POST");
    expect(echoed.url).toBe("https://api.the-board.jp/v1/clients?page=2");
    expect(echoed.headers["x-api-key"]).toBe("the-key");
    expect(echoed.headers.authorization).toBe("Bearer board-token");
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.body).toBe('{"name":"x"}');
  });

  it("passes binary bodies through untouched", async () => {
    const cred = await addBoard(alice);
    const bytes = new Uint8Array(256).map((_, i) => i);
    const res = await SELF.fetch(`${BASE}/api/board/binary`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await apiToken(alice, { board: cred.id })}` },
      body: bytes,
    });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("returns upstream redirects to the caller", async () => {
    const cred = await addBoard(alice);
    const res = await SELF.fetch(`${BASE}/api/board/redirect`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { board: cred.id })}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://download.example.com/file");
  });

  it("requires a valid gateway token", async () => {
    expect((await SELF.fetch(`${BASE}/api/board/v1/clients`)).status).toBe(401);
    const expired = await apiToken(alice, { board: "x" }, -1);
    const res = await SELF.fetch(`${BASE}/api/board/v1/clients`, { headers: { authorization: `Bearer ${expired}` } });
    expect(res.status).toBe(401);
  });

  it("refuses services the token does not cover", async () => {
    const res = await SELF.fetch(`${BASE}/api/board/v1/clients`, {
      headers: { authorization: `Bearer ${await apiToken(alice, {})}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses unknown services", async () => {
    const res = await SELF.fetch(`${BASE}/api/nope/x`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { nope: "x" })}` },
    });
    expect(res.status).toBe(404);
  });

  it("never uses another user's credential", async () => {
    const cred = await addBoard(alice);
    const res = await SELF.fetch(`${BASE}/api/board/v1/clients`, {
      headers: { authorization: `Bearer ${await apiToken(mallory, { board: cred.id })}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("identity upstreams", () => {
  async function verifyIdentity(token: string) {
    const keys = (await (await SELF.fetch(`${BASE}/.well-known/jwks.json`)).json()) as { keys: never[] };
    return jwtVerify(token, createLocalJWKSet(keys), { issuer: BASE, audience: "murmur", algorithms: ["EdDSA"] });
  }

  it("publishes only the public half of the identity key", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Record<string, string>[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(keys[0].kid).toBeTruthy();
    expect(keys[0].d).toBeUndefined();
  });

  it("replaces the caller's authorization with the user's signed identity", async () => {
    const res = await SELF.fetch(`${BASE}/api/murmur/tasks?filter=open`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { murmur: "identity" })}`, "x-murmur-identity": "forged" },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("https://murmur.example/api/tasks?filter=open");
    const token = echoed.headers.authorization.replace(/^Bearer /, "");
    const { payload, protectedHeader } = await verifyIdentity(token);
    expect(payload.sub).toBe(alice);
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(protectedHeader).toMatchObject({ alg: "EdDSA", typ: "JWT" });
  });

  it("refuses a token whose credential for the service is not the identity", async () => {
    const cred = await addBoard(alice);
    const res = await SELF.fetch(`${BASE}/api/murmur/tasks`, {
      headers: { authorization: `Bearer ${await apiToken(alice, { murmur: cred.id })}` },
    });
    expect(res.status).toBe(403);
    const none = await SELF.fetch(`${BASE}/api/murmur/tasks`, { headers: { authorization: `Bearer ${await apiToken(alice, {})}` } });
    expect(none.status).toBe(403);
  });

  it("reaches the upstream through its Service Binding when one is configured", async () => {
    const seen: Request[] = [];
    const bound = {
      ...env,
      SERVICES: { murmur: { base_url: "https://murmur.internal/api", binding: "MURMUR", auth: { type: "identity", audience: "murmur" } } },
      MURMUR: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push(new Request(input, init));
          return Response.json({ ok: true });
        },
      },
    } as unknown as Env;
    const res = await handleProxy(
      new Request(`${BASE}/api/murmur/me`, { headers: { authorization: `Bearer ${await apiToken(bob, { murmur: "identity" })}` } }),
      bound,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://murmur.internal/api/me");
    const { payload } = await verifyIdentity(seen[0].headers.get("authorization")!.replace(/^Bearer /, ""));
    expect(payload.sub).toBe(bob);
  });

  it("does not store credentials for identity services", async () => {
    expect(await vaultFor(env, alice).add(await upstream("murmur"), {})).toEqual({ error: "murmur needs no credential" });
  });
});

describe("mcp tools", () => {
  async function connect(userId: string) {
    const server = buildServer(env, { userId, name: userId }, createExecutionContext());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    return client;
  }

  function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as { type: string; text: string }[])[0].text;
  }

  it("lists the user's credentials", async () => {
    const cred = await addBoard(alice);
    const client = await connect(alice);
    const listed = JSON.parse(text(await client.callTool({ name: "list_credentials", arguments: {} })));
    // "unclient" has no OAuth client in the tests, so it is not offered.
    expect(listed.services).toEqual(["freee", "gmail", "drive", "calendar", "docs", "analytics", "analytics-admin", "board", "gbizinfo", "serper", "graph", "git-host", "basic-free", "murmur"]);
    expect(listed.credentials).toEqual([
      expect.objectContaining({ id: cred.id, service: "board" }),
      { id: "identity:murmur", service: "murmur", label: "トピック索引(サインイン中のユーザー)" },
    ]);
  });

  it("names the organization it serves, so connectors of several organizations can be told apart", async () => {
    const client = await connect(alice);
    expect(client.getServerVersion()?.title).toBe("Heddleway (Acme)");
    expect(client.getInstructions()).toContain(`API gateway of the organization "Acme" (sign-in: Microsoft Entra ID, ${BASE})`);
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.description).toContain(`"Acme"`);
    const gateway = { organization: "Acme", idp: "Microsoft Entra ID", url: BASE };
    expect(JSON.parse(text(await client.callTool({ name: "list_credentials", arguments: {} }))).gateway).toEqual(gateway);
    const issued = JSON.parse(text(await client.callTool({ name: "issue_token", arguments: { credential_ids: ["identity:murmur"] } })));
    expect(issued.gateway).toEqual(gateway);
  });

  it("issues a token that the proxy accepts", async () => {
    const cred = await addBoard(alice);
    const client = await connect(alice);
    const issued = JSON.parse(text(await client.callTool({ name: "issue_token", arguments: { credential_ids: [cred.id] } })));
    expect(issued.base_url).toBe(`${BASE}/api`);
    const claims = await verifyToken<{ creds: Record<string, string> }>(env.SIGNING_KEY, BASE, "api", issued.token);
    expect(claims).toMatchObject({ sub: alice, creds: { board: cred.id } });

    const res = await SELF.fetch(`${issued.services.board}/v1/clients`, { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(200);
  });

  it("marks every tool but api_request read-only so clients do not ask before each call", async () => {
    const client = await connect(alice);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["api_get", "api_request", "issue_token", "list_credentials"]);
    for (const tool of tools) {
      if (tool.name === "api_request") expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      else expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  describe("api calls", () => {
    type Echo = { method: string; url: string; headers: Record<string, string>; body: string };

    async function call(client: Client, name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, raw: text(result) };
    }

    it("GETs an upstream API with the user's credential", async () => {
      const cred = await addBoard(alice);
      const client = await connect(alice);
      const { isError, raw } = await call(client, "api_get", {
        credential_id: cred.id,
        path: "/v1/clients/日本",
        query: { page: 2, tag: ["a", "b"], q: "a b" },
        headers: { "x-extra": "1", authorization: "Bearer mine" },
      });
      expect(isError).toBe(false);
      const out = JSON.parse(raw);
      expect(out).toMatchObject({ service: "board", status: 200, gateway: { organization: "Acme" } });
      expect(out.headers["content-type"]).toContain("application/json");
      expect(out.headers["set-cookie"]).toBeUndefined();
      const echo = out.body as Echo;
      expect(echo.method).toBe("GET");
      expect(echo.url).toBe("https://api.the-board.jp/v1/clients/%E6%97%A5%E6%9C%AC?page=2&tag=a&tag=b&q=a+b");
      expect(echo.headers).toMatchObject({ "x-api-key": "the-key", authorization: "Bearer board-token", "x-extra": "1", "user-agent": "heddleway-mcp" });
    });

    it("sends a JSON or text body with api_request", async () => {
      const cred = await addBoard(alice);
      const client = await connect(alice);
      const posted = JSON.parse((await call(client, "api_request", { method: "POST", credential_id: cred.id, path: "/v1/projects", json: { name: "案件" } })).raw);
      expect(posted.body).toMatchObject({ method: "POST", body: JSON.stringify({ name: "案件" }), headers: { "content-type": "application/json" } });

      const patched = JSON.parse(
        (await call(client, "api_request", { method: "PATCH", credential_id: cred.id, path: "/v1/x", text: "<a/>", headers: { "content-type": "application/xml" } })).raw,
      );
      expect(patched.body).toMatchObject({ method: "PATCH", body: "<a/>", headers: { "content-type": "application/xml" } });

      const both = await call(client, "api_request", { method: "PUT", credential_id: cred.id, path: "/v1/x", json: {}, text: "" });
      expect(both.isError).toBe(true);
      const get = await client.callTool({ name: "api_request", arguments: { method: "GET", credential_id: cred.id, path: "/v1/x" } });
      expect(get.isError).toBe(true);
    });

    it("reaches identity services", async () => {
      const client = await connect(alice);
      const out = JSON.parse((await call(client, "api_get", { credential_id: "identity:murmur", path: "/me" })).raw);
      expect(out.body.url).toBe("https://murmur.example/api/me");
      expect(out.body.headers.authorization).toMatch(/^Bearer ey/);
    });

    it("cuts long bodies and leaves binary bodies out", async () => {
      const cred = await addBoard(alice);
      const client = await connect(alice);
      const long = JSON.parse((await call(client, "api_request", { method: "POST", credential_id: cred.id, path: "/v1/x", text: "x".repeat(5000), max_chars: 1000 })).raw);
      expect(long).toMatchObject({ truncated: true });
      expect(long.body).toHaveLength(1000);
      expect(long.total_chars).toBeGreaterThan(5000);

      const binary = JSON.parse((await call(client, "api_request", { method: "POST", credential_id: cred.id, path: "/binary", text: "abc" })).raw);
      expect(binary.body).toBeUndefined();
      expect(binary.body_omitted).toContain("issue_token");
      expect(binary.headers["content-type"]).toBe("application/octet-stream");
    });

    it("returns redirects instead of following them", async () => {
      const cred = await addBoard(alice);
      const client = await connect(alice);
      const out = JSON.parse((await call(client, "api_get", { credential_id: cred.id, path: "/redirect" })).raw);
      expect(out.status).toBe(302);
      expect(out.headers.location).toBe("https://download.example.com/file");
    });

    it("keeps the path inside the service and refuses other users' credentials", async () => {
      const cred = await addBoard(alice);
      const theirs = await addBoard(bob);
      const client = await connect(alice);
      for (const path of ["/../serper/search", "/%2e%2e/serper/search", "relative"]) {
        const out = await call(client, "api_get", { credential_id: cred.id, path });
        expect(out.isError, path).toBe(true);
        expect(out.raw, path).not.toContain('"status"');
      }
      expect((await call(client, "api_get", { credential_id: theirs.id, path: "/v1/clients" })).isError).toBe(true);
      expect((await call(client, "api_get", { credential_id: "identity:board", path: "/v1/clients" })).isError).toBe(true);
    });

    it("marks upstream errors as tool errors with the body", async () => {
      const client = await connect(alice);
      const freee = await upstream("freee");
      const cred = await vaultFor(env, alice).addOAuth(freee, { access_token: "a", refresh_token: "revoked-x", expires_at: Date.now() - 1000 });
      if ("error" in cred) throw new Error(cred.error);
      const out = await call(client, "api_get", { credential_id: cred.id, path: "/api/1/companies" });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.raw).status).toBeGreaterThanOrEqual(400);
    });
  });

  it("issues a token for an identity service without a stored credential", async () => {
    const cred = await addBoard(alice);
    const client = await connect(alice);
    const issued = JSON.parse(
      text(await client.callTool({ name: "issue_token", arguments: { credential_ids: ["identity:murmur", cred.id] } })),
    );
    const claims = await verifyToken<{ creds: Record<string, string> }>(env.SIGNING_KEY, BASE, "api", issued.token);
    expect(claims?.creds).toEqual({ murmur: "identity", board: cred.id });
    const res = await SELF.fetch(`${issued.services.murmur}/me`, { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(200);

    const notIdentity = await client.callTool({ name: "issue_token", arguments: { credential_ids: ["identity:board"] } });
    expect(notIdentity.isError).toBe(true);
    const unknown = await client.callTool({ name: "issue_token", arguments: { credential_ids: ["identity:nope"] } });
    expect(unknown.isError).toBe(true);
  });

  it("refuses other users' credentials", async () => {
    const theirs = await addBoard(bob);
    const client = await connect(alice);

    const foreign = await client.callTool({ name: "issue_token", arguments: { credential_ids: [theirs.id] } });
    expect(foreign.isError).toBe(true);
  });
});

describe("oauth surface", () => {
  it("challenges unauthenticated MCP requests with resource metadata", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("publishes protected resource and authorization server metadata", async () => {
    const prm = (await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);

    const as = (await (await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${BASE}/oauth/register`);
  });
});

describe("web ui", () => {
  async function sessionCookie(userId: string) {
    const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: userId }, 60);
    return `__Host-gw-session=${token}`;
  }

  it("redirects to sign-in without a session", async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("registers a credential from the form", async () => {
    const body = new URLSearchParams({ service: "board", "h:x-api-key": "k", "h:authorization": "t" });
    const res = await SELF.fetch(`${BASE}/credentials`, {
      method: "POST",
      headers: { cookie: await sessionCookie(carol), origin: new URL(BASE).origin },
      body,
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const [cred] = await vaultFor(env, carol).list();
    expect(res.headers.get("location")).toBe(`/?added=${cred.id}`);
    expect(cred).toMatchObject({ service: "board", label: "board" });
    expect(await vaultFor(env, carol).headers(cred.id, await upstream("board"))).toEqual({ headers: { "x-api-key": "k", authorization: "Bearer t" } });

    const page = await (await SELF.fetch(`${BASE}/?added=${cred.id}`, { headers: { cookie: await sessionCookie(carol) } })).text();
    expect(page).toContain(cred.id);
    expect(page).not.toContain(">k<");
    expect(page).toContain("board をつなぎました");
  });

  it("lists connections and identity services on the home page", async () => {
    const cookie = await sessionCookie(carol);
    const empty = await (await SELF.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(empty).toContain("トピック索引");
    expect(empty).toContain("登録不要");
    expect(empty).toContain(`href="/connections/new"`);
    expect(empty).toContain("Heddleway · Acme");

    const cred = await addBoard(carol);
    const page = await (await SELF.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(page).toContain(`href="/connections/${cred.id}/delete"`);
  });

  it("offers services grouped by provider, without identity services or OAuth services lacking a client", async () => {
    const page = await (await SELF.fetch(`${BASE}/connections/new`, { headers: { cookie: await sessionCookie(carol) } })).text();
    const order = ["<h2>Google</h2>", "<h2>Microsoft</h2>", "<h2>freee</h2>", "<h2>その他</h2>"].map((h) => page.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain(`href="/connections/new/docs"`);
    expect(page).toContain(`href="/connections/new/board"`);
    expect(page).toContain(`href="/connections/new/gmail"`);
    expect(page).not.toContain(`href="/connections/new/unclient"`);
    expect(page).not.toContain(`href="/connections/new/murmur"`);
    expect(page).toContain(`<script src="/assets/app.js" defer></script>`);
  });

  it("tells the user that the connection form is for this organization's accounts", async () => {
    const page = await (await SELF.fetch(`${BASE}/connections/new/board`, { headers: { cookie: await sessionCookie(carol) } })).text();
    expect(page).toContain("Acme のアカウントをつなぎます。別の組織のアカウントは、その組織のゲートウェイでつなぎます。");
  });

  it("shows a form for one service and 404 for others", async () => {
    const cookie = await sessionCookie(carol);
    const board = await SELF.fetch(`${BASE}/connections/new/board`, { headers: { cookie } });
    expect(board.status).toBe(200);
    const form = await board.text();
    expect(form).toContain(`action="/credentials"`);
    expect(form).toContain(`name="h:x-api-key"`);
    expect(await (await SELF.fetch(`${BASE}/connections/new/freee`, { headers: { cookie } })).text()).toContain(`action="/connect"`);
    expect((await SELF.fetch(`${BASE}/connections/new/murmur`, { headers: { cookie } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/connections/new/unclient`, { headers: { cookie } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/connections/new/constructor`, { headers: { cookie } })).status).toBe(404);
  });

  it("asks only for the password when the definition fixes the Basic user name", async () => {
    const cookie = await sessionCookie(carol);
    const fixed = await (await SELF.fetch(`${BASE}/connections/new/git-host`, { headers: { cookie } })).text();
    expect(fixed).toContain("Git host のトークン");
    expect(fixed).toContain(`name="h:password"`);
    expect(fixed).not.toContain(`name="h:username"`);
    const free = await (await SELF.fetch(`${BASE}/connections/new/basic-free`, { headers: { cookie } })).text();
    expect(free).toContain("メールアドレス");
    expect(free).toContain(`name="h:username"`);
    expect(free).toContain(`name="h:password"`);

    const res = await SELF.fetch(`${BASE}/credentials`, {
      method: "POST",
      headers: { cookie, origin: new URL(BASE).origin },
      body: new URLSearchParams({ service: "basic-free", "h:username": "me@example.com", "h:password": "p" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const [cred] = await vaultFor(env, carol).list();
    expect(await vaultFor(env, carol).headers(cred.id, await upstream("basic-free"))).toEqual({
      headers: { authorization: `Basic ${btoa("me@example.com:p")}` },
    });
  });

  it("confirms before deleting a connection", async () => {
    const cookie = await sessionCookie(carol);
    const cred = await addBoard(carol);
    const confirm = await (await SELF.fetch(`${BASE}/connections/${cred.id}/delete`, { headers: { cookie } })).text();
    expect(confirm).toContain("「board」を削除しますか?");
    expect(confirm).toContain(`action="/credentials/${cred.id}/delete"`);
    expect(await vaultFor(env, carol).list()).toHaveLength(1);

    const res = await SELF.fetch(`${BASE}/credentials/${cred.id}/delete`, {
      method: "POST",
      headers: { cookie, origin: new URL(BASE).origin },
      redirect: "manual",
    });
    expect(res.headers.get("location")).toBe("/?deleted=1");
    expect(await vaultFor(env, carol).list()).toEqual([]);
    const gone = await SELF.fetch(`${BASE}/connections/${cred.id}/delete`, { headers: { cookie }, redirect: "manual" });
    expect(gone.headers.get("location")).toBe("/");
  });

  it("serves the picker script and lets pages load it", async () => {
    const js = await SELF.fetch(`${BASE}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("data-search");
    const page = await SELF.fetch(`${BASE}/connections/new`, { headers: { cookie: await sessionCookie(carol) } });
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("shows the user ID for the admin setting", async () => {
    const page = await (await SELF.fetch(`${BASE}/`, { headers: { cookie: await sessionCookie(carol) } })).text();
    expect(page).toMatch(new RegExp(`<details class="account"><summary>アカウントの情報</summary><p>ユーザー ID: <code>${carol}</code>`));
  });

  it("asks to delete and add again when an API key no longer fits its service", async () => {
    const cred = await addBoard(carol);
    const board = await upstream("board");
    await vaultFor(env, carol).headers(cred.id, { ...board, config: { ...board.config, base_url: "https://moved.example" } });
    const page = await (await SELF.fetch(`${BASE}/`, { headers: { cookie: await sessionCookie(carol) } })).text();
    expect(page).toContain("削除して追加し直してください");
    expect(page).not.toContain(`name="credential" value="${cred.id}"`);
  });

  it("offers to replace instead of adding a second account for a connected service", async () => {
    const cookie = await sessionCookie(carol);
    const cred = await addBoard(carol);
    const picker = await (await SELF.fetch(`${BASE}/connections/new`, { headers: { cookie } })).text();
    expect(picker).toContain("API キーを入力 · つないでいます");
    const form = await (await SELF.fetch(`${BASE}/connections/new/board`, { headers: { cookie } })).text();
    expect(form).toContain("board はつないでいます");
    expect(form).toContain(`href="/connections/${cred.id}/delete"`);
    expect(form).not.toContain(`action="/credentials"`);

    const res = await SELF.fetch(`${BASE}/credentials`, {
      method: "POST",
      headers: { cookie, origin: new URL(BASE).origin },
      body: new URLSearchParams({ service: "board", "h:x-api-key": "k", "h:authorization": "t" }),
      redirect: "manual",
    });
    expect(res.headers.get("location")).toBe("/connections/new/board");
    expect(await vaultFor(env, carol).list()).toHaveLength(1);
  });

  it("asks to delete the extra connections left from before one account per service", async () => {
    const cred = await addBoard(carol);
    await runInDurableObject(vaultFor(env, carol), async (_, state) => {
      const stored = (await state.storage.get<Record<string, unknown>>(`cred:${cred.id}`))!;
      await state.storage.put("cred:older-extra", { ...stored, id: "older-extra", label: `<script>alert("x")</script>`, createdAt: 1 });
    });
    const page = await (await SELF.fetch(`${BASE}/`, { headers: { cookie: await sessionCookie(carol) } })).text();
    expect(page.match(/使わないほうを削除してください/g)).toHaveLength(2);
    // A label typed by the user before is still escaped.
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;");
  });

  it("signs out without starting a new sign-in", async () => {
    const res = await SELF.fetch(`${BASE}/logout`, {
      method: "POST",
      headers: { cookie: await sessionCookie(carol), origin: new URL(BASE).origin },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-gw-session=; .*Max-Age=0/);
  });

  it("rejects cross-site form posts", async () => {
    const res = await SELF.fetch(`${BASE}/credentials`, {
      method: "POST",
      headers: { cookie: await sessionCookie(carol), origin: "https://evil.example" },
      body: new URLSearchParams({ service: "board" }),
    });
    expect(res.status).toBe(403);
    expect(await vaultFor(env, carol).list()).toEqual([]);
  });
});
