import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey } from "jose";
import { describe, expect, it } from "vitest";
import { publicUrl } from "../src/config";
import { buildServer } from "../src/mcp";
import { signToken } from "../src/tokens";
import { vaultFor } from "../src/vault";
import { upstream } from "./helpers";

// Reverse connections (docs/adr/0003, docs/reverse-protocol.md): a local service pairs with
// its owner's approval, connects with its key, and the gateway relays its owner's calls to it.

const BASE = publicUrl(env);
const ORIGIN = new URL(BASE).origin;
const user = () => crypto.randomUUID();

async function cookie(userId: string) {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: `name-${userId.slice(0, 4)}` }, 60);
  return `__Host-gw-session=${token}`;
}

async function postJson(path: string, body: unknown) {
  return SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function ownerPost(path: string, fields: Record<string, string>, userId: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: await cookie(userId), origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

interface Local {
  privateKey: JoseKey;
  publicJwk: Record<string, unknown>;
}

async function newKey(): Promise<Local> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  return { privateKey, publicJwk: { ...(await exportJWK(publicKey)) } };
}

async function startPairing(local: Local, name: string, description?: string) {
  const res = await postJson("/reverse/pair", { name, public_key: local.publicJwk, ...(description ? { description } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as { code: string; pairing_id: string; verification_uri_complete: string; thumbprint: string };
}

async function poll(pairingId: string) {
  const res = await postJson("/reverse/pair/status", { pairing_id: pairingId });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

// Pairs a new local service owned by `owner`; returns its ID.
async function pair(owner: string, name = "boid", local?: Local, callback: string[] = []): Promise<{ id: string; local: Local }> {
  local ??= await newKey();
  const started = await startPairing(local, name);
  const form = new URLSearchParams({ code: started.code, name, decision: "approve" });
  for (const c of callback) form.append("callback", c);
  const approved = await SELF.fetch(`${BASE}/pair`, { method: "POST", headers: { cookie: await cookie(owner), origin: ORIGIN }, body: form, redirect: "manual" });
  expect(approved.status).toBe(303);
  const polled = await poll(started.pairing_id);
  expect(polled.body.status).toBe("approved");
  return { id: polled.body.service_id, local };
}

async function assertion(local: Local, serviceId: string, overrides: { nonce?: string; aud?: string; iss?: string } = {}) {
  const nonce = overrides.nonce ?? ((await (await postJson("/reverse/challenge", {})).json()) as { challenge: string }).challenge;
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(overrides.iss ?? serviceId)
    .setAudience(overrides.aud ?? `${BASE}/reverse/connect`)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(local.privateKey);
}

function upgrade(jwt: string) {
  return SELF.fetch(`${BASE}/reverse/connect`, { headers: { upgrade: "websocket", authorization: `Bearer ${jwt}` } });
}

type Frame = Record<string, unknown>;

// A local service that answers relayed requests with `handler`.
async function connect(local: Local, serviceId: string, handler: (req: Frame) => Frame | null = echo) {
  const res = await upgrade(await assertion(local, serviceId));
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: Frame[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    frames.push(frame);
    if (frame.type === "request") {
      const answer = handler(frame);
      if (answer) ws.send(JSON.stringify({ type: "response", id: frame.id, ...answer }));
    }
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
  });
  ws.accept();
  await until(() => frames.some((f) => f.type === "welcome"));
  return { ws, frames, closed: () => closed };
}

// Closes from the service's side and waits for the handshake: a socket left half-closed keeps
// the test runtime from shutting down.
async function hangUp(conn: { ws: WebSocket; closed(): { code: number } | null }) {
  conn.ws.close(1000, "done");
  await until(() => conn.closed() !== null);
}

function echo(req: Frame): Frame {
  // The request body stays base64, as it came.
  const body = JSON.stringify({ method: req.method, path: req.path, headers: req.headers, body: req.body });
  return { status: 200, headers: [["content-type", "application/json"], ["x-local", "yes"], ["set-cookie", "a=1"]], body: btoa(body) };
}

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function call(userId: string, serviceId: string, name: string, path: string, init: RequestInit = {}) {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "api", userId, { creds: { [name]: `reverse:${serviceId}` } }, 60);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}/api/${name}${path}`, { ...init, headers });
}

describe("pairing", () => {
  it("gives the local service a code, and the owner approves it as their own", async () => {
    const owner = user();
    const local = await newKey();
    const started = await startPairing(local, "boid", "野瀬の開発用 PC の boid");
    expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.verification_uri_complete).toBe(`${BASE}/pair?code=${encodeURIComponent(started.code)}`);
    expect((await poll(started.pairing_id)).body.status).toBe("pending");

    // The owner sees the description and the key's thumbprint before approving.
    const page = await SELF.fetch(`${BASE}/pair?code=${started.code.toLowerCase().replace("-", "")}`, { headers: { cookie: await cookie(owner) } });
    const text = await page.text();
    expect(text).toContain("野瀬の開発用 PC の boid");
    expect(text).toContain(started.thumbprint);

    const approved = await ownerPost("/pair", { code: started.code, name: "boid", decision: "approve" }, owner);
    expect(approved.headers.get("location")).toMatch(/^\/\?paired=/);
    const polled = await poll(started.pairing_id);
    expect(polled.body).toMatchObject({ status: "approved", name: "boid", connect_url: `${BASE.replace(/^http/, "ws")}/reverse/connect` });
    // Told once, then forgotten; the code cannot be used again.
    expect((await poll(started.pairing_id)).status).toBe(404);
    const again = await ownerPost("/pair", { code: started.code, name: "boid", decision: "approve" }, user());
    expect(again.status).toBe(404);
  });

  it("sends signed-out owners to sign in first, and back to the code", async () => {
    const res = await SELF.fetch(`${BASE}/pair?code=ABCD-EFGH`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/pair?code=ABCD-EFGH")}`);
  });

  it("can be denied", async () => {
    const started = await startPairing(await newKey(), "boid");
    const denied = await ownerPost("/pair", { code: started.code, name: "boid", decision: "deny" }, user());
    expect(denied.headers.get("location")).toBe("/?pairing_denied=1");
    expect((await poll(started.pairing_id)).body.status).toBe("denied");
  });

  it("refuses private keys, bad names, and names the gateway already uses", async () => {
    const local = await newKey();
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    expect((await postJson("/reverse/pair", { name: "boid", public_key: await exportJWK(privateKey) })).status).toBe(400);
    expect((await postJson("/reverse/pair", { name: "Boid!", public_key: local.publicJwk })).status).toBe(400);
    expect((await postJson("/reverse/pair", { name: "boid", public_key: { kty: "RSA", n: "x", e: "AQAB" } })).status).toBe(400);

    const owner = user();
    const started = await startPairing(local, "board");
    const clash = await ownerPost("/pair", { code: started.code, name: "board", decision: "approve" }, owner);
    expect(clash.status).toBe(409);
    expect(await clash.text()).toContain("このゲートウェイのサービスの名前");
    // The owner picks another name on the same code.
    expect((await ownerPost("/pair", { code: started.code, name: "my-board", decision: "approve" }, owner)).status).toBe(303);
  });

  it("keeps names unique among one owner's services, but not across owners", async () => {
    const owner = user();
    await pair(owner, "legacy");
    const started = await startPairing(await newKey(), "legacy");
    expect((await ownerPost("/pair", { code: started.code, name: "legacy", decision: "approve" }, owner)).status).toBe(409);
    await pair(user(), "legacy");
  });
});

