import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appAllows, checkExamples, parseAppDefinition, type AppDefinition } from "../src/apps";
import { publicUrl } from "../src/config";
import { s256 } from "../src/crypto";
import { IDENTITY_CREDENTIAL } from "../src/identity";
import { signToken } from "../src/tokens";

// Apps (docs/adr/0008): registered by an admin from a client metadata document, consented to
// by each user, and held to their ports by the proxy.

const BASE = publicUrl(env);
const ORIGIN = new URL(BASE).origin;
const ADMIN = "admin-user";
const REDIRECT_URI = "https://client.test/callback";
const doc = (variant: string, name: string) => `https://apps.example/${variant}/${name}.json`;
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

async function cookie(userId: string) {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: userId }, 60);
  return `__Host-gw-session=${token}`;
}

async function get(path: string, userId = ADMIN) {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie: await cookie(userId) }, redirect: "manual" });
}

async function post(path: string, fields: Record<string, string>, userId = ADMIN) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: await cookie(userId), origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

// Serves the given variant at the app's live document (vitest.config.ts).
async function serve(name: string, variant: string) {
  expect((await fetch(`https://apps.example/_set/${name}/${variant}`, { method: "POST" })).status).toBe(204);
}

// Reads the document and approves what the confirmation page showed.
async function register(variant: string, name: string): Promise<string> {
  await serve(name, variant);
  const preview = await (await post("/admin/apps/preview", { client_id: doc("live", name) })).text();
  const approval = preview.match(/name="approval" value="([^"]+)"/)?.[1];
  if (!approval) throw new Error(`not approvable: ${preview}`);
  const saved = await post("/admin/apps", { approval });
  expect(saved.status).toBe(303);
  return preview;
}

async function appToken(app: string, userId = "app-user") {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "api", userId, { creds: { murmur: IDENTITY_CREDENTIAL }, app }, 60);
  return token;
}

