import {
  AppDefinitionError,
  appServices,
  checkExamples,
  getApp,
  listApps,
  parseAppDefinition,
  serviceNames,
  type AppDefinition,
  type AppEntry,
  type AppPort,
} from "../apps";
import { publicUrl } from "../config";
import { registryFor } from "../registry";
import { signToken, verifyToken } from "../tokens";
import { admin, audit } from "./admin";
import { masthead } from "./connections";
import { html, type Html } from "./html";
import { page } from "./layout";
import { redirect, sameOrigin, type Session } from "./session";

// Apps (docs/adr/0008, decision 1): the admin enters the URL of an app's client metadata
// document, reads what the gateway found there, and approves it. What is stored is the
// definition shown on the confirmation page, carried in a signed token, not a second fetch.
// Registering is a person's action on this page only; no tool registers an app.

const MAX_DOCUMENT_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const APPROVAL_TTL_SECONDS = 15 * 60;

const approvedOn = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });

async function portRows(env: Env, ports: AppPort[], mark?: (p: AppPort) => string): Promise<Html> {
  const names = await serviceNames(env, ports.map((p) => p.service));
  return html`<table class="ports"><thead><tr>${mark && html`<th></th>`}<th>サービス</th><th>メソッド</th><th>パス(正規表現・全体一致)</th></tr></thead><tbody>${ports.map(
    (p, i) => html`<tr>${mark && html`<td>${mark(p)}</td>`}<td>${names[i]} <code>${p.service}</code></td><td><code>${p.method}</code></td><td><code>${p.path}</code></td></tr>`,
  )}</tbody></table>`;
}

async function listing(env: Env, user: Session, message?: Html | false, error?: string, status = 200, url = ""): Promise<Response> {
  const apps = await listApps(env);
  const rows = await Promise.all(
    apps.map(async ({ definition: d, approvedAt }) => {
      const names = await serviceNames(env, appServices(d));
      return html`<li>
<div class="row-main"><p class="row-title">${d.displayName} <code>${d.name}</code></p><p class="row-sub">${names.join("、")} · ${d.ports.length} 個の口 · ${approvedOn.format(approvedAt)}に承認</p><p class="row-sub">${d.clientId}</p></div>
<div class="row-actions"><a class="button quiet" href="/admin/apps/${d.name}/delete">登録を消す</a></div>
</li>`;
    }),
  );
  return page(
    "アプリの管理",
    html`${masthead(env, user)}
${message}
<h1>アプリの管理</h1>
<p>アプリは、決まった処理をするツール(カレンダーの同期、決まったリストの見張りなど)です。登録したアプリは、利用者が同意すると、登録した口(サービス・メソッド・パス)だけを、その人の接続で呼べます。登録することが、この組織としての了承になります。</p>
${rows.length > 0 ? html`<ul class="list">${rows}</ul>` : html`<p class="empty">登録したアプリはありません。</p>`}
<h2>アプリを登録する・定義を更新する</h2>
${error && html`<p class="error" role="alert">${error}</p>`}
<form method="post" action="/admin/apps/preview" class="card">
<label>アプリのクライアント ID(メタデータ文書の URL)<input type="url" name="client_id" value="${url}" placeholder="https://app.example/oauth/client.json" required></label>
<p class="hint">ゲートウェイが URL の文書を読み、アプリの定義(<code>heddleway_app</code>)を見せます。中身を確かめてから承認します。登録済みのアプリなら、今の定義との違いを見せます。</p>
<div class="actions"><button>読み込む</button></div>
</form>`,
    undefined,
    status,
  );
}

export async function listAppsPage(request: Request, env: Env): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const done = url.searchParams.get("saved") ?? url.searchParams.get("deleted");
  return listing(env, user, done !== null && html`<p class="notice" role="status">「${done}」を${url.searchParams.has("saved") ? "登録" : "消去"}しました。</p>`);
}

