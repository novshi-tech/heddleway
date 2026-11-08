import { consentCode } from "../feature-port";
import { feature, features, type Feature } from "../features";
import { vaultFor } from "../vault";
import { masthead } from "./connections";
import { html, type Html } from "./html";
import { page } from "./layout";
import { redirect, sameOrigin, session } from "./session";

// Turning a feature of this Worker on and off (src/features.ts). A feature reads the user's
// connections only after the user turns it on here, signed in as themselves, and it stops
// the moment they turn it off. This page replaces the OAuth consent a separate app needed.

const STATE = /^[A-Za-z0-9_-]{16,128}$/;

function back(f: Feature, params: Record<string, string>): string {
  return `/${f.name}${f.consentCallbackPath}?${new URLSearchParams(params)}`;
}

export async function consentPage(request: Request, env: Env, name: string): Promise<Response> {
  const f = feature(env, name);
  if (!f) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const user = await session(request, env);
  if (!user) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const state = url.searchParams.get("state") ?? "";
  if (!STATE.test(state)) return new Response("bad request", { status: 400 });
  return page(
    `${f.displayName}を有効にする`,
    html`${masthead(env, user)}
<h1>${f.displayName}を有効にしますか?</h1>
<form method="post" action="/features/${f.name}/consent" class="card">
<input type="hidden" name="state" value="${state}">
<p>${f.consentText}</p>
<p class="hint">あとから「つないだサービス」の画面でいつでも無効にできます。</p>
<div class="actions"><button name="decision" value="allow">有効にする</button><button class="quiet" name="decision" value="deny">やめる</button></div>
</form>`,
  );
}

export async function consentSubmit(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const f = feature(env, name);
  if (!f) return new Response("not found", { status: 404 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  if (!STATE.test(state)) return new Response("bad request", { status: 400 });
  if (form.get("decision") !== "allow") return redirect(back(f, { state, error: "access_denied" }));
  await vaultFor(env, user.sub).setConsent(f.name, true);
  console.log(JSON.stringify({ type: "feature_enabled", user: user.sub, feature: f.name }));
  return redirect(back(f, { state, code: await consentCode(env, f.name, user.sub) }));
}

export async function disableFeature(request: Request, env: Env, name: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const f = feature(env, name);
  if (!f) return new Response("not found", { status: 404 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  await vaultFor(env, user.sub).setConsent(f.name, false);
  console.log(JSON.stringify({ type: "feature_disabled", user: user.sub, feature: f.name }));
  return redirect("/?disabled=1");
}

// The features section on the home page, or nothing when the deployment has none.
export async function featureRows(env: Env, userId: string): Promise<Html | false> {
  const own = features(env);
  if (own.length === 0) return false;
  const vault = vaultFor(env, userId);
  const rows = await Promise.all(
    own.map(async (f) => {
      const on = await vault.consented(f.name);
      return html`<li>
<div class="row-main"><p class="row-title">${f.displayName}</p><p class="row-sub">${f.consentText}</p></div>
<div class="row-actions">${on
        ? html`<span class="badge">有効</span><form method="post" action="/features/${f.name}/disable"><button class="quiet">無効にする</button></form>`
        : html`<span class="badge">無効</span><span class="hint">Claude から使い始めると、ここで有効にするよう案内されます</span>`}</div>
</li>`;
    }),
  );
  return html`<h2>このゲートウェイの機能</h2>
<p>有効にした機能だけが、あなたの接続を読みます。書き込みはしません。</p>
<ul class="list">${rows}</ul>`;
}