function call(token: string, method: string, path: string) {
  return SELF.fetch(`${BASE}/api/murmur${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

const definition = (ports: AppDefinition["ports"]): AppDefinition => ({
  name: "x",
  displayName: "X",
  clientId: "https://x.example/c.json",
  description: "d",
  ports,
  examples: { allow: [], deny: [] },
});

describe("app definitions", () => {
  it("allow only whole matches of a port's path, and refuse path tricks", () => {
    const app = definition([{ service: "murmur", method: "GET", path: "^/threads$" }]);
    expect(appAllows(app, "murmur", "GET", "/threads")).toBe(true);
    expect(appAllows(app, "murmur", "GET", "/threads?since=x")).toBe(true);
    expect(appAllows(app, "murmur", "POST", "/threads")).toBe(false);
    expect(appAllows(app, "graph", "GET", "/threads")).toBe(false);
    expect(appAllows(app, "murmur", "GET", "/threads/1")).toBe(false);
    expect(appAllows(app, "murmur", "GET", "/x/../threads")).toBe(false);
    expect(appAllows(app, "murmur", "GET", "/threads%2f..")).toBe(false);
  });

  it("are read from the metadata document, refusing unanchored paths and a wrong client ID", () => {
    const base = { client_id: "https://x.example/c.json", heddleway_app: { name: "x", description: "d", ports: [{ service: "murmur", method: "GET", path: "^/threads$" }] } };
    expect(parseAppDefinition(base, "https://x.example/c.json").ports).toHaveLength(1);
    expect(() => parseAppDefinition(base, "https://y.example/c.json")).toThrow(/client_id/);
    const loose = { ...base, heddleway_app: { ...base.heddleway_app, ports: [{ service: "murmur", method: "GET", path: "/threads" }] } };
    expect(() => parseAppDefinition(loose, "https://x.example/c.json")).toThrow(/全体一致/);
  });

  it("check their examples", () => {
    const app = { ...definition([{ service: "murmur", method: "GET", path: "^/threads$" }]), examples: { allow: ["GET murmur /threads"], deny: ["GET murmur /threads"] } };
    expect(checkExamples(app).map((r) => r.expected === r.actual)).toEqual([true, false]);
  });
});

describe("registering apps", () => {
  it("is for admins only", async () => {
    expect((await get("/admin/apps", "someone")).status).toBe(404);
    expect((await post("/admin/apps/preview", { client_id: doc("plain", "x") }, "someone")).status).toBe(404);
    expect(await (await get("/admin/apps")).text()).toContain("アプリの管理");
  });

  it("shows the definition and stores what was shown when approved", async () => {
    const name = unique("disp");
    const preview = await register("plain", name);
    expect(preview).toContain("決まったリストを見張り");
    expect(preview).toContain("^/threads$");
    expect(preview).toContain("✓");
    expect(await (await get("/admin/apps")).text()).toContain(name);
  });

  it("refuses documents without a definition, with unanchored paths, or with failing examples", async () => {
    expect(await (await post("/admin/apps/preview", { client_id: doc("missing", unique("m")) })).text()).toContain("heddleway_app がありません");
    expect(await (await post("/admin/apps/preview", { client_id: doc("unanchored", unique("u")) })).text()).toContain("全体一致");
    const failing = await (await post("/admin/apps/preview", { client_id: doc("wrong-example", unique("w")) })).text();
    expect(failing).toContain("✗");
    expect(failing).not.toContain('name="approval"');
  });

  it("refuses an approval that was not signed for this admin", async () => {
    expect((await post("/admin/apps", { approval: "forged" })).status).toBe(400);
  });

  it("shows the added ports when the definition is updated", async () => {
    const name = unique("upd");
    await register("plain", name);
    await serve(name, "wide");
    const preview = await (await post("/admin/apps/preview", { client_id: doc("live", name) })).text();
    expect(preview).toContain("定義の更新");
    expect(preview).toContain("<td>追加</td>");
    expect(preview).toContain('name="approval"');
  });

  it("refuses a second app with the same name and another client ID", async () => {
    const name = unique("dup");
    await register("plain", name);
    const preview = await (await post("/admin/apps/preview", { client_id: doc("plain", name) })).text();
    expect(preview).toContain("別のクライアント ID");
    expect(preview).not.toContain('name="approval"');
  });
});

describe("the proxy, for a token issued to an app", () => {
  it("lets through the app's ports only", async () => {
    const name = unique("px");
    await register("plain", name);
    const token = await appToken(name);
    expect((await call(token, "GET", "/threads?since=x")).status).toBe(200);
    expect((await call(token, "POST", "/sent")).status).toBe(403);
    expect((await call(token, "GET", "/threads/thr_1")).status).toBe(403);
    expect((await call(token, "GET", "/threads%2f..%2fsent")).status).toBe(403);
  });

  it("refuses everything once the app's registration is removed, and narrows at once", async () => {
    const name = unique("rm");
    await register("wide", name);
    const token = await appToken(name);
    expect((await call(token, "POST", "/notes")).status).toBe(200);
    await register("plain", name);
    expect((await call(token, "POST", "/notes")).status).toBe(403);
    expect((await post(`/admin/apps/${name}/delete`, {})).status).toBe(303);
    const refused = await call(token, "GET", "/threads");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("no longer registered");
  });
});

describe("authorizing an app", () => {
  function authorizeUrl(clientId: string, scope: string, challenge: string) {
    const url = new URL(`${BASE}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${BASE}/mcp`,
      scope,
    })) {
      url.searchParams.set(k, v);
    }
    return url;
  }

  it("refuses an app that is not registered, or a scope that mixes an app with the stand's", async () => {
    const name = unique("na");
    const challenge = await s256("v".repeat(43));
    expect(await (await SELF.fetch(authorizeUrl(doc("live", name), `app:${name}`, challenge))).text()).toContain("登録されていません");
    await register("plain", name);
    expect(await (await SELF.fetch(authorizeUrl(doc("live", name), `app:${name} gateway`, challenge))).text()).toContain("ほかの範囲と一緒には");
    // Another client cannot borrow the registered app's scope.
    expect(await (await SELF.fetch(authorizeUrl(doc("plain", name), `app:${name}`, challenge))).text()).toContain("登録されていません");
  });

  it("grants the app scope and serves the tools for the app's services only", async () => {
    const name = unique("flow");
    await register("plain", name);
    const clientId = doc("live", name);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const url = authorizeUrl(clientId, `app:${name}`, await s256(verifier));

    const consent = await SELF.fetch(url);
    const page = await consent.text();
    expect(page).toContain("決まったリストを見張り");
    expect(page).toContain("決まった API だけ");
    const cookies = consent.headers.getSetCookie().map((c) => c.split(";")[0]);
    const handle = page.match(/name="handle" value="([^"]+)"/)![1];
    const approved = await SELF.fetch(url, {
      method: "POST",
      headers: { cookie: cookies.join("; ") },
      body: new URLSearchParams({ handle, decision: "approve" }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    cookies.push(...approved.headers.getSetCookie().map((c) => c.split(";")[0]));
    const toIdp = new URL(approved.headers.get("location")!);
    const oid = crypto.randomUUID();
    const code = btoa(JSON.stringify({ nonce: toIdp.searchParams.get("nonce"), tid: "tenant-1", oid, name: "Ada" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const callback = await SELF.fetch(`${BASE}/oauth/callback?code=${code}&state=${toIdp.searchParams.get("state")}`, {
      headers: { cookie: cookies.join("; ") },
      redirect: "manual",
    });
    const back = new URL(callback.headers.get("location")!);
    const tokenRes = await SELF.fetch(`${BASE}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });
    const token = (await tokenRes.json()) as { access_token: string; scope?: string };
    expect(token.scope).toBe(`app:${name}`);

    const tool = async (toolName: string, args: Record<string, unknown> = {}) => {
      const res = await SELF.fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
      });
      return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    };
    const listed = JSON.parse((await tool("list_credentials")).content[0].text);
    expect(listed.services).toEqual(["murmur"]);
    expect(listed.credentials.map((c: { id: string }) => c.id)).toEqual(["identity:murmur"]);
    expect((await tool("issue_token", { credential_ids: ["identity:board"] })).isError).toBe(true);
    const ok = JSON.parse((await tool("api_get", { credential_id: "identity:murmur", path: "/threads" })).content[0].text);
    expect(ok.status).toBe(200);
    const refused = await tool("api_request", { method: "POST", credential_id: "identity:murmur", path: "/sent", json: {} });
    expect(refused.isError).toBe(true);
  });
});
