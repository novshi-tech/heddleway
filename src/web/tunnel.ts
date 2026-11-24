import { organizationName } from "../config";
import { registryFor } from "../registry";
import {
  callableServices,
  callbackAllowed,
  getOwned,
  hashCode,
  listOwned,
  nameInUse,
  OWNER_PAIR_PATH,
  pairingAllowed,
  POLL_TTL_MS,
  removeService,
  tunnelEnabled,
  setCallback,
  validName,
  type OwnedService,
  type Pairing,
  type TunnelService,
} from "../tunnel";
import { connectionFor, type ConnectionStatus } from "../tunnel-connection";
import { admin } from "./admin";
import { masthead } from "./connections";
import { Html, html } from "./html";
import { page } from "./layout";
import { isAdmin, redirect, sameOrigin, session, type Session } from "./session";

// The owner's side of tunnel connections (docs/adr/0003 decision 3): entering the code a
// local service shows, approving it as one's own, and seeing and removing one's services.
// Admins see every service of the deployment and can remove any.

const at = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

function statusText(status: ConnectionStatus): Html {
  if (status.connected) return html`<span class="badge">接続中</span>`;
  if (status.disconnectedAt) return html`<span class="badge">${at.format(status.disconnectedAt)}に切断</span>`;
  return html`<span class="badge">まだつないでいません</span>`;
}

function subline(service: TunnelService, status: ConnectionStatus, withOwner: boolean): string {
  const parts = [`${at.format(service.createdAt)}にペアリング`];
  if (service.mode === "strict") parts.push("厳しめのモード");
  if (status.connectedAt) parts.push(`最後につないだのは${at.format(status.connectedAt)}`);
  if (status.version) parts.push(`版 ${status.version}`);
  if (withOwner) parts.unshift(`所有者: ${service.ownerName}(${service.owner})`);
  return parts.join(" · ");
}

function callbackText(env: Env, service: TunnelService): string {
  if (!callbackAllowed(env)) return "";
  const chosen = service.callback ?? [];
  return chosen.length > 0 ? `呼び返せるサービス: ${chosen.join("、")}` : "呼び返しなし";
}

function serviceRow(env: Env, { service, status }: OwnedService, withOwner = false): Html {
  const callback = callbackText(env, service);
  return html`<li id="r-${service.id}">
<div class="row-main"><p class="row-title">${service.name}</p><p class="row-sub">${subline(service, status, withOwner)}</p>${callback && html`<p class="row-sub">${callback}</p>`}</div>
<div class="row-actions">${statusText(status)}${!withOwner && callbackAllowed(env) && html`<a class="button quiet" href="/local-services/${service.id}">呼び返しの設定</a>`}<a class="button quiet" href="/local-services/${service.id}/delete">削除</a></div>
</li>`;
}

// Checkboxes for the services a local service may call back as its owner; none checked at first.
async function callbackFieldset(env: Env, owner: string, chosen: string[]): Promise<Html | false> {
  if (!callbackAllowed(env)) return false;
  const callable = await callableServices(env, owner);
  return html`<fieldset><legend>このサービスから呼び返せるサービス</legend>
<p class="hint">チェックしたサービスだけ、このサービスがあなたとして呼べます。鍵はサービスのプロセスが持ち、エージェントには見せないようにしてください。要らなければ、何もチェックしません。</p>
${callable.length > 0
  ? callable.map((c) => html`<label class="choice"><input type="checkbox" name="callback" value="${c.service}"${chosen.includes(c.service) ? new Html(" checked") : ""}> ${c.displayName} <code>${c.service}</code></label>`)
  : html`<p class="hint">選べるサービスがありません(つないだサービスがまだありません)。</p>`}
</fieldset>`;
}


// The home page's section; nothing when the deployment has no tunnel connections.
export async function tunnelSection(env: Env, user: Session): Promise<Html | false> {
  if (!tunnelEnabled(env)) return false;
  const owned = await listOwned(env, user.sub);
  if (owned.length === 0 && !pairingAllowed(env)) return false;
  return html`<h2>ローカルサービス</h2>
<p>あなたの PC や、あなたが置いたコンテナで動くサービスです。サービスのほうからゲートウェイにつなぎに来るので、手元に入口を開けずに、Claude からその API を呼べます。呼べるのはあなただけです。</p>
${owned.length > 0 ? html`<ul class="list">${owned.map((o) => serviceRow(env, o))}</ul>` : html`<p class="empty">ペアリングしたローカルサービスはありません。</p>`}
${pairingAllowed(env) && html`<p><a class="button quiet" href="${OWNER_PAIR_PATH}">ペアリングのコードを入力</a></p>`}`;
}