describe("connecting", () => {
  it("accepts a fresh signature of a challenge, once", async () => {
    const owner = user();
    const { id, local } = await pair(owner);
    const nonce = ((await (await postJson("/reverse/challenge", {})).json()) as { challenge: string }).challenge;
    const first = await upgrade(await assertion(local, id, { nonce }));
    expect(first.status).toBe(101);
    const ws = first.webSocket!;
    let closed = false;
    ws.addEventListener("close", () => (closed = true));
    ws.accept();
    const reused = await upgrade(await assertion(local, id, { nonce }));
    expect(reused.status).toBe(401);
    ws.close(1000);
    await until(() => closed);
  });

  it("refuses another key, another audience, a forged challenge, and a plain request", async () => {
    const { id, local } = await pair(user());
    const other = await newKey();
    expect((await upgrade(await assertion(other, id))).status).toBe(401);
    expect((await upgrade(await assertion(local, id, { aud: "https://elsewhere.example/reverse/connect" }))).status).toBe(401);
    expect((await upgrade(await assertion(local, id, { nonce: "not-a-challenge" }))).status).toBe(401);
    expect((await upgrade(await assertion(local, crypto.randomUUID(), { iss: crypto.randomUUID() }))).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/reverse/connect`, { headers: { authorization: `Bearer ${await assertion(local, id)}` } })).status).toBe(426);
  });

  it("lets a newer connection replace the old one", async () => {
    const { id, local } = await pair(user());
    const first = await connect(local, id);
    const second = await connect(local, id);
    await until(() => first.closed() !== null);
    expect(first.closed()!.code).toBe(4001);
    expect(second.closed()).toBeNull();
    await hangUp(second);
  });
});

describe("relaying", () => {
  it("passes the owner's request to the local service and its answer back, without credentials or cookies", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "boid");
    const conn = await connect(local, id);
    const res = await call(owner, id, "boid", "/jobs?state=open", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "secret=1", "x-trace": "t1" },
      body: JSON.stringify({ title: "調べる" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-local")).toBe("yes");
    expect(res.headers.get("set-cookie")).toBeNull();
    const seen = (await res.json()) as { method: string; path: string; headers: [string, string][]; body: string };
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/jobs?state=open");
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(seen.body), (c) => c.charCodeAt(0))))).toEqual({ title: "調べる" });
    const names = seen.headers.map(([n]) => n);
    expect(names).toContain("x-trace");
    expect(names).not.toContain("authorization");
    expect(names).not.toContain("cookie");
    await hangUp(conn);
  });

  it("carries the service's status, and 202 for work it runs asynchronously", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "legacy");
    const conn = await connect(local, id, () => ({ status: 202, headers: [["location", "/jobs/j1"]], body: btoa('{"id":"j1"}') }));
    const res = await call(owner, id, "legacy", "/orders", { method: "POST", body: "{}" });
    expect(res.status).toBe(202);
    expect(res.headers.get("location")).toBe("/jobs/j1");
    expect(await res.json()).toEqual({ id: "j1" });
    await hangUp(conn);
  });

  it("is for the owner only", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "boid");
    const conn = await connect(local, id);
    expect((await call(user(), id, "boid", "/jobs")).status).toBe(403);
    // The credential names the service: another name does not reach it.
    expect((await call(owner, id, "other", "/jobs")).status).toBe(403);
    await hangUp(conn);
  });

  it("answers at once when the service is not connected, and after it was removed", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "boid");
    const offline = await call(owner, id, "boid", "/jobs");
    expect(offline.status).toBe(503);
    expect(await offline.text()).toContain("not connected");

    const conn = await connect(local, id);
    expect((await call(owner, id, "boid", "/jobs")).status).toBe(200);
    expect((await ownerPost(`/local-services/${id}/delete`, {}, owner)).headers.get("location")).toBe("/?local_removed=1");
    await until(() => conn.closed() !== null);
    expect(conn.closed()!.code).toBe(4003);
    expect((await call(owner, id, "boid", "/jobs")).status).toBe(403);
    expect((await upgrade(await assertion(local, id))).status).toBe(401);
  });

  it("lets only the owner or an admin remove a service", async () => {
    const owner = user();
    const { id } = await pair(owner, "boid");
    expect((await ownerPost(`/local-services/${id}/delete`, {}, user())).headers.get("location")).toBe("/?local_removed=1");
    const listed = await SELF.fetch(`${BASE}/`, { headers: { cookie: await cookie(owner) } });
    expect(await listed.text()).toContain(`id="r-${id}"`);
    const admin = await SELF.fetch(`${BASE}/admin/local-services`, { headers: { cookie: await cookie("admin-user") } });
    expect(await admin.text()).toContain(`id="r-${id}"`);
    expect((await ownerPost(`/local-services/${id}/delete`, {}, "admin-user")).headers.get("location")).toBe("/admin/local-services?removed=1");
  });

  it("drops a connection that breaks the protocol", async () => {
    const { id, local } = await pair(user());
    const conn = await connect(local, id);
    conn.ws.send("not json");
    await until(() => conn.closed() !== null);
    expect(conn.closed()!.code).toBe(4400);
  });

  it("reports an unreadable answer as a gateway error", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "boid");
    const conn = await connect(local, id, () => ({ status: 101, headers: [] }));
    expect((await call(owner, id, "boid", "/x")).status).toBe(502);
    await hangUp(conn);
  });
});

describe("MCP tools", () => {
  async function client(userId: string) {
    const server = buildServer(env, { userId, name: userId }, createExecutionContext());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(clientTransport);
    return c;
  }
  const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0].text;

  it("list the owner's local services with the description they sent, and call them", async () => {
    const owner = user();
    const { id, local } = await pair(owner, "legacy");
    const conn = await connect(local, id);
    conn.ws.send(JSON.stringify({ type: "hello", description: "受注を登録する API。POST /orders", version: "0.1.0" }));
    const c = await client(owner);
    let listed: { services: string[]; credentials: Record<string, unknown>[] } = { services: [], credentials: [] };
    for (let i = 0; i < 50 && !listed.credentials.some((x) => x.description); i++) {
      listed = JSON.parse(text(await c.callTool({ name: "list_credentials", arguments: {} })));
    }
    expect(listed.services).toContain("legacy");
    expect(listed.credentials).toContainEqual({
      id: `reverse:${id}`,
      service: "legacy",
      label: "legacy(手元のサービス)",
      kind: "local",
      connected: true,
      description: "受注を登録する API。POST /orders",
    });

    const got = JSON.parse(text(await c.callTool({ name: "api_get", arguments: { credential_id: `reverse:${id}`, path: "/orders/1" } })));
    expect(got.status).toBe(200);
    expect(got.body.path).toBe("/orders/1");

    // Another user's tools neither list nor reach it.
    const other = await client(user());
    const theirs = JSON.parse(text(await other.callTool({ name: "list_credentials", arguments: {} })));
    expect(theirs.services).not.toContain("legacy");
    const refused = await other.callTool({ name: "issue_token", arguments: { credential_ids: [`reverse:${id}`] } });
    expect(refused.isError).toBe(true);
    await hangUp(conn);
  });
});

describe("calling back", () => {
  async function withBoard(owner: string) {
    const added = await vaultFor(env, owner).add(await upstream("board"), { "x-api-key": "owner-key", authorization: "owner-token" });
    if ("error" in added) throw new Error(added.error);
  }

  // Sends a call frame and waits for its result.
  async function callBack(conn: Awaited<ReturnType<typeof connect>>, frame: Frame) {
    const id = crypto.randomUUID();
    conn.ws.send(JSON.stringify({ type: "call", id, ...frame }));
    await until(() => conn.frames.some((f) => f.type === "call_result" && f.id === id), 4000);
    const result = conn.frames.find((f) => f.id === id)!;
    const body = result.body ? new TextDecoder().decode(Uint8Array.from(atob(result.body as string), (c) => c.charCodeAt(0))) : "";
    return { status: result.status as number, body };
  }

  it("reaches the services the owner chose, with the owner's credential", async () => {
    const owner = user();
    await withBoard(owner);
    const { id, local } = await pair(owner, "boid", undefined, ["board"]);
    const conn = await connect(local, id);
    const result = await callBack(conn, { method: "POST", service: "board", path: "/v1/projects?x=1", headers: [["content-type", "application/json"]], body: btoa("{}") });
    expect(result.status).toBe(200);
    const seen = JSON.parse(result.body);
    expect(seen.url).toBe("https://api.the-board.jp/v1/projects?x=1");
    expect(seen.headers["x-api-key"]).toBe("owner-key");
    expect(seen.body).toBe("{}");
    await hangUp(conn);
  });

  it("is off until the owner chooses a service, and follows changes at once", async () => {
    const owner = user();
    await withBoard(owner);
    const { id, local } = await pair(owner, "boid");
    const conn = await connect(local, id);
    expect((await callBack(conn, { method: "GET", service: "board", path: "/v1/projects" })).status).toBe(403);

    const settings = await SELF.fetch(`${BASE}/local-services/${id}`, { headers: { cookie: await cookie(owner) } });
    expect(await settings.text()).toContain('value="board"');
    expect((await ownerPost(`/local-services/${id}`, { callback: "board" }, owner)).status).toBe(303);
    expect((await callBack(conn, { method: "GET", service: "board", path: "/v1/projects" })).status).toBe(200);
    // Another user cannot change it.
    expect((await ownerPost(`/local-services/${id}`, { callback: "board" }, user())).headers.get("location")).toBe("/");

    const form = new URLSearchParams();
    await SELF.fetch(`${BASE}/local-services/${id}`, { method: "POST", headers: { cookie: await cookie(owner), origin: ORIGIN }, body: form, redirect: "manual" });
    expect((await callBack(conn, { method: "GET", service: "board", path: "/v1/projects" })).status).toBe(403);
    await hangUp(conn);
  });

  it("offers only services the owner reaches, and keeps calls inside the chosen service", async () => {
    const owner = user();
    // "serper" is not connected by the owner: choosing it is ignored.
    await withBoard(owner);
    const { id, local } = await pair(owner, "boid", undefined, ["board", "serper"]);
    const conn = await connect(local, id);
    expect((await callBack(conn, { method: "GET", service: "serper", path: "/search" })).status).toBe(403);
    expect((await callBack(conn, { method: "GET", service: "board", path: "/../serper/search" })).status).toBe(400);
    expect((await callBack(conn, { method: "GET", service: "board", path: "no-slash" })).status).toBe(400);
    await hangUp(conn);
  });
});
