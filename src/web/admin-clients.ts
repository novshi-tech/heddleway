import { publicUrl } from "../config";
import { registryFor } from "../registry";
import { forgetRegistry, getDirectory, type Directory } from "../services";
import { admin, audit } from "./admin";
import { CONNECT_CALLBACK_PATH, masthead } from "./connections";
import { html, type Html } from "./html";
import { page } from "./layout";
import { redirect, sameOrigin, type Session } from "./session";

// OAuth clients of built-in and SERVICES services, set from the admin screen instead of
// OAUTH_<CLIENT>_CLIENT_ID / _CLIENT_SECRET. A deployment secret, when set, still wins.

export function secretName(client: string): string {
  return `OAUTH_${client.toUpperCase().replace(/-/g, "_")}_CLIENT_*`;
}

type ClientState = "secret" | "admin" | "unset";

function stateOf(directory: Directory, services: string[]): ClientState {
  return directory.clientSource(services[0]) ?? "unset";
}

const STATE_LABELS: Record<ClientState, string> = {
  secret: "デプロイのシークレットで設定済み",
  admin: "管理画面で設定済み",
  unset: "未設定",
};

function displayNames(directory: Directory, services: string[]): string {
  return services.map((s) => directory.services[s].display_name ?? s).join("、");
}

// The section of the services page that lists the clients admins can set.
export function clientSection(directory: Directory): Html | false {
  const clients = Object.entries(directory.sharedClients());
  if (clients.length === 0) return false;
  const rows = clients.map(([name, services]) => {
    const state = stateOf(directory, services);
    return html`<li>
<div class="row-main"><p class="row-title">${name}</p><p class="row-sub">${displayNames(directory, services)}</p><p class="row-sub">${STATE_LABELS[state]}</p></div>
<div class="row-actions"><a class="button quiet" href="/admin/clients/${name}">${state === "unset" ? "設定" : "確認・変更"}</a></div>
</li>`;
  });
  return html`<h2>OAuth のクライアント</h2>
<p>組み込みと設定ファイルの OAuth の接続先は、ここでクライアント ID とシークレットを入れると利用者に表示されます。同じクライアントを使う接続先(Google の各サービスなど)はまとめて 1 つです。デプロイのシークレット(<code>OAUTH_&lt;CLIENT&gt;_CLIENT_ID</code> / <code>_CLIENT_SECRET</code>)が登録されていれば、そちらが使われます。</p>
<ul class="list">${rows}</ul>`;
}

async function lookup(env: Env, name: string): Promise<{ directory: Directory; services: string[] } | null> {
  const directory = await getDirectory(env);
  const clients = directory.sharedClients();
  return Object.hasOwn(clients, name) ? { directory, services: clients[name] } : null;
}

function clientForm(env: Env, user: Session, name: string, directory: Directory, services: string[], error?: string, status = 200): Response {
  const state = stateOf(directory, services);
  const stored = Object.hasOwn(directory.registry.sharedClients, name) ? directory.registry.sharedClients[name] : undefined;
  const body =
    state === "secret"
      ? html`<p class="card">デプロイのシークレット <code>${secretName(name)}</code> が使われています。管理画面で設定するには、先にシークレットを削除してください(<code>npm run secret -- &lt;名前&gt; delete …</code>)。${stored && "管理画面にも保存された値がありますが、使われていません。"}</p>`
      : html`<form method="post" action="/admin/clients/${name}" class="card admin-form">
<p class="hint">連携先にアプリを登録し、リダイレクト URI(コールバック URL)に <code>${publicUrl(env)}${CONNECT_CALLBACK_PATH}</code> を指定してください。手順は README の「連携先を設定する」にあります。</p>
<label>クライアント ID<input type="text" name="client_id" value="${stored?.id ?? ""}" required autocomplete="off"></label>
<label>クライアントシークレット${stored && "(変えないときは空のまま)"}<input type="password" name="client_secret" autocomplete="off"></label>
${stored && html`<p class="hint">クライアント ID を変えると、利用者がつないだ接続は使えなくなり、つなぎ直すことになります。</p>`}
<div class="actions"><button>保存する</button><a class="button quiet" href="/admin/services">やめる</a></div>
</form>
${stored && html`<form method="post" action="/admin/clients/${name}/delete" class="card">
<p>クライアントを削除すると、${displayNames(directory, services)} は利用者に表示されなくなり、つないだ接続も使えなくなります。</p>
<div class="actions"><button class="danger">削除する</button></div>
</form>`}`;
  return page(
    `${name} のクライアント`,
    html`${masthead(env, user)}
<a class="back" href="/admin/services">‹ 接続先の管理に戻る</a>
<h1>OAuth のクライアント: ${name}</h1>
${error && html`<p class="error" role="alert">${error}</p>`}
<p>使う接続先: ${displayNames(directory, services)}(${services.join(", ")})。状態: ${STATE_LABELS[state]}。</p>
${body}`,
    undefined,
    status,
  );
}

export async function editClient(request: Request, env: Env, name: string): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const found = await lookup(env, name);
  if (!found) return new Response("not found", { status: 404 });
  return clientForm(env, user, name, found.directory, found.services);
}

export async function saveClient(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  forgetRegistry();
  const found = await lookup(env, name);
  if (!found) return new Response("not found", { status: 404 });
  const { directory, services } = found;
  if (stateOf(directory, services) === "secret") return clientForm(env, user, name, directory, services, "デプロイのシークレットが使われているため、変更できません。", 409);
  const data = await request.formData();
  const id = String(data.get("client_id") ?? "").trim();
  const secret = String(data.get("client_secret") ?? "").trim();
  const stored = Object.hasOwn(directory.registry.sharedClients, name) ? directory.registry.sharedClients[name] : undefined;
  if (!id) return clientForm(env, user, name, directory, services, "クライアント ID を入れてください。", 400);
  if (!secret && stored?.id !== id) return clientForm(env, user, name, directory, services, "クライアントシークレットを入れてください。", 400);
  await registryFor(env).putSharedClient(name, { id, secret: secret || stored!.secret });
  forgetRegistry();
  audit(user, stored ? "update-client" : "create-client", name, secret ? ["id", "secret"] : ["id"]);
  return redirect(`/admin/services?saved=${encodeURIComponent(name)}`);
}

export async function deleteClient(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  if (!(await lookup(env, name)) || !(await registryFor(env).putSharedClient(name, null))) return new Response("not found", { status: 404 });
  forgetRegistry();
  audit(user, "delete-client", name);
  return redirect(`/admin/services?deleted=${encodeURIComponent(name)}`);
}
