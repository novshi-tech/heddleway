import { parseServices, publicUrl, type HeaderField, type ServiceConfig } from "../config";
import { registryFor } from "../registry";
import { forgetRegistry, getDirectory, type Directory, type ServiceSource } from "../services";
import type { OAuthClient } from "../upstream-oauth";
import { CONNECT_CALLBACK_PATH, masthead } from "./connections";
import { html } from "./html";
import { page } from "./layout";
import { isAdmin, redirect, sameOrigin, session, type Session } from "./session";

const SOURCE_LABELS: Record<ServiceSource, string> = { catalog: "組み込み", config: "設定ファイル", admin: "管理画面" };
const HEADER_ROWS = 3;

// Admin pages answer 404 to everyone else, so they do not reveal that they exist.
export async function admin(request: Request, env: Env): Promise<Session | Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  if (!isAdmin(env, user)) return new Response("not found", { status: 404 });
  return user;
}

export function audit(user: Session, action: string, service: string, fields: string[] = []): void {
  console.log(JSON.stringify({ type: "admin", admin: user.sub, action, service, fields }));
}

const AUTH_LABELS: Record<ServiceConfig["auth"]["type"], string> = {
  headers: "API キー",
  basic: "Basic 認証",
  oauth2: "OAuth 2.0",
  client_credentials: "OAuth 2.0(client credentials)",
  identity: "サインインを信頼",
};

export async function listServices(request: Request, env: Env): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const directory = await getDirectory(env);
  const url = new URL(request.url);
  const rows = Object.entries(directory.services).map(([name, config]) => {
    const source = directory.sources[name];
    const shadowed = source === "config" && Object.hasOwn(directory.registry.services, name);
    const action =
      source === "admin"
        ? html`<a class="button quiet" href="/admin/services/${name}">編集</a>`
        : shadowed
          ? html`<a class="button quiet" href="/admin/services/${name}/delete">管理画面の定義を削除</a>`
          : false;
    const note =
      config.auth.type === "client_credentials"
        ? directory.client(name)
          ? "利用者には表示されません。Service Binding の Background の入口から使います"
          : "クライアントが未設定のため、Background の入口からも使えません"
        : !directory.available(name) && "OAuth のクライアントが未設定のため、利用者には表示されていません";
    return html`<li>
<div class="row-main"><p class="row-title">${config.display_name}</p><p class="row-sub">${name} · ${AUTH_LABELS[config.auth.type]}${config.provider ? ` · ${config.provider}` : ""}${shadowed ? " · 設定ファイルの定義が優先されています" : ""}</p>${note && html`<p class="row-sub">${note}</p>`}</div>
<div class="row-actions"><span class="badge">${SOURCE_LABELS[source]}</span>${action}</div>
</li>`;
  });
  const done = url.searchParams.get("saved") ?? url.searchParams.get("deleted");
  return page(
    "接続先の管理",
    html`${masthead(env, user)}
${done && html`<p class="notice" role="status">「${done}」を${url.searchParams.has("saved") ? "保存" : "削除"}しました。</p>`}
<div class="section-head"><h1>接続先の管理</h1><a class="button" href="/admin/services/new">接続先を追加</a></div>
<p>ここで追加した接続先は、このゲートウェイの全員の「接続を追加」に出ます。組み込みと設定ファイルの接続先は、ソースか設定ファイルを変えてデプロイし直します。利用者に配るプラグインは<a href="/admin/plugins">プラグインの配布</a>で管理します。</p>
<ul class="list">${rows}</ul>`,
  );
}

interface ServiceForm {
  name: string;
  display_name: string;
  provider: string;
  base_url: string;
  auth_type: string;
  headers: HeaderField[];
  basic_username: string;
  basic_username_label: string;
  basic_password_label: string;
  authorization_url: string;
  token_url: string;
  scope: string;
  authorize_params: string;
  client_id: string;
  client_secret: string;
  cc_token_url: string;
  cc_scope: string;
}

