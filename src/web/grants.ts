import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { masthead } from "./connections";
import { html, type Html } from "./html";
import { page } from "./layout";
import { redirect, sameOrigin, session, type Session } from "./session";

// The apps a user let into the gateway (Claude, Murmur, ...): each sign-in through
// /authorize is one grant. Revoking one cuts that app's access and refresh tokens.

type GrantEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

// Set on the grant when it is created (authorize.ts), so listing needs no client lookup.
export interface GrantMetadata {
  name: string;
  client?: string;
  // The registered app the grant is for (docs/adr/0008); absent for a stand.
  app?: string;
}

const grantedOn = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });

export async function listGrants(env: GrantEnv, userId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { limit: 1000, cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants.sort((a, b) => b.createdAt - a.createdAt);
}

// A metadata-document client's ID is the URL of its document; a registered one's is random.
function clientName(grant: GrantSummary): string {
  const named = (grant.metadata as Partial<GrantMetadata> | undefined)?.client;
  if (named) return named;
  return grant.clientId.startsWith("https://") ? new URL(grant.clientId).hostname : "名前のないアプリ";
}

function where(grant: GrantSummary): string {
  return grant.redirectUri ? new URL(grant.redirectUri).hostname : "";
}

export function grantRows(grants: GrantSummary[]): Html {
  if (grants.length === 0) return html`<p class="empty">アクセスを許可したアプリはありません。</p>`;
  const rows = grants.map(
    (g) => html`<li id="g-${g.id}">
<div class="row-main"><p class="row-title">${clientName(g)}</p><p class="row-sub">${where(g) && `${where(g)} · `}${grantedOn.format(g.createdAt * 1000)}に許可</p></div>
<div class="row-actions"><a class="button quiet" href="/grants/${g.id}/revoke">取り消す</a></div>
</li>`,
  );
  return html`<ul class="list">${rows}</ul>`;
}

async function findGrant(env: GrantEnv, user: Session, id: string): Promise<GrantSummary | undefined> {
  return (await listGrants(env, user.sub)).find((g) => g.id === id);
}

export async function confirmRevoke(request: Request, env: GrantEnv, id: string): Promise<Response> {
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const grant = await findGrant(env, user, id);
  if (!grant) return redirect("/");
  return page(
    "アクセスの取り消し",
    html`${masthead(env, user)}
<a class="back" href="/">‹ つないだサービスに戻る</a>
<h1>「${clientName(grant)}」のアクセスを取り消しますか?</h1>
<form method="post" action="/grants/${grant.id}/revoke" class="card">
<p>${grantedOn.format(grant.createdAt * 1000)}に許可したアクセスです${where(grant) && `(${where(grant)})`}。取り消すと、このアプリはゲートウェイを通してあなたの接続を使えなくなります。使うときは、アプリからもう一度つなぎ直してください。</p>
<div class="actions"><button class="danger">取り消す</button><a class="button quiet" href="/">やめる</a></div>
</form>`,
  );
}

export async function revoke(request: Request, env: GrantEnv, id: string): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const user = await session(request, env);
  if (!user) return redirect("/login");
  const grant = await findGrant(env, user, id);
  if (grant) {
    await env.OAUTH_PROVIDER.revokeGrant(grant.id, user.sub);
    console.log(JSON.stringify({ type: "grant_revoked", user: user.sub, client: grant.clientId }));
  }
  return redirect("/?revoked=1");
}
