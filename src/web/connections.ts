import { organizationName, publicUrl, type ServiceConfig, type Services } from "../config";
import { randomToken, s256 } from "../crypto";
import { getDirectory, getServices, getUpstream, type Directory } from "../services";
import { signToken, verifyToken } from "../tokens";
import { exchangeCode, upstreamAuthorizationUrl, UpstreamOAuthError } from "../upstream-oauth";
import { ALREADY_CONNECTED, vaultFor, type CredentialInfo } from "../vault";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { featureRows } from "./features";
import { grantRows, listGrants } from "./grants";
import { Html, html } from "./html";
import { page } from "./layout";
import { cookie, isAdmin, LOGIN_TTL_SECONDS, readCookie, redirect, sameOrigin, session, type Session } from "./session";

export const CONNECT_CALLBACK_PATH = "/connect/callback";
const CONNECT_COOKIE = "__Host-gw-connect";

// Providers listed first on the service picker, in this order; the rest follow.
const PROVIDER_ORDER = ["Google", "Microsoft", "freee"];
const OTHER_PROVIDER = "その他";

const addedOn = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });

function displayName(services: Services, service: string): string {
  return (Object.hasOwn(services, service) && services[service].display_name) || service;
}

function howToConnect(config: ServiceConfig): string {
  return config.auth.type === "oauth2" ? "アカウントでサインイン" : "API キーを入力";
}

// Services a user can add from the picker: identity services need nothing, and an
// OAuth service is offered only once the gateway has its client.
function addable(directory: Directory): [string, ServiceConfig][] {
  return Object.entries(directory.services).filter(([name, config]) => config.auth.type !== "identity" && directory.available(name));
}

export function masthead(env: Env, user: Session): Html {
  return html`<header class="masthead"><a class="home" href="/">Heddleway · ${organizationName(env)}</a>
<div class="who"><a href="/setup">Claude につなぐ</a>${isAdmin(env, user) && html`<a href="/admin/services">接続先の管理</a><a href="/admin/plugins">プラグインの配布</a>`}<span>${user.name}</span><form method="post" action="/logout"><button class="quiet">サインアウト</button></form></div></header>`;
}

function notice(url: URL, credentials: CredentialInfo[], services: Services): Html | false {
  const find = (key: string) => {
    const id = url.searchParams.get(key);
    return id ? credentials.find((c) => c.id === id) : undefined;
  };
  const added = find("added");
  if (added) return html`<p class="notice" role="status">${displayName(services, added.service)} をつなぎました。</p>`;
  const reconnected = find("reconnected");
  if (reconnected) return html`<p class="notice" role="status">${displayName(services, reconnected.service)} をつなぎ直しました。</p>`;
  if (url.searchParams.has("deleted")) return html`<p class="notice" role="status">接続を削除しました。</p>`;
  if (url.searchParams.has("revoked")) return html`<p class="notice" role="status">アプリのアクセスを取り消しました。</p>`;
  if (url.searchParams.has("disabled")) return html`<p class="notice" role="status">機能を無効にしました。</p>`;
  return false;
}

// `duplicated`: the user connected this service more than once before one account per
// service (docs/adr/0004); they keep working until the user deletes the extra ones.
function connectionRow(c: CredentialInfo, services: Services, duplicated = false): Html {
  // An OAuth connection is reconnected in place; one with an API key is deleted and added again.
  const oauth = Object.hasOwn(services, c.service) && services[c.service].auth.type === "oauth2";
  // An OAuth connection can always be reconnected in place (same credential ID), e.g. after the
  // gateway asks for more permissions: deleting and adding it again would change the ID that
  // other apps (Murmur's data sources) hold.
  const reconnect = (label: string, quiet: boolean) =>
    html`<form method="post" action="/connect"><input type="hidden" name="service" value="${c.service}"><input type="hidden" name="credential" value="${c.id}"><button${quiet ? new Html(' class="quiet"') : ''}>${label}</button></form>`;
  const status = c.needsReconnect
    ? oauth
      ? html`<span class="badge broken">再接続が必要</span>${reconnect("つなぎ直す", false)}`
      : html`<span class="badge broken">使えなくなりました。削除して追加し直してください</span>`
    : oauth && reconnect("つなぎ直す", true);
  const extra = duplicated && html`<span class="badge broken">1 つのサービスにつなげるのは 1 つだけになりました。使わないほうを削除してください</span>`;
  return html`<li id="c-${c.id}">
<div class="row-main"><p class="row-title">${displayName(services, c.service)}</p><p class="row-sub">${c.label !== displayName(services, c.service) && html`${c.label} · `}${addedOn.format(c.createdAt)}に追加</p></div>
<div class="row-actions">${status}${extra}<a class="button quiet" href="/connections/${c.id}/delete">削除</a></div>
</li>`;
}

