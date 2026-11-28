import { publicUrl, splitList } from "../config";
import { randomToken, s256 } from "../crypto";
import { authorizationUrl, SignInError, signIn } from "../idp";
import type { JWTPayload } from "jose";
import { signToken, verifyToken } from "../tokens";
import { html } from "./html";
import { page } from "./layout";

export const LOGIN_CALLBACK_PATH = "/login/callback";
export const SESSION_COOKIE = "__Host-gw-session";
const LOGIN_COOKIE = "__Host-gw-login";
// A session slides: a page visit renews it, so it ends after a week or two of not opening the
// pages, and in any case a month after signing in (then the IdP decides again).
const SESSION_IDLE_SECONDS = 14 * 24 * 60 * 60;
const SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;
// Renew at most this often, so most responses carry no Set-Cookie.
const SESSION_RENEW_AFTER_SECONDS = 60 * 60;
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

interface SessionClaims extends JWTPayload {
  name?: string;
  // When the user signed in with the IdP (seconds). Missing on sessions issued before sliding.
  auth?: number;
}

async function sessionClaims(request: Request, env: Env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifyToken<SessionClaims>(env.SIGNING_KEY, publicUrl(env), "session", token);
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.auth === "number" && now - claims.auth >= SESSION_MAX_SECONDS) return null;
  return claims;
}

export async function session(request: Request, env: Env): Promise<Session | null> {
  const claims = await sessionClaims(request, env);
  return claims ? { sub: claims.sub, name: claims.name ?? claims.sub } : null;
}

async function sessionCookie(env: Env, sub: string, name: string, auth: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(SESSION_IDLE_SECONDS, auth + SESSION_MAX_SECONDS - now);
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "session", sub, { name, auth }, ttl);
  return cookie(SESSION_COOKIE, token, ttl);
}

// The Set-Cookie that extends a valid session the request carries, or null when it needs none.
export async function renewedSessionCookie(request: Request, env: Env): Promise<string | null> {
  const claims = await sessionClaims(request, env);
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iat === "number" && now - claims.iat < SESSION_RENEW_AFTER_SECONDS) return null;
  // A session from before sliding counts from when it was issued.
  const auth = typeof claims.auth === "number" ? claims.auth : (claims.iat ?? now);
  if (auth + SESSION_MAX_SECONDS - now <= SESSION_RENEW_AFTER_SECONDS) return null;
  return sessionCookie(env, claims.sub, claims.name ?? claims.sub, auth);
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
    const headers = new Headers();
    headers.append("set-cookie", await sessionCookie(env, user.id, user.name, Math.floor(Date.now() / 1000)));
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
