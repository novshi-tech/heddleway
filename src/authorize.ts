import { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { appScope, appServices, getApp, requestedApps, serviceNames, type AppEntry } from "./apps";
import { publicUrl } from "./config";
import { randomToken, s256 } from "./crypto";
import { html } from "./web/html";
import { page } from "./web/layout";
import { authorizationUrl, SignInError, signIn } from "./idp";
import type { McpProps } from "./mcp";
import type { GrantMetadata } from "./web/grants";

export const MCP_SCOPE = "gateway";
export const MCP_CALLBACK_PATH = "/oauth/callback";

type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

interface UpstreamData {
  verifier: string;
  nonce: string;
  // The app the grant is for (docs/adr/0008); absent for a stand.
  app?: string;
}

// The registered app a request asks for, or null for a stand's request (scope `gateway` or none).
// An app scope must come alone and from the client ID the admin registered.
async function appOf(env: Env, request: AuthRequest): Promise<{ entry: AppEntry } | { error: string } | null> {
  const names = requestedApps(request.scope);
  if (names.length === 0) return null;
  if (names.length > 1 || request.scope.length > 1) return { error: "アプリのアクセスは、ほかの範囲と一緒には許可できません。" };
  const entry = await getApp(env, names[0]);
  if (!entry || entry.definition.clientId !== request.clientId) return { error: "このアプリは、この組織のゲートウェイに登録されていません。管理者に登録を頼んでください。" };
  return { entry };
}

async function appConsentPage(env: Env, entry: AppEntry, request: AuthRequest, handle: string, headers: Headers): Promise<Response> {
  const app = entry.definition;
  const names = await serviceNames(env, appServices(app));
  const redirectHost = new URL(request.redirectUri).hostname;
  return page(
    `${app.displayName} の接続`,
    html`<div class="card">
<h1>${app.displayName} に Heddleway へのアクセスを許可しますか?</h1>
<p>${app.description}</p>
<p>このアプリが使えるのは、${names.join("、")} の決まった API だけです。管理者が登録したアプリです(発行元: <strong>${new URL(app.clientId).hostname}</strong>)。</p>
<p>アクセス権は <strong>${redirectHost}</strong> に送られます。</p>
<form method="post" class="actions">
  <input type="hidden" name="handle" value="${handle}">
  <button name="decision" value="approve">許可して会社のアカウントでサインイン</button>
  <button name="decision" value="deny" class="quiet">許可しない</button>
</form>
</div>`,
    headers,
  );
}

function consentPage(client: ClientInfo, request: AuthRequest, handle: string, headers: Headers): Response {
  const name = client.clientName ?? client.clientId;
  const redirectHost = new URL(request.redirectUri).hostname;
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost);
  const origin = client.clientId.startsWith("https://")
    ? html`発行元: <strong>${new URL(client.clientId).hostname}</strong>`
    : "このアプリは自己登録されたもので、名前は検証されていません。";
  return page(
    `${client.clientName ?? "アプリ"} の接続`,
    html`<div class="card">
<h1>${name} に Heddleway へのアクセスを許可しますか?</h1>
<p>${origin}</p>
<p>アクセス権は <strong>${redirectHost}</strong> に送られます。</p>
${local && html`<p><strong>このコンピューター上のアプリにアクセス権を渡します。</strong>自分でサインインを始めた場合だけ続けてください。</p>`}
<p>許可すると、このアプリはあなたがつないだサービスの API を呼び出せるようになります。</p>
<form method="post" class="actions">
  <input type="hidden" name="handle" value="${handle}">
  <button name="decision" value="approve">許可して会社のアカウントでサインイン</button>
  <button name="decision" value="deny" class="quiet">許可しない</button>
</form>
</div>`,
    headers,
  );
}

function renderError(message: string, status = 400): Response {
  return page("エラー", html`<div class="card"><h1>続けられませんでした</h1><p>${message}</p></div>`, undefined, status);
}

