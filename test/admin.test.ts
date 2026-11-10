import { env, SELF } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publicUrl } from "../src/config";
import { forgetRegistry, getDirectory } from "../src/services";
import { signToken } from "../src/tokens";
import { vaultFor } from "../src/vault";
import { upstream } from "./helpers";

const BASE = publicUrl(env);
const ORIGIN = new URL(BASE).origin;
const ADMIN = "admin-user";

async function cookie(userId: string) {
  const { token } = await signToken(env.SIGNING_KEY, BASE, "session", userId, { name: userId }, 60);
  return `__Host-gw-session=${token}`;
}

function get(path: string, userId = ADMIN) {
  return cookie(userId).then((c) => SELF.fetch(`${BASE}${path}`, { headers: { cookie: c }, redirect: "manual" }));
}

async function post(path: string, fields: Record<string, string>, userId = ADMIN, origin = ORIGIN) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: await cookie(userId), origin },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

// Durable Object storage persists across tests, so each test names its own service.
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function headerService(name: string, base_url = "https://api.acme.example") {
  return { name, display_name: "Acme", provider: "自社", base_url, auth_type: "headers", h_name_0: "x-api-key", h_label_0: "Acme の API キー", h_prefix_0: "" };
}

describe("admin screens", () => {
  it("are hidden from everyone but admins", async () => {
    expect((await SELF.fetch(`${BASE}/admin/services`, { redirect: "manual" })).headers.get("location")).toBe("/login");
    expect((await get("/admin/services", "someone")).status).toBe(404);
    expect((await post("/admin/services", headerService(unique("x")), "someone")).status).toBe(404);
    expect((await get("/admin/services")).status).toBe(200);
    expect(await (await get("/", ADMIN)).text()).toContain(`href="/admin/services"`);
    expect(await (await get("/", "someone")).text()).not.toContain(`href="/admin/services"`);
  });

  it("lists services with where each one comes from", async () => {
    const page = await (await get("/admin/services")).text();
    expect(page).toContain("gmail");
    expect(page).toContain("組み込み");
    expect(page).toContain("murmur");
    expect(page).toContain("設定ファイル");
  });

  it("adds a service that users can then connect and call", async () => {
    const name = unique("acme");
    const res = await post("/admin/services", headerService(name));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/services?saved=${name}`);

    expect(await (await get("/connections/new", "user-1")).text()).toContain(`href="/connections/new/${name}"`);
    forgetRegistry();
    const cred = await vaultFor(env, "user-1").add(await upstream(name), { "x-api-key": "k" });
    if ("error" in cred) throw new Error(cred.error);
    const { token } = await signToken(env.SIGNING_KEY, BASE, "api", "user-1", { creds: { [name]: cred.id } }, 60);
    const proxied = await SELF.fetch(`${BASE}/api/${name}/v1/things`, { headers: { authorization: `Bearer ${token}` } });
    const echoed = (await proxied.json()) as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("https://api.acme.example/v1/things");
    expect(echoed.headers["x-api-key"]).toBe("k");
  });

  it("adds a Basic authentication service, and stops connections without a user name when the fixed one is removed", async () => {
    const name = unique("git");
    const fields = { name, display_name: "Git", provider: "", base_url: "https://git.acme.example", auth_type: "basic", basic_username: "x-token-auth", basic_username_label: "", basic_password_label: "アクセストークン" };
    expect((await post("/admin/services", fields)).status).toBe(303);
    forgetRegistry();
    expect((await upstream(name)).config.auth).toEqual({ type: "basic", username: "x-token-auth", password_label: "アクセストークン" });
    const edit = await (await get(`/admin/services/${name}`)).text();
    expect(edit).toContain(`value="x-token-auth"`);

    const cred = await vaultFor(env, "user-6").add(await upstream(name), { password: "t" });
    if ("error" in cred) throw new Error(cred.error);
    const { token } = await signToken(env.SIGNING_KEY, BASE, "api", "user-6", { creds: { [name]: cred.id } }, 60);
    const call = () => SELF.fetch(`${BASE}/api/${name}/owner/repo.git/info/refs`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await (await call()).json()) as { headers: Record<string, string> }).headers.authorization).toBe(`Basic ${btoa("x-token-auth:t")}`);

    await post(`/admin/services/${name}`, { ...fields, basic_username: "" });
    forgetRegistry();
    const refused = await call();
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain("no value for username");
  });

  it("refuses built-in names, bad definitions, duplicates and cross-site posts", async () => {
    expect(await (await post("/admin/services", headerService("gmail"))).text()).toContain("組み込みの接続先と同じ名前");
    expect(await (await post("/admin/services", headerService(unique("plain"), "http://api.example"))).text()).toContain("must be https");
    expect(await (await post("/admin/services", { ...headerService(unique("none")), h_name_0: "" })).text()).toContain("ヘッダーを 1 つ以上");
    const name = unique("dup");
    expect((await post("/admin/services", headerService(name))).status).toBe(303);
    expect(await (await post("/admin/services", headerService(name))).text()).toContain("すでに管理画面に登録");
    expect((await post("/admin/services", headerService(unique("csrf")), ADMIN, "https://evil.example")).status).toBe(403);
  });

  it("stops existing connections when an edit moves the service to another host", async () => {
    const name = unique("moving");
    await post("/admin/services", headerService(name));
    forgetRegistry();
    const cred = await vaultFor(env, "user-2").add(await upstream(name), { "x-api-key": "k" });
    if ("error" in cred) throw new Error(cred.error);

    const edit = await (await get(`/admin/services/${name}`)).text();
    expect(edit).toContain(`value="https://api.acme.example"`);
    expect((await post(`/admin/services/${name}`, headerService(name, "https://other.example"))).status).toBe(303);
    forgetRegistry();
    expect(await vaultFor(env, "user-2").headers(cred.id, await upstream(name))).toEqual({ error: "reconnect" });
  });

  it("refuses to call the upstream without a key when an edit renames the header", async () => {
    const name = unique("renamed");
    await post("/admin/services", headerService(name));
    forgetRegistry();
    const cred = await vaultFor(env, "user-5").add(await upstream(name), { "x-api-key": "k" });
    if ("error" in cred) throw new Error(cred.error);
    const { token } = await signToken(env.SIGNING_KEY, BASE, "api", "user-5", { creds: { [name]: cred.id } }, 60);
    const call = () => SELF.fetch(`${BASE}/api/${name}/graphql`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

    expect(await (await get(`/admin/services/${name}`)).text()).toContain("ヘッダー名を変えたり足したりすると");
    await post(`/admin/services/${name}`, { ...headerService(name), h_name_0: "x-api-token" });
    forgetRegistry();
    const refused = await call();
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain("no value for header x-api-token");

    await post(`/admin/services/${name}`, headerService(name));
    forgetRegistry();
    const restored = await call();
    expect(((await restored.json()) as { headers: Record<string, string> }).headers["x-api-key"]).toBe("k");
    expect(await vaultFor(env, "user-5").get(cred.id)).not.toHaveProperty("needsReconnect");
  });

  it("keeps an OAuth client's secret unless a new one is entered", async () => {
    const name = unique("oauth");
    const fields = {
      name,
      base_url: "https://api.oauth.example",
      auth_type: "oauth2",
      authorization_url: "https://auth.oauth.example/authorize",
      token_url: "https://auth.oauth.example/token",
      scope: "read",
      authorize_params: "access_type=offline",
      client_id: "cid",
      client_secret: "",
    };
    expect(await (await post("/admin/services", fields)).text()).toContain("クライアントシークレットを入れてください");
    expect((await post("/admin/services", { ...fields, client_secret: "s1" })).status).toBe(303);

    expect((await post(`/admin/services/${name}`, { ...fields, scope: "read write" })).status).toBe(303);
    forgetRegistry();
    const kept = await upstream(name);
    expect(kept.client).toEqual({ id: "cid", secret: "s1" });
    expect(kept.config.auth).toMatchObject({ scope: "read write", authorize_params: { access_type: "offline" } });
    expect(await (await get(`/admin/services/${name}`)).text()).not.toContain("s1");

    expect(kept.config.auth).not.toHaveProperty("client_auth");

    expect((await post(`/admin/services/${name}`, { ...fields, client_auth_basic: "on" })).status).toBe(303);
    forgetRegistry();
    expect((await upstream(name)).config.auth).toMatchObject({ client_auth: "basic" });
    expect(await (await get(`/admin/services/${name}`)).text()).toMatch(/name="client_auth_basic" checked/);

    expect(await (await post(`/admin/services/${name}`, { ...fields, client_id: "cid-2" })).text()).toContain("クライアントシークレットを入れてください");
    expect(await (await get("/admin/services/new")).text()).toContain(`<code>${BASE}/connect/callback</code>`);
    expect(await (await get("/connections/new", "user-3")).text()).toContain(`href="/connections/new/${name}"`);
  });

  it("registers a client_credentials service that only the Background entrypoint uses", async () => {
    const name = unique("graph-app");
    const fields = {
      name,
      display_name: "共有の箱",
      base_url: "https://graph.microsoft.com",
      auth_type: "client_credentials",
      cc_token_url: "https://login.app.example/token",
      cc_scope: "https://graph.microsoft.com/.default",
      cc_client_id: "murmur-app-client",
      cc_client_secret: "",
      // The OAuth 2.0 fieldset's inputs are sent too; they must not count.
      client_id: "other",
      client_secret: "other-secret",
    };
    expect(await (await post("/admin/services", fields)).text()).toContain("クライアントシークレットを入れてください");
    expect((await post("/admin/services", { ...fields, cc_client_secret: "murmur-app-secret" })).status).toBe(303);
    forgetRegistry();
    expect((await upstream(name)).client).toEqual({ id: "murmur-app-client", secret: "murmur-app-secret" });

    const list = await (await get("/admin/services")).text();
    expect(list).toContain("OAuth 2.0(client credentials)");
    expect(list).toContain("Background の入口から使います");
    const edit = await (await get(`/admin/services/${name}`)).text();
    expect(edit).toContain(`value="https://login.app.example/token"`);
    expect(edit).not.toContain("murmur-app-secret");
    expect((await post(`/admin/services/${name}`, fields)).status).toBe(303);
    forgetRegistry();
    expect((await upstream(name)).client?.secret).toBe("murmur-app-secret");

    expect(await (await get("/connections/new", "user-6")).text()).not.toContain(`/connections/new/${name}"`);
    expect((await get(`/connections/new/${name}`, "user-6")).status).toBe(404);
    const background = (exports as unknown as { Background: Fetcher }).Background;
    const res = await background.fetch(`https://gateway/${name}/v1.0/users`);
    expect(((await res.json()) as { headers: Record<string, string> }).headers.authorization).toMatch(/^Bearer app-token-/);
  });

  it("deletes a service after asking", async () => {
    const name = unique("gone");
    await post("/admin/services", headerService(name));
    expect(await (await get(`/admin/services/${name}/delete`)).text()).toContain("削除しますか?");
    const res = await post(`/admin/services/${name}/delete`, {});
    expect(res.headers.get("location")).toBe(`/admin/services?deleted=${name}`);
    expect((await get(`/admin/services/${name}`)).status).toBe(404);
    expect(await (await get("/connections/new", "user-4")).text()).not.toContain(`/connections/new/${name}"`);
  });

  it("lets a definition in SERVICES win over one with the same name", async () => {
    await post("/admin/services", headerService("murmur", "https://elsewhere.example"));
    forgetRegistry();
    expect((await upstream("murmur")).config.auth.type).toBe("identity");
    expect(await (await get("/admin/services")).text()).toContain("設定ファイルの定義が優先されています");
  });
});

