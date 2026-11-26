import { publicUrl, splitList } from "../config";
import { randomToken, s256 } from "../crypto";
import { authorizationUrl, SignInError, signIn } from "../idp";
import { signToken, verifyToken } from "../tokens";
import { html } from "./html";
import { page } from "./layout";

export const LOGIN_CALLBACK_PATH = "/login/callback";
export const SESSION_COOKIE = "__Host-gw-session";
const LOGIN_COOKIE = "__Host-gw-login";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_TTL_SECONDS = 10 * 60;

export interface Session {
  sub: string;
  name: string;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function redirect(location: string, headers = new Headers()): Response {
  headers.set("location", location);
  return new Response(null, { status: 303, headers });
}

// Admins are listed by user ID in ADMINS; an email address can change or be reused.
export function isAdmin(env: Env, user: Session): boolean {
  return splitList(env.ADMINS).includes(user.sub);
}

export async function session(request: Request, env: Env): Promise<Session | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifyToken<{ name?: string }>(env.SIGNING_KEY, publicUrl(env), "session", token);
  return claims ? { sub: claims.sub, name: claims.name ?? claims.sub } : null;
}

// Forms post only to this origin; a cross-site post has another Origin.
export function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("origin") === new URL(publicUrl(env)).origin;
}

// Where to go after signing in: a path on this site only, never another origin.
function localPath(value: string | null): string | undefined {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : undefined;
}

export async function login(request: Request, env: Env): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const next = localPath(new URL(request.url).searchParams.get("next"));
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "login", state, { verifier, nonce, ...(next ? { next } : {}) }, LOGIN_TTL_SECONDS);
  const location = await authorizationUrl(env, {
    redirectUri: `${publicUrl(env)}${LOGIN_CALLBACK_PATH}`,
    state,
    codeChallenge: await s256(verifier),
    nonce,
  });
  return redirect(location, new Headers({ "set-cookie": cookie(LOGIN_COOKIE, token, LOGIN_TTL_SECONDS) }));
}

export async function loginCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const stored = readCookie(request, LOGIN_COOKIE);
  const pending = stored
    ? await verifyToken<{ verifier: string; nonce: string; next?: string }>(env.SIGNING_KEY, publicUrl(env), "login", stored)
    : null;
  const code = params.get("code");
  if (!pending || pending.sub !== params.get("state") || !code) {
    return page("サインイン", html`<div class="card"><h1>サインインできませんでした</h1><p>時間がたちすぎたか、別のタブで操作した可能性があります。</p><p><a href="/login">もう一度サインインする</a></p></div>`, undefined, 400);
  }
  try {
    const user = await signIn(env, {
      code,
      verifier: pending.verifier,
      nonce: pending.nonce,
      redirectUri: `${publicUrl(env)}${LOGIN_CALLBACK_PATH}`,
    });
    const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "session", user.id, { name: user.name }, SESSION_TTL_SECONDS);
    const headers = new Headers();
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS));
    headers.append("set-cookie", cookie(LOGIN_COOKIE, "", 0));
    return redirect(localPath(pending.next ?? null) ?? "/", headers);
  } catch (error) {
    if (error instanceof SignInError) {
      console.warn(JSON.stringify({ type: "signin_rejected", reason: error.message }));
      return page("サインイン", html`<div class="card"><h1>このアカウントではサインインできません</h1><p>会社のアカウントでサインインしてください。</p></div>`, undefined, 403);
    }
    throw error;
  }
}

export function logout(request: Request, env: Env): Response {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  // Stop here: going straight to /login would sign the user back in through the IdP's own session.
  return page(
    "サインアウト",
    html`<div class="card"><h1>サインアウトしました</h1><p><a href="/login">もう一度サインインする</a></p></div>`,
    // Also drop the pages the app kept on this device and its service worker (docs/adr/0010).
    new Headers({ "set-cookie": cookie(SESSION_COOKIE, "", 0), "clear-site-data": '"cache", "storage"' }),
  );
}