function emptyForm(): ServiceForm {
  return {
    name: "",
    display_name: "",
    provider: "",
    base_url: "",
    auth_type: "headers",
    headers: [],
    basic_username: "",
    basic_username_label: "",
    basic_password_label: "",
    authorization_url: "",
    token_url: "",
    scope: "",
    authorize_params: "",
    client_id: "",
    client_secret: "",
    cc_token_url: "",
    cc_scope: "",
  };
}

function formOf(name: string, config: ServiceConfig, client: OAuthClient | undefined): ServiceForm {
  const form = { ...emptyForm(), name, display_name: config.display_name ?? "", provider: config.provider ?? "", base_url: config.base_url };
  const auth = config.auth;
  if (auth.type === "headers") return { ...form, auth_type: "headers", headers: auth.headers };
  if (auth.type === "basic") {
    return {
      ...form,
      auth_type: "basic",
      basic_username: auth.username ?? "",
      basic_username_label: auth.username_label ?? "",
      basic_password_label: auth.password_label ?? "",
    };
  }
  if (auth.type === "oauth2") {
    return {
      ...form,
      auth_type: "oauth2",
      authorization_url: auth.authorization_url,
      token_url: auth.token_url,
      scope: auth.scope ?? "",
      authorize_params: Object.entries(auth.authorize_params ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      client_id: client?.id ?? "",
    };
  }
  if (auth.type === "client_credentials") {
    return { ...form, auth_type: "client_credentials", cc_token_url: auth.token_url, cc_scope: auth.scope ?? "", client_id: client?.id ?? "" };
  }
  return form;
}

function readForm(data: FormData): ServiceForm {
  const field = (key: string) => String(data.get(key) ?? "").trim();
  const headers: HeaderField[] = [];
  for (let i = 0; data.has(`h_name_${i}`); i++) {
    const name = field(`h_name_${i}`);
    if (!name) continue;
    const prefix = String(data.get(`h_prefix_${i}`) ?? "");
    headers.push({ name, label: field(`h_label_${i}`) || name, ...(prefix.trim() ? { prefix } : {}) });
  }
  return {
    name: field("name"),
    display_name: field("display_name"),
    provider: field("provider"),
    base_url: field("base_url"),
    auth_type: field("auth_type"),
    headers,
    basic_username: field("basic_username"),
    basic_username_label: field("basic_username_label"),
    basic_password_label: field("basic_password_label"),
    authorization_url: field("authorization_url"),
    token_url: field("token_url"),
    scope: field("scope"),
    authorize_params: field("authorize_params"),
    ...clientFields(data, field("auth_type")),
    cc_token_url: field("cc_token_url"),
    cc_scope: field("cc_scope"),
  };
}

// Each OAuth fieldset has its own client inputs; only the chosen one counts.
function clientFields(data: FormData, authType: string): { client_id: string; client_secret: string } {
  const prefix = authType === "client_credentials" ? "cc_" : "";
  return {
    client_id: String(data.get(`${prefix}client_id`) ?? "").trim(),
    client_secret: String(data.get(`${prefix}client_secret`) ?? "").trim(),
  };
}

function configOf(form: ServiceForm): ServiceConfig | string {
  const base = {
    ...(form.display_name ? { display_name: form.display_name } : {}),
    ...(form.provider ? { provider: form.provider } : {}),
    base_url: form.base_url,
  };
  if (form.auth_type === "headers") {
    if (form.headers.length === 0) return "送るヘッダーを 1 つ以上入れてください。";
    return { ...base, auth: { type: "headers", headers: form.headers } };
  }
  if (form.auth_type === "basic") {
    return {
      ...base,
      auth: {
        type: "basic",
        ...(form.basic_username ? { username: form.basic_username } : {}),
        ...(form.basic_username_label && !form.basic_username ? { username_label: form.basic_username_label } : {}),
        ...(form.basic_password_label ? { password_label: form.basic_password_label } : {}),
      },
    };
  }
  if (form.auth_type === "oauth2") {
    const params: Record<string, string> = {};
    for (const line of form.authorize_params.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const eq = line.indexOf("=");
      if (eq <= 0) return `認可のパラメータは「名前=値」の形で 1 行に 1 つ書いてください: ${line}`;
      params[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return {
      ...base,
      auth: {
        type: "oauth2",
        authorization_url: form.authorization_url,
        token_url: form.token_url,
        ...(form.scope ? { scope: form.scope } : {}),
        ...(Object.keys(params).length > 0 ? { authorize_params: params } : {}),
      },
    };
  }
  if (form.auth_type === "client_credentials") {
    return {
      ...base,
      auth: { type: "client_credentials", token_url: form.cc_token_url, ...(form.cc_scope ? { scope: form.cc_scope } : {}) },
    };
  }
  return "認証方式を選んでください。";
}

// Checks a definition the same way SERVICES is checked, plus what only admins may not do.
function check(directory: Directory, name: string, config: ServiceConfig, creating: boolean): string | null {
  if (directory.sources[name] === "catalog") return `「${name}」は組み込みの接続先と同じ名前です。別の名前にしてください。`;
  if (creating && Object.hasOwn(directory.registry.services, name)) return `「${name}」はすでに管理画面に登録されています。`;
  try {
    parseServices({ [name]: config });
  } catch (error) {
    return `定義を確かめてください: ${(error as Error).message}`;
  }
  return null;
}

function serviceForm(env: Env, user: Session, form: ServiceForm, creating: boolean, error?: string, status = 200): Response {
  const action = creating ? "/admin/services" : `/admin/services/${form.name}`;
  const rows = Math.max(HEADER_ROWS, form.headers.length + 1);
  const headerRows = Array.from({ length: rows }, (_, i) => {
    const h = form.headers[i];
    return html`<div class="header-row">
<label>ヘッダー名<input type="text" name="h_name_${i}" value="${h?.name ?? ""}" placeholder="${i === 0 ? "x-api-key" : ""}" autocomplete="off"></label>
<label>画面での名前<input type="text" name="h_label_${i}" value="${h?.label ?? ""}" placeholder="${i === 0 ? "API キー" : ""}"></label>
<label>値の前に付ける文字<input type="text" name="h_prefix_${i}" value="${h?.prefix ?? ""}" placeholder="${i === 0 ? "例: Bearer(空でよい)" : ""}"></label>
</div>`;
  });
  return page(
    creating ? "接続先を追加" : `${form.name} を編集`,
    html`${masthead(env, user)}
<a class="back" href="/admin/services">‹ 接続先の管理に戻る</a>
<h1>${creating ? "接続先を追加" : `${form.display_name || form.name} を編集`}</h1>
${error && html`<p class="error" role="alert">${error}</p>`}
<form method="post" action="${action}" class="card admin-form">
${creating
  ? html`<label>名前(英小文字・数字・ハイフン。API のパス <code>/api/&lt;名前&gt;/</code> になり、あとから変えられません)<input type="text" name="name" value="${form.name}" required pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off"></label>`
  : html`<input type="hidden" name="name" value="${form.name}"><p class="hint">名前: <code>${form.name}</code></p>`}
<label>表示名<input type="text" name="display_name" value="${form.display_name}" placeholder="例: UBS Apps"></label>
<label>提供元(「接続を追加」でこの名前ごとにまとめます。空なら「その他」)<input type="text" name="provider" value="${form.provider}" placeholder="例: 自社"></label>
<label>ベース URL(https)<input type="text" name="base_url" value="${form.base_url}" required placeholder="https://api.example.com" autocomplete="off"></label>
${!creating && html`<p class="hint">ベース URL のホスト、トークンの URL、クライアント ID を変えると、この接続先の既存の接続はすべて使えなくなり、利用者はつなぎ直すことになります。</p>`}
<fieldset><legend>認証方式</legend>
<label class="choice"><input type="radio" name="auth_type" value="headers"${form.auth_type === "headers" ? " checked" : ""}> API キーやトークンをヘッダーで送る</label>
<label class="choice"><input type="radio" name="auth_type" value="basic"${form.auth_type === "basic" ? " checked" : ""}> Basic 認証(ユーザー名とパスワード)</label>
<label class="choice"><input type="radio" name="auth_type" value="oauth2"${form.auth_type === "oauth2" ? " checked" : ""}> OAuth 2.0(認可コード + PKCE)</label>
<label class="choice"><input type="radio" name="auth_type" value="client_credentials"${form.auth_type === "client_credentials" ? " checked" : ""}> OAuth 2.0(client credentials。人がいないときにトピック索引などの Worker が使う)</label>
</fieldset>
<fieldset data-auth="headers"><legend>API キーの場合: 送るヘッダー</legend>
<p class="hint">利用者が「画面での名前」の欄に値を入れ、ゲートウェイがこのヘッダーで送ります。使わない行は空のままにします。${!creating && "ヘッダー名を変えたり足したりすると、今ある接続には値がないので使えなくなります(元の名前に戻せば使えます)。"}</p>
${headerRows}
</fieldset>
<fieldset data-auth="basic"><legend>Basic 認証の場合</legend>
<p class="hint">利用者がユーザー名とパスワードを入れ、ゲートウェイが <code>Authorization: Basic …</code> で送ります。ユーザー名が決まっている上流(GitHub のトークンなら <code>x-access-token</code>、Bitbucket のアクセストークンなら <code>x-token-auth</code>)は、ユーザー名をここに書くと、利用者はパスワードだけを入れます。${!creating && "ユーザー名を空に戻すと、ユーザー名を持たない今ある接続は使えなくなります。"}</p>
<label>ユーザー名(決まっているときだけ)<input type="text" name="basic_username" value="${form.basic_username}" autocomplete="off" placeholder="例: x-access-token"></label>
<label>画面での名前: ユーザー名(空なら「ユーザー名」)<input type="text" name="basic_username_label" value="${form.basic_username_label}" placeholder="例: メールアドレス"></label>
<label>画面での名前: パスワード(空なら「パスワード」)<input type="text" name="basic_password_label" value="${form.basic_password_label}" placeholder="例: GitHub の personal access token"></label>
</fieldset>
<fieldset data-auth="oauth2"><legend>OAuth 2.0 の場合</legend>
<p class="hint">連携先にアプリを登録し、リダイレクト URI に <code>${publicUrl(env)}${CONNECT_CALLBACK_PATH}</code> を指定してください。</p>
<label>認可の URL<input type="text" name="authorization_url" value="${form.authorization_url}" autocomplete="off"></label>
<label>トークンの URL<input type="text" name="token_url" value="${form.token_url}" autocomplete="off"></label>
<label>スコープ(空白区切り)<input type="text" name="scope" value="${form.scope}" autocomplete="off"></label>
<label>認可の追加パラメータ(1 行に「名前=値」)<textarea name="authorize_params" rows="2">${form.authorize_params}</textarea></label>
<label>クライアント ID<input type="text" name="client_id" value="${form.client_id}" autocomplete="off"></label>
<label>クライアントシークレット${!creating && "(変えないときは空のまま)"}<input type="password" name="client_secret" autocomplete="off"></label>
</fieldset>
<fieldset data-auth="client_credentials"><legend>OAuth 2.0(client credentials)の場合</legend>
<p class="hint">ユーザーではなくこのゲートウェイが持つ接続です。利用者の画面にも Claude にも出ず、同じ Cloudflare アカウントの Worker が Service Binding(<code>"entrypoint": "Background"</code>)で <code>/${form.name || "<名前>"}/&lt;上流のパス&gt;</code> を呼んだときだけ使います。上流のアプリの権限は、読ませるものだけに絞ってください。</p>
<label>トークンの URL<input type="text" name="cc_token_url" value="${form.cc_token_url}" autocomplete="off" placeholder="https://login.microsoftonline.com/&lt;テナント&gt;/oauth2/v2.0/token"></label>
<label>スコープ(空白区切り)<input type="text" name="cc_scope" value="${form.cc_scope}" autocomplete="off" placeholder="https://graph.microsoft.com/.default"></label>
<label>クライアント ID<input type="text" name="cc_client_id" value="${form.client_id}" autocomplete="off"></label>
<label>クライアントシークレット${!creating && "(変えないときは空のまま)"}<input type="password" name="cc_client_secret" autocomplete="off"></label>
</fieldset>
<div class="actions"><button>保存する</button><a class="button quiet" href="/admin/services">やめる</a>${!creating && html`<a class="button quiet danger-link" href="/admin/services/${form.name}/delete">削除…</a>`}</div>
</form>
<script src="/assets/app.js" defer></script>`,
    undefined,
    status,
  );
}

export async function newService(request: Request, env: Env): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  return serviceForm(env, user, emptyForm(), true);
}

export async function editService(request: Request, env: Env, name: string): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const directory = await getDirectory(env);
  const entry = Object.hasOwn(directory.registry.services, name) ? directory.registry.services[name] : null;
  if (!entry) return new Response("not found", { status: 404 });
  return serviceForm(env, user, formOf(name, entry.config, directory.registry.clients[name]), false);
}

export async function saveService(request: Request, env: Env, existing?: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const form = readForm(await request.formData());
  const creating = existing === undefined;
  const name = creating ? form.name : existing;
  form.name = name;
  forgetRegistry();
  const directory = await getDirectory(env);
  const previous = Object.hasOwn(directory.registry.services, name) ? directory.registry.services[name] : null;
  if (!creating && !previous) return new Response("not found", { status: 404 });

  const config = configOf(form);
  if (typeof config === "string") return serviceForm(env, user, form, creating, config, 400);
  const problem = check(directory, name, config, creating);
  if (problem) return serviceForm(env, user, form, creating, problem, 400);

  // undefined keeps the stored client; null drops it when the service is no longer OAuth.
  let client: OAuthClient | null | undefined = null;
  if (config.auth.type === "oauth2" || config.auth.type === "client_credentials") {
    const stored = directory.registry.clients[name];
    if (!form.client_id) return serviceForm(env, user, form, creating, "クライアント ID を入れてください。", 400);
    if (form.client_secret) client = { id: form.client_id, secret: form.client_secret };
    else if (stored && stored.id === form.client_id) client = undefined;
    else return serviceForm(env, user, form, creating, "クライアントシークレットを入れてください。", 400);
  }

  await registryFor(env).put(name, config, client, user.sub);
  forgetRegistry();
  const changed = previous
    ? Object.keys({ ...previous.config, ...config }).filter(
        (k) => JSON.stringify((previous.config as unknown as Record<string, unknown>)[k]) !== JSON.stringify((config as unknown as Record<string, unknown>)[k]),
      )
    : Object.keys(config);
  audit(user, creating ? "create" : "update", name, client ? [...changed, "client"] : changed);
  return redirect(`/admin/services?saved=${encodeURIComponent(name)}`);
}

export async function confirmDeleteService(request: Request, env: Env, name: string): Promise<Response> {
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  const directory = await getDirectory(env);
  const entry = Object.hasOwn(directory.registry.services, name) ? directory.registry.services[name] : null;
  if (!entry) return new Response("not found", { status: 404 });
  const shadowed = directory.sources[name] === "config";
  return page(
    "接続先の削除",
    html`${masthead(env, user)}
<a class="back" href="/admin/services">‹ 接続先の管理に戻る</a>
<h1>「${entry.config.display_name || name}」を削除しますか?</h1>
<form method="post" action="/admin/services/${name}/delete" class="card">
<p>${shadowed
  ? "管理画面の定義だけを削除します。いまは設定ファイルの定義が使われているので、利用者への影響はありません。"
  : "「接続を追加」から消え、利用者がつないだ接続も使えなくなります。同じ名前でもう一度追加すると、ベース URL などが同じなら接続は元どおり使えます。"}</p>
<div class="actions"><button class="danger">削除する</button><a class="button quiet" href="/admin/services">やめる</a></div>
</form>`,
  );
}

export async function deleteService(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await admin(request, env);
  if (user instanceof Response) return user;
  if (!(await registryFor(env).remove(name))) return new Response("not found", { status: 404 });
  forgetRegistry();
  audit(user, "delete", name);
  return redirect(`/admin/services?deleted=${encodeURIComponent(name)}`);
}