function identityRow(config: ServiceConfig): Html {
  return html`<li>
<div class="row-main"><p class="row-title">${config.display_name}</p><p class="row-sub">サインイン中のあなたとしてつながります</p></div>
<div class="row-actions"><span class="badge">登録不要</span></div>
</li>`;
}

export async function home(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const services = await getServices(env);
  const credentials = await vaultFor(env, user.sub).list();
  const identity = Object.values(services).filter((config) => config.auth.type === "identity");
  const duplicated = new Set(credentials.filter((c, i) => credentials.findIndex((d) => d.service === c.service) !== i).map((c) => c.service));
  const rows = [...credentials.map((c) => connectionRow(c, services, duplicated.has(c.service))), ...identity.map(identityRow)];
  const grants = await listGrants(env, user.sub);
  const featureSection = await featureRows(env, user.sub);
  return page(
    `Heddleway · ${organizationName(env)}`,
    html`${masthead(env, user)}
${notice(new URL(request.url), credentials, services)}
${grants.length === 0 && html`<div class="card start"><p><strong>はじめに、Claude にこのゲートウェイをつなぎます。</strong>コネクタの URL と、スキル(プラグイン)のダウンロードは「Claude につなぐ」にあります。</p><a class="button" href="/setup">Claude につなぐ</a></div>`}
<div class="section-head"><h1>つないだサービス</h1><a class="button" href="/connections/new">接続を追加</a></div>
<p>Claude が仕事で使うサービスの接続を、ここで管理します。パスワードやキーは暗号化して保管され、Claude には渡りません。</p>
${rows.length > 0
  ? html`<ul class="list">${rows}</ul>`
  : html`<p class="empty">つながっているサービスはまだありません。<a href="/connections/new">接続を追加</a>から始めてください。</p>`}
${featureSection}
<h2>アクセスを許可したアプリ</h2>
<p>Claude やトピック索引など、あなたがサインインして許可したアプリです。取り消すと、そのアプリはここでつないだサービスを使えなくなります。</p>
${grantRows(grants)}
<details class="account"><summary>アカウントの情報</summary><p>ユーザー ID: <code>${user.sub}</code></p><p>管理者を設定するときに使います。</p></details>`,
  );
}

export async function chooseService(request: Request, env: Env): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const directory = await getDirectory(env);
  const services = directory.services;
  const credentials = await vaultFor(env, user.sub).list();
  const groups = new Map<string, [string, ServiceConfig][]>();
  for (const entry of addable(directory)) {
    const provider = entry[1].provider ?? OTHER_PROVIDER;
    groups.set(provider, [...(groups.get(provider) ?? []), entry]);
  }
  const rank = (p: string) => (PROVIDER_ORDER.includes(p) ? PROVIDER_ORDER.indexOf(p) : p === OTHER_PROVIDER ? Infinity : PROVIDER_ORDER.length);
  const ordered = [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, "ja"));
  const sections = ordered.map(([provider, entries]) => {
    const items = entries.map(([name, config]) => {
      const connected = credentials.some((c) => c.service === name);
      const search = [name, config.display_name, provider].join(" ").toLowerCase();
      return html`<li data-search="${search}"><a href="/connections/new/${name}">
<span class="row-main"><span class="row-title">${config.display_name}</span><span class="row-sub">${howToConnect(config)}${connected ? " · つないでいます" : ""}</span></span>
<span class="chevron" aria-hidden="true">›</span></a></li>`;
    });
    return html`<section class="group"><h2>${provider}</h2><ul class="list choices">${items}</ul></section>`;
  });
  return page(
    "接続を追加",
    html`${masthead(env, user)}
<a class="back" href="/">‹ つないだサービスに戻る</a>
<h1>接続を追加</h1>
<p>つなぐサービスを選んでください。1 つのサービスにつなげるアカウントは 1 つです。別の組織のアカウントは、その組織のゲートウェイでつなぎます。</p>
<label class="filter" hidden>サービスを絞り込む<input type="search" id="filter" autocomplete="off" placeholder="例: Gmail、freee"></label>
${sections.length > 0 ? sections : html`<p class="empty">追加できるサービスがありません。管理者に連絡してください。</p>`}
<p class="empty" id="no-match" hidden>一致するサービスがありません。</p>
<script src="/assets/app.js" defer></script>`,
  );
}