describe("OAuth clients of built-in and SERVICES services", () => {
  it("lists them, grouped by client, with where each comes from", async () => {
    const page = await (await get("/admin/services")).text();
    expect(page).toContain("OAuth のクライアント");
    expect(page).toContain(`href="/admin/clients/google"`);
    expect(page).toContain(`href="/admin/clients/x"`);
    expect(page).toContain("Shared A、Shared B");
    // Admin-registered services keep their own client on their own form.
    expect(page).not.toMatch(/href="\/admin\/clients\/(acme|oauth)-/);
    expect((await get("/admin/clients/google")).status).toBe(200);
    expect((await get("/admin/clients/nope")).status).toBe(404);
    expect((await get("/admin/clients/google", "someone")).status).toBe(404);
  });

  it("offers the services once an admin sets the client, keeps the secret, and removes it again", async () => {
    expect(await (await get("/connections/new", "user-c1")).text()).not.toContain(`href="/connections/new/shared-a"`);
    expect(await (await post("/admin/clients/shared-oauth", { client_id: "cid", client_secret: "" })).text()).toContain("クライアントシークレットを入れてください");
    expect((await post("/admin/clients/shared-oauth", { client_id: "cid", client_secret: "s1" }, ADMIN, "https://evil.example")).status).toBe(403);

    expect((await post("/admin/clients/shared-oauth", { client_id: "cid", client_secret: "s1" })).status).toBe(303);
    forgetRegistry();
    const directory = await getDirectory(env);
    expect(directory.client("shared-a")).toEqual({ id: "cid", secret: "s1" });
    expect(directory.client("shared-b")).toEqual({ id: "cid", secret: "s1" });
    expect(directory.clientSource("shared-a")).toBe("admin");
    const offered = await (await get("/connections/new", "user-c1")).text();
    expect(offered).toContain(`href="/connections/new/shared-a"`);
    expect(offered).toContain(`href="/connections/new/shared-b"`);

    // An empty secret keeps the stored one for the same ID, but not for a new ID.
    expect((await post("/admin/clients/shared-oauth", { client_id: "cid", client_secret: "" })).status).toBe(303);
    forgetRegistry();
    expect((await getDirectory(env)).client("shared-a")).toEqual({ id: "cid", secret: "s1" });
    expect(await (await post("/admin/clients/shared-oauth", { client_id: "cid-2", client_secret: "" })).text()).toContain("クライアントシークレットを入れてください");
    const form = await (await get("/admin/clients/shared-oauth")).text();
    expect(form).toContain(`value="cid"`);
    expect(form).not.toContain("s1");
    expect(form).toContain(`${BASE}/connect/callback`);

    expect((await post("/admin/clients/shared-oauth/delete", {})).status).toBe(303);
    forgetRegistry();
    expect((await getDirectory(env)).client("shared-a")).toBeNull();
    expect(await (await get("/connections/new", "user-c1")).text()).not.toContain(`href="/connections/new/shared-a"`);
    expect((await post("/admin/clients/shared-oauth/delete", {})).status).toBe(404);
  });

  it("leaves a client set by a deployment secret alone", async () => {
    const page = await (await get("/admin/clients/freee")).text();
    expect(page).toContain("OAUTH_FREEE_CLIENT_*");
    expect(page).not.toContain(`name="client_id"`);
    expect((await post("/admin/clients/freee", { client_id: "other", client_secret: "other" })).status).toBe(409);
    forgetRegistry();
    expect((await getDirectory(env)).clientSource("freee")).toBe("secret");
  });
});