function codeForm(env: Env, user: Session, code = "", error?: string, status = 200): Response {
  return page(
    "ローカルサービスをペアリング",
    html`${masthead(env, user)}
<a class="back" href="/">‹ つないだサービスに戻る</a>
<h1>ローカルサービスをペアリング</h1>
${error && html`<p class="error" role="alert">${error}</p>`}
<form method="get" action="${OWNER_PAIR_PATH}" class="card">
<p>ローカルサービスが表示したコード(<code>XXXX-XXXX</code>)を入力してください。コードは 5 分で切れ、1 回だけ使えます。</p>
<label>ペアリングのコード<input type="text" name="code" value="${code}" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
<div class="actions"><button>次へ</button></div>
</form>`,
    undefined,
    status,
  );
}

// The owner's service of this name, which approving would replace (pairing again after a
// restart in strict mode, a new machine, a lost key).
async function ownedByName(env: Env, owner: string, name: string): Promise<TunnelService | undefined> {
  return (await registryFor(env).listTunnel()).find((s) => s.owner === owner && s.name === name);
}

async function confirmPage(env: Env, user: Session, code: string, pairing: Pairing, name: string, error?: string, status = 200, chosen?: string[]): Promise<Response> {
  const existing = await ownedByName(env, user.sub, name);
  // Replacing starts with nothing chosen, like a new pairing: the code may come from someone
  // else, and the owner picks again what the new key may call.
  const fieldset = await callbackFieldset(env, user.sub, chosen ?? []);
  return page(
    "ローカルサービスをペアリング",
    html`${masthead(env, user)}
<a class="back" href="${OWNER_PAIR_PATH}">‹ コードの入力に戻る</a>
<h1>このサービスを、あなたのローカルサービスとしてつなぎますか?</h1>
${error && html`<p class="error" role="alert">${error}</p>`}
<form method="post" action="${OWNER_PAIR_PATH}" class="card">
<input type="hidden" name="code" value="${code}">
${pairing.description && html`<p class="hint">サービスからの説明(サービスが書いたものです):</p><p>${pairing.description}</p>`}
<p class="hint">鍵の指紋: <code>${pairing.thumbprint}</code>。サービスが表示した指紋と同じか確かめてください。</p>
${pairing.mode === "strict" && html`<p class="hint">厳しめのモードです。サービスはディスクに鍵を置かず、再起動したり長く切れたりしたあとは、ペアリングし直します。</p>`}
<label>サービスの名前(Claude からは <code>/api/&lt;名前&gt;/...</code> で呼びます)<input type="text" name="name" value="${name}" pattern="[a-z0-9][a-z0-9\\-]*" maxlength="40" required></label>
<p>つなぐと、${organizationName(env)} のゲートウェイを通して、あなた(だけ)が Claude からこのサービスの API を呼べるようになります。${fieldset ? "このサービスからは、下でチェックしたサービスだけを、あなたとして呼べます。" : "このサービスから、あなたの接続(ほかのサービス)を使うことはできません。"}</p>
${fieldset}
${existing && html`<fieldset><p>あなたのローカルサービス「${existing.name}」(${at.format(existing.createdAt)}にペアリング)が、もうあります。つなぐと、このサービスで置き換えます。古い鍵は使えなくなり、いまの接続は切れます。Claude から呼ぶときの接続の ID は変わりません。</p>
<p class="hint">いまの鍵の指紋: <code>${existing.thumbprint}</code><br>新しい鍵の指紋: <code>${pairing.thumbprint}</code></p>
<label class="choice"><input type="checkbox" name="replace" value="${existing.id}"> 自分でローカルサービスを入れ直したので、「${existing.name}」を置き換える</label></fieldset>`}
<p class="hint">自分で起動したサービスのコードだけを承認してください。覚えのないコードなら、断ってください。</p>
<div class="actions"><button name="decision" value="approve">つなぐ</button><button class="quiet" name="decision" value="deny">断る</button></div>
</form>`,
    undefined,
    status,
  );
}