export async function connectForm(request: Request, env: Env, service: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const directory = await getDirectory(env);
  const services = directory.services;
  const entry = addable(directory).find(([name]) => name === service);
  if (!entry) return errorPage("サービスが見つかりません", `「${service}」はつなげるサービスの一覧にありません。`, 404, ["/connections/new", "サービスの選択に戻る"]);
  const [, config] = entry;
  const name = config.display_name ?? service;
  const existing = (await vaultFor(env, user.sub).list()).find((c) => c.service === service);
  if (existing) return alreadyConnectedPage(env, user, services, existing);
  const label = html`<input type="hidden" name="service" value="${service}">
<p class="hint">${organizationName(env)} のアカウントをつなぎます。別の組織のアカウントは、その組織のゲートウェイでつなぎます。</p>`;
  const auth = config.auth;
  const form =
    auth.type === "oauth2"
      ? html`<form method="post" action="/connect" class="card">
<p class="hint">${name} のサインイン画面に移ります。許可すると、ここに戻ってきます。</p>
${label}
<button>${name} にサインインしてつなぐ</button>
</form>`
      : auth.type === "headers"
        ? html`<form method="post" action="/credentials" class="card">
<p class="hint">${name} の管理画面で発行した値を入力します。</p>
${label}
${auth.headers.map((h) => html`<label>${h.label}<input type="password" name="h:${h.name.toLowerCase()}" required autocomplete="off"></label>`)}
<button>保存してつなぐ</button>
</form>`
        : auth.type === "basic"
          ? html`<form method="post" action="/credentials" class="card">
<p class="hint">${name} の管理画面で発行した値を入力します。</p>
${label}
${auth.username === undefined && html`<label>${auth.username_label ?? "ユーザー名"}<input type="text" name="h:username" required autocomplete="off"></label>`}
<label>${auth.password_label ?? "パスワード"}<input type="password" name="h:password" required autocomplete="off"></label>
<button>保存してつなぐ</button>
</form>`
          : false;
  return page(
    `${name} をつなぐ`,
    html`${masthead(env, user)}
<a class="back" href="/connections/new">‹ サービスの選択に戻る</a>
<h1>${name} をつなぐ</h1>
${form}`,
  );
}

// Shown instead of the form when the service is already connected: one account per service.
function alreadyConnectedPage(env: Env, user: Session, services: Services, credential: CredentialInfo): Response {
  const name = displayName(services, credential.service);
  const oauth = Object.hasOwn(services, credential.service) && services[credential.service].auth.type === "oauth2";
  const action = oauth
    ? html`<form method="post" action="/connect"><input type="hidden" name="service" value="${credential.service}"><input type="hidden" name="credential" value="${credential.id}"><button>つなぎ直す</button></form>`
    : html`<a class="button" href="/connections/${credential.id}/delete">削除する</a>`;
  return page(
    `${name} をつなぐ`,
    html`${masthead(env, user)}
<a class="back" href="/connections/new">‹ サービスの選択に戻る</a>
<h1>${name} はつないでいます</h1>
<div class="card">
<p>1 つのサービスにつなげるアカウントは 1 つです。${oauth ? "別のアカウントに替えるときは、つなぎ直して、そのアカウントで許可してください。" : "別のキーに替えるときは、いまの接続を削除してから追加してください。"}</p>
<p>別の組織のアカウントは、その組織のゲートウェイでつなぎます。</p>
<div class="actions">${action}<a class="button quiet" href="/">つないだサービスに戻る</a></div>
</div>`,
  );
}

export async function addCredential(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const form = await request.formData();
  const secrets: Record<string, string> = {};
  for (const [key, value] of form) {
    if (key.startsWith("h:") && typeof value === "string") secrets[key.slice(2)] = value;
  }
  const service = String(form.get("service") ?? "");
  const upstream = await getUpstream(env, service);
  if (!upstream) return errorPage("保存できませんでした", `unknown service: ${service}`, 400);
  const result = await vaultFor(env, user.sub).add(upstream, secrets);
  if ("error" in result) {
    if (result.error === ALREADY_CONNECTED) return redirect(`/connections/new/${service}`);
    return errorPage("保存できませんでした", result.error, 400, [`/connections/new/${service}`, "入力に戻る"]);
  }
  return redirect(`/?added=${result.id}`);
}

export async function confirmDelete(request: Request, env: Env, id: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const credential = await vaultFor(env, user.sub).get(id);
  if (!credential) return redirect("/");
  const services = await getServices(env);
  return page(
    "接続の削除",
    html`${masthead(env, user)}
<a class="back" href="/">‹ つないだサービスに戻る</a>
<h1>「${credential.label}」を削除しますか?</h1>
<form method="post" action="/credentials/${credential.id}/delete" class="card">
<p>${displayName(services, credential.service)} の接続です。削除すると、Claude からこの接続を使えなくなります。使うときは、もう一度つなぎ直してください。</p>
<div class="actions"><button class="danger">削除する</button><a class="button quiet" href="/">やめる</a></div>
</form>`,
  );
}