function redirectToClient(redirectUri: string, params: Record<string, string | undefined>, headers = new Headers()): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  headers.set("location", url.href);
  return new Response(null, { status: 302, headers });
}

async function handle(request: Request, env: EnvWithOAuth, run: (oauth: OAuthHelpers) => Promise<Response>): Promise<Response> {
  try {
    return await run(env.OAUTH_PROVIDER);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) {
      return redirectToClient(error.redirectUri, {
        error: error.code,
        error_description: error.description,
        state: error.state,
        iss: error.issuer,
      });
    }
    if (error instanceof AuthorizationError) return renderError(error.description);
    if (error instanceof CimdFetchError) return renderError("このアプリを検証できませんでした。");
    throw error;
  }
}

export function authorizeGet(request: Request, env: EnvWithOAuth): Promise<Response> {
  return handle(request, env, async (oauth) => {
    const authRequest = await oauth.parseAuthRequest(request);
    const client = await oauth.lookupClient(authRequest.clientId);
    if (!client) return renderError("不明なクライアントです。");
    const app = await appOf(env, authRequest);
    if (app && "error" in app) return renderError(app.error);
    const consent = await oauth.beginConsent(authRequest);
    if (app) return appConsentPage(env, app.entry, authRequest, consent.handle, consent.headers);
    return consentPage(client, authRequest, consent.handle, consent.headers);
  });
}

export function authorizePost(request: Request, env: EnvWithOAuth): Promise<Response> {
  return handle(request, env, async (oauth) => {
    const form = await request.formData();
    const handleValue = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handleValue);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // What is granted follows the stored request, not the form: an app's request gets its app
    // scope, checked again against the registration; anything else gets the stand's scope.
    const approved = await oauth.approveConsent(request, handleValue);
    const app = await appOf(env, approved.request);
    if (app && "error" in app) return renderError(app.error);
    const granted = { ...approved.request, scope: app ? [appScope(app.entry.definition.name)] : [MCP_SCOPE] };
    const data: UpstreamData = { verifier: randomToken(), nonce: randomToken(), ...(app ? { app: app.entry.definition.name } : {}) };
    const { state, headers } = await oauth.beginUpstream(granted, { data, headers: approved.headers });
    headers.set(
      "location",
      await authorizationUrl(env, {
        redirectUri: `${publicUrl(env)}${MCP_CALLBACK_PATH}`,
        state,
        codeChallenge: await s256(data.verifier),
        nonce: data.nonce,
      }),
    );
    return new Response(null, { status: 302, headers });
  });
}

export function authorizeCallback(request: Request, env: EnvWithOAuth): Promise<Response> {
  return handle(request, env, async (oauth) => {
    const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const deny = () =>
      redirectToClient(original.redirectUri, { error: "access_denied", state: original.state, iss: original.issuer }, headers);
    if (params.get("error") || !code) return deny();

    let user;
    try {
      user = await signIn(env, {
        code,
        verifier: data.verifier,
        nonce: data.nonce,
        redirectUri: `${publicUrl(env)}${MCP_CALLBACK_PATH}`,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        console.warn(JSON.stringify({ type: "signin_rejected", reason: error.message }));
        return deny();
      }
      throw error;
    }

    const props: McpProps = { userId: user.id, name: user.name, ...(data.app ? { app: data.app } : {}) };
    // Kept on the grant so the list of allowed apps can name it without looking the client up.
    const client = await oauth.lookupClient(original.clientId).catch(() => null);
    const metadata: GrantMetadata = {
      name: user.name,
      ...(client?.clientName ? { client: client.clientName } : {}),
      ...(data.app ? { app: data.app } : {}),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: user.id,
      metadata,
      scope: original.scope,
      props,
      // claude.ai, Cowork and Claude Desktop share one client ID and redirect URI, so
      // revoking would cut off the user's other connections. Idle grants expire anyway.
      revokeExistingGrants: false,
    });
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  });
}