function closedPage(env: Env, user: Session): Response {
  return page(
    "ローカルサービスをペアリング",
    html`${masthead(env, user)}<div class="card"><h1>ペアリングはできません</h1><p>このゲートウェイでは、管理者がローカルサービスのペアリングを止めています。</p><p><a href="/">つないだサービスに戻る</a></p></div>`,
    undefined,
    403,
  );
}

// GET /pair[?code=...]
export async function pairPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const user = await session(request, env);
  if (!user) return redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  if (!pairingAllowed(env)) return closedPage(env, user);
  const code = (url.searchParams.get("code") ?? "").trim();
  if (!code) return codeForm(env, user);
  const pairing = await registryFor(env).getPairing(await hashCode(code));
  if (!pairing) return codeForm(env, user, code, "コードが見つからないか、切れています。ローカルサービスでもう一度ペアリングを始めてください。", 404);
  return confirmPage(env, user, code, pairing, pairing.name);
}

// POST /pair: approve or deny the code.
export async function pairSubmit(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  if (!pairingAllowed(env)) return closedPage(env, user);
  const form = await request.formData();
  const code = String(form.get("code") ?? "").trim();
  const codeHash = await hashCode(code);
  const registry = registryFor(env);
  const pairing = await registry.getPairing(codeHash);
  if (!pairing) return codeForm(env, user, code, "コードが見つからないか、切れています。ローカルサービスでもう一度ペアリングを始めてください。", 404);

  if (form.get("decision") !== "approve") {
    await registry.decidePairing(codeHash, "deny", POLL_TTL_MS);
    console.log(JSON.stringify({ type: "tunnel_pairing_denied", user: user.sub }));
    return redirect("/?pairing_denied=1");
  }
  const name = String(form.get("name") ?? "").trim();
  const wanted = form.getAll("callback").map(String);
  if (!validName(name)) return confirmPage(env, user, code, pairing, name, "名前は英小文字・数字・ハイフンで、40 文字までにしてください。", 400, wanted);
  if (await nameInUse(env, name)) return confirmPage(env, user, code, pairing, name, `「${name}」はこのゲートウェイのサービスの名前です。別の名前にしてください。`, 409, wanted);
  const callable = new Set(callbackAllowed(env) ? (await callableServices(env, user.sub)).map((c) => c.service) : []);
  const callback = [...new Set(wanted)].filter((w) => callable.has(w)).sort();
  // Replacing the owner's service of the same name takes an explicit tick.
  const existing = await ownedByName(env, user.sub, name);
  const replaces = String(form.get("replace") ?? "") || undefined;
  if (existing && replaces !== existing.id) return confirmPage(env, user, code, pairing, name, `「${name}」を置き換えるなら、置き換えるのチェックを入れてください。別のサービスなら、別の名前にしてください。`, 409, wanted);
  const decision: TunnelService = {
    id: crypto.randomUUID(),
    name,
    owner: user.sub,
    ownerName: user.name,
    publicKey: pairing.publicKey,
    thumbprint: pairing.thumbprint,
    ...(pairing.description ? { pairingDescription: pairing.description } : {}),
    callback,
    mode: pairing.mode ?? "standard",
    createdAt: Date.now(),
  };
  const result = await registry.decidePairing(codeHash, decision, POLL_TTL_MS, replaces);
  if (result.status === "name_taken") return confirmPage(env, user, code, pairing, name, `「${name}」というローカルサービスがもうあります。もう一度試してください。`, 409, wanted);
  if (result.status !== "ok" || !result.service) return codeForm(env, user, code, "コードが切れました。ローカルサービスでもう一度ペアリングを始めてください。", 404);
  const service = result.service;
  // The old key's connection and resume tokens go; the registration already names the new key,
  // so the old one is refused even before this.
  if (result.replaced) await connectionFor(env, service.id).reset(service.thumbprint);
  console.log(JSON.stringify({ type: "tunnel_paired", user: user.sub, service: service.id, name, ...(result.replaced ? { replaced: true } : {}) }));
  return redirect(`/?paired=${service.id}`);
}