export async function deleteCredential(request: Request, env: Env, id: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  await vaultFor(env, user.sub).remove(id);
  return redirect("/?deleted=1");
}

function errorPage(title: string, message: string, status: number, [href, text] = ["/", "つないだサービスに戻る"]): Response {
  return page(title, html`<div class="card"><h1>${title}</h1><p>${message}</p><p><a href="${href}">${text}</a></p></div>`, undefined, status);
}

type PendingConnect = {
  verifier: string;
  user: string;
  service: string;
  credential?: string;
};

export async function connectStart(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const form = await request.formData();
  const service = String(form.get("service") ?? "");
  const upstream = await getUpstream(env, service);
  const auth = upstream?.config.auth;
  if (!upstream || auth?.type !== "oauth2") return errorPage("つなげませんでした", `このサービスはサインインでつなぐ方式ではありません: ${service}`, 400);
  const { config, client } = upstream;
  if (!client) return errorPage("つなげませんでした", `${config.display_name} につなぐための設定がまだありません。管理者に連絡してください。`, 500);
  const credential = String(form.get("credential") ?? "") || undefined;
  if (credential && (await vaultFor(env, user.sub).get(credential))?.service !== service) {
    return errorPage("つなげませんでした", "つなぎ直そうとした接続が見つかりません。一覧から新しく追加してください。", 400);
  }

  const state = randomToken();
  const verifier = randomToken();
  if (!credential && (await vaultFor(env, user.sub).list()).some((c) => c.service === service)) return redirect(`/connections/new/${service}`);
  const pending: PendingConnect = { verifier, user: user.sub, service, credential };
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "connect", state, { ...pending }, LOGIN_TTL_SECONDS);
  const location = upstreamAuthorizationUrl(auth, client, {
    redirectUri: `${publicUrl(env)}${CONNECT_CALLBACK_PATH}`,
    state,
    codeChallenge: await s256(verifier),
  });
  return redirect(location, new Headers({ "set-cookie": cookie(CONNECT_COOKIE, token, LOGIN_TTL_SECONDS) }));
}

export async function connectCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const user = await session(request, env);
  const stored = readCookie(request, CONNECT_COOKIE);
  const pending = stored
    ? await verifyToken<PendingConnect>(env.SIGNING_KEY, publicUrl(env), "connect", stored)
    : null;
  if (!user || !pending || pending.sub !== params.get("state") || pending.user !== user.sub) {
    return errorPage("つなげませんでした", "時間がたちすぎたか、別のタブで操作した可能性があります。一覧からもう一度つないでください。", 400);
  }
  const code = params.get("code");
  const upstream = await getUpstream(env, pending.service);
  const config = upstream?.config;
  const displayName = config?.display_name ?? pending.service;
  if (!code) return errorPage("つなげませんでした", `${displayName} で許可されませんでした。つなぐ場合は、もう一度やり直して許可してください。`, 400);
  const client = upstream?.client;
  if (!upstream || config?.auth.type !== "oauth2" || !client) return errorPage("つなげませんでした", `${displayName} の設定が変わりました。管理者に連絡してください。`, 500);

  try {
    const tokens = await exchangeCode(config.auth, client, {
      code,
      verifier: pending.verifier,
      redirectUri: `${publicUrl(env)}${CONNECT_CALLBACK_PATH}`,
    });
    const result = await vaultFor(env, user.sub).addOAuth(upstream, tokens, pending.credential);
    if ("error" in result && result.error === ALREADY_CONNECTED) {
      return errorPage("つなげませんでした", `${displayName} はもうつないでいます。1 つのサービスにつなげるアカウントは 1 つです。`, 409);
    }
    if ("error" in result) return errorPage("つなげませんでした", result.error, 400);
    const notice = pending.credential ? `reconnected=${result.id}` : `added=${result.id}`;
    return redirect(`/?${notice}`, new Headers({ "set-cookie": cookie(CONNECT_COOKIE, "", 0) }));
  } catch (error) {
    if (!(error instanceof UpstreamOAuthError)) throw error;
    console.warn(JSON.stringify({ type: "connect_failed", service: pending.service, reason: error.message }));
    return errorPage("つなげませんでした", `${displayName} との接続を完了できませんでした。しばらくしてからやり直し、続くときは管理者に連絡してください。`, 502);
  }
}