async function fetchDocument(clientId: string): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new AppDefinitionError("URL として読めません");
  }
  if (url.protocol !== "https:" || url.hash || url.username || url.password) throw new AppDefinitionError("https の URL(# や認証情報を含まないもの)を入れてください");
  let response: Response;
  try {
    // Workers support no redirect: "error"; a redirect is refused below, so the URL read is the client ID.
    response = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new AppDefinitionError("文書を取得できませんでした");
  }
  if (response.status >= 300 && response.status < 400) throw new AppDefinitionError("文書の URL がリダイレクトしました。クライアント ID そのものの URL を入れてください");
  if (!response.ok) throw new AppDefinitionError(`文書を取得できませんでした(HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new AppDefinitionError("文書が大きすぎます(64 KB まで)");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppDefinitionError("文書が JSON として読めません");
  }
}

const portKey = (p: AppPort) => `${p.service} ${p.method} ${p.path}`;

export async function previewApp(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const clientId = String((await request.formData()).get("client_id") ?? "").trim();
  let definition: AppDefinition;
  try {
    definition = parseAppDefinition(await fetchDocument(clientId), clientId);
  } catch (e) {
    if (e instanceof AppDefinitionError) return listing(env, user, false, e.message, 400, clientId);
    throw e;
  }

  const existing = await getApp(env, definition.name);
  const conflict = existing && existing.definition.clientId !== clientId;
  const results = checkExamples(definition);
  const failed = results.filter((r) => r.expected !== r.actual);
  const before = new Set(existing?.definition.ports.map(portKey) ?? []);
  const after = new Set(definition.ports.map(portKey));
  const removed = existing?.definition.ports.filter((p) => !after.has(portKey(p))) ?? [];
  const mark = existing ? (p: AppPort) => (before.has(portKey(p)) ? "" : "追加") : undefined;
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "appdef", user.sub, { definition }, APPROVAL_TTL_SECONDS);
  const blocked = conflict || failed.length > 0;

  return page(
    "アプリの確認",
    html`${masthead(env, user)}
<a class="back" href="/admin/apps">‹ アプリの管理に戻る</a>
<h1>${existing ? "定義の更新" : "アプリの登録"}: ${definition.displayName} <code>${definition.name}</code></h1>
${conflict && html`<p class="error" role="alert">同じ名前「${definition.name}」のアプリが、別のクライアント ID(${existing!.definition.clientId})で登録されています。先にそちらの登録を消すか、アプリの名前を変えてもらってください。</p>`}
<div class="card">
<p>クライアント ID: <code>${definition.clientId}</code></p>
<p>同意の画面に出す説明: ${definition.description}</p>
${existing && existing.definition.description !== definition.description && html`<p class="hint">今の説明: ${existing.definition.description}</p>`}
<h2>使える口</h2>
${await portRows(env, definition.ports, mark)}
${removed.length > 0 && html`<h3>なくなる口</h3>${await portRows(env, removed)}`}
<p class="hint">口の中で何をするか(読んだ中身をどう扱うか)は、ゲートウェイでは縛れません。アプリの説明とコードを確かめてから承認してください。ボディで対象が決まる API(Graph のサブスクリプションなど)は、パスでは絞れません。</p>
<h2>テスト用の例</h2>
${
  results.length === 0
    ? html`<p class="hint">例がありません。通る呼び出しと通らない呼び出しの例(<code>examples.allow</code>・<code>examples.deny</code>)があると、正規表現の書き間違いに気づけます。</p>`
    : html`<ul class="examples">${results.map((r) => html`<li>${r.expected === r.actual ? "✓" : "✗"} <code>${r.example}</code>: ${r.expected ? "通るはず" : "通らないはず"}${r.expected !== r.actual && html`(結果は${r.actual ? "通る" : "通らない"})`}</li>`)}</ul>`
}
${failed.length > 0 && html`<p class="error" role="alert">例のとおりに照合できないものがあります。定義を直してもらってから、読み込み直してください。</p>`}
</div>
${
  !blocked &&
  html`<form method="post" action="/admin/apps" class="card">
<input type="hidden" name="approval" value="${token}">
<p>${existing ? "この定義で登録を置き換えます。口が減った分は、同意済みの利用者にもすぐ効きます。" : "承認すると、利用者がこのアプリに同意できるようになります。"}この画面の定義をそのまま保存し、あとで文書が書き換わっても登録は変わりません。</p>
<div class="actions"><button>${existing ? "更新を承認する" : "登録を承認する"}</button><a class="button quiet" href="/admin/apps">やめる</a></div>
</form>`
}`,
  );
}

export async function saveApp(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const approval = String((await request.formData()).get("approval") ?? "");
  const claims = await verifyToken<{ definition?: AppDefinition }>(env.SIGNING_KEY, publicUrl(env), "appdef", approval);
  if (!claims?.definition || claims.sub !== user.sub) return listing(env, user, false, "承認の期限が切れました。もう一度読み込んでください。", 400);
  const definition = claims.definition;
  const existing = await getApp(env, definition.name);
  if (existing && existing.definition.clientId !== definition.clientId) {
    return listing(env, user, false, `同じ名前「${definition.name}」のアプリが、別のクライアント ID で登録されています。`, 409);
  }
  const entry: AppEntry = { definition, approvedAt: Date.now(), approvedBy: user.sub };
  await registryFor(env).putApp(entry);
  audit(user, existing ? "update_app" : "register_app", definition.name, definition.ports.map(portKey));
  return redirect(`/admin/apps?saved=${encodeURIComponent(definition.name)}`);
}

export async function confirmDeleteApp(request: Request, env: Env, name: string): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const entry = await getApp(env, name);
  if (!entry) return new Response("not found", { status: 404 });
  return page(
    "アプリの登録の消去",
    html`${masthead(env, user)}
<a class="back" href="/admin/apps">‹ アプリの管理に戻る</a>
<h1>「${entry.definition.displayName}」の登録を消しますか?</h1>
<form method="post" action="/admin/apps/${name}/delete" class="card">
<p>消すと、このアプリへの利用者の許可はすべて、すぐに使えなくなります。同じアプリをまた使うときは、登録し直したうえで、利用者がもう一度同意します。</p>
<div class="actions"><button class="danger">登録を消す</button><a class="button quiet" href="/admin/apps">やめる</a></div>
</form>`,
  );
}

export async function deleteApp(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  if (!(await registryFor(env).removeApp(name))) return new Response("not found", { status: 404 });
  audit(user, "delete_app", name);
  return redirect(`/admin/apps?deleted=${encodeURIComponent(name)}`);
}