// GET /local-services/<id>: the owner chooses what the service may call back.
export async function settingsPage(request: Request, env: Env, id: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const service = await getOwned(env, user.sub, id);
  if (!service) return redirect("/");
  const fieldset = await callbackFieldset(env, user.sub, service.callback ?? []);
  const saved = new URL(request.url).searchParams.has("saved");
  return page(
    `${service.name} の呼び返し`,
    html`${masthead(env, user)}
${saved && html`<p class="notice" role="status">保存しました。</p>`}
<a class="back" href="/">‹ つないだサービスに戻る</a>
<h1>「${service.name}」から呼び返せるサービス</h1>
${fieldset
  ? html`<form method="post" action="/local-services/${service.id}" class="card">${fieldset}<div class="actions"><button>保存する</button></div></form>`
  : html`<p class="empty">このゲートウェイでは、管理者が呼び返しを止めています。</p>`}`,
  );
}

export async function settingsSubmit(request: Request, env: Env, id: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  if (!callbackAllowed(env)) return redirect(`/local-services/${id}`);
  const form = await request.formData();
  const saved = await setCallback(env, user.sub, id, form.getAll("callback").map(String));
  if (!saved) return redirect("/");
  console.log(JSON.stringify({ type: "tunnel_callback_set", user: user.sub, service: id, callback: saved.callback }));
  return redirect(`/local-services/${id}?saved=1`);
}

async function findForRemoval(env: Env, user: Session, id: string): Promise<TunnelService | null> {
  if (!tunnelEnabled(env)) return null;
  if (isAdmin(env, user)) return registryFor(env).getTunnel(id);
  return getOwned(env, user.sub, id);
}

export async function confirmRemove(request: Request, env: Env, id: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const service = await findForRemoval(env, user, id);
  if (!service) return redirect("/");
  const others = service.owner !== user.sub;
  return page(
    "ローカルサービスの削除",
    html`${masthead(env, user)}
<a class="back" href="${others ? "/admin/local-services" : "/"}">‹ 戻る</a>
<h1>「${service.name}」を削除しますか?</h1>
<form method="post" action="/local-services/${service.id}/delete" class="card">
<p>${others ? `${service.ownerName} さんのローカルサービスです。` : ""}削除すると、いまの接続が切れ、このサービスはゲートウェイにつなげなくなります。使うときは、サービスの側からもう一度ペアリングします。</p>
<div class="actions"><button class="danger">削除する</button><a class="button quiet" href="${others ? "/admin/local-services" : "/"}">やめる</a></div>
</form>`,
  );
}

export async function remove(request: Request, env: Env, id: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const service = await findForRemoval(env, user, id);
  if (service) {
    await removeService(env, service.id);
    console.log(JSON.stringify({ type: "tunnel_removed", user: user.sub, owner: service.owner, service: service.id }));
    if (service.owner !== user.sub) return redirect("/admin/local-services?removed=1");
  }
  return redirect("/?local_removed=1");
}

// GET /admin/local-services: every local service of the deployment.
export async function adminPage(request: Request, env: Env): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const owned = await listOwned(env);
  const removed = new URL(request.url).searchParams.has("removed");
  return page(
    "ローカルサービスの管理",
    html`${masthead(env, user)}
${removed && html`<p class="notice" role="status">ローカルサービスを削除しました。</p>`}
<h1>ローカルサービスの管理</h1>
<p>利用者がペアリングした、トンネルでつながるサービスです。呼べるのは、それぞれの所有者だけです。所有者が退職したときなどは、ここで削除します。</p>
${!tunnelEnabled(env)
  ? html`<p class="empty">このデプロイにはトンネルの Durable Object(<code>TUNNEL</code>)がありません。</p>`
  : owned.length > 0
    ? html`<ul class="list">${owned.map((o) => serviceRow(env, o, true))}</ul>`
    : html`<p class="empty">ペアリングされたローカルサービスはありません。</p>`}
<p class="hint">${pairingAllowed(env) ? "ペアリングは許可しています。止めるときは、デプロイの設定の vars に TUNNEL_PAIRING: \"off\" を足します。" : "ペアリングは止めています(TUNNEL_PAIRING)。ペアリング済みのサービスは使えます。"}</p>
<p class="hint">${callbackAllowed(env) ? "呼び返し(ローカルサービスが所有者としてゲートウェイを呼ぶこと)は、所有者がサービスごとに選べます。止めるときは TUNNEL_CALLBACK: \"off\" を足します。" : "呼び返しは止めています(TUNNEL_CALLBACK)。"}</p>`,
  );
}
