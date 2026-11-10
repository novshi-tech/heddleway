import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { authorizeCallback, authorizeGet, authorizePost, MCP_CALLBACK_PATH, MCP_SCOPE } from "./authorize";
import { publicUrl } from "./config";
import { features, withPath } from "./features";
import { jwks, JWKS_PATH } from "./identity";
import { mcpHandler } from "./mcp";
import { API_PREFIX, handleProxy } from "./proxy";
import { confirmDeleteService, deleteService, editService, listServices, newService, saveService } from "./web/admin";
import { APP_JS_PATH, appJs } from "./web/assets";
import {
  addCredential,
  chooseService,
  confirmDelete,
  CONNECT_CALLBACK_PATH,
  connectCallback,
  connectForm,
  connectStart,
  deleteCredential,
  home,
} from "./web/connections";
import { deleteClient, editClient, saveClient } from "./web/admin-clients";
import { confirmDeletePlugin, deletePlugin, listPluginsPage, uploadPlugin } from "./web/admin-plugins";
import { consentPage, consentSubmit, disableFeature } from "./web/features";
import { confirmRevoke, revoke } from "./web/grants";
import { login, LOGIN_CALLBACK_PATH, loginCallback, logout } from "./web/session";
import { downloadPlugin, setup, SETUP_PATH } from "./web/setup";

import "./murmur-feature";

export { Background } from "./background";
export { Registry } from "./registry";
export { UserVault } from "./vault";

const DAY = 24 * 60 * 60;
// Must match the daily cron in the deployment's config (wrangler.example.jsonc).
const PURGE_CRON = "0 18 * * *";

type RouteEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
type Route = [
  method: string,
  path: string | RegExp,
  handler: (request: Request, env: RouteEnv, params: string[]) => Response | Promise<Response>,
];

// Everything but the MCP endpoint and the token proxy. A RegExp path passes its groups as params.
const ROUTES: Route[] = [
  ["GET", JWKS_PATH, (_, env) => jwks(env)],
  ["GET", "/authorize", authorizeGet],
  ["POST", "/authorize", authorizePost],
  ["GET", MCP_CALLBACK_PATH, authorizeCallback],
  ["GET", APP_JS_PATH, () => appJs()],
  ["GET", "/", home],
  ["GET", SETUP_PATH, setup],
  ["GET", /^\/plugins\/([a-z0-9][a-z0-9-]*)\.zip$/, (request, env, [name]) => downloadPlugin(request, env, name)],
  ["GET", "/connections/new", chooseService],
  ["GET", /^\/connections\/new\/([a-z0-9][a-z0-9-]*)$/, (request, env, [service]) => connectForm(request, env, service)],
  ["GET", /^\/connections\/([0-9a-f-]+)\/delete$/, (request, env, [id]) => confirmDelete(request, env, id)],
  ["GET", /^\/grants\/([A-Za-z0-9_-]+)\/revoke$/, (request, env, [id]) => confirmRevoke(request, env, id)],
  ["POST", /^\/grants\/([A-Za-z0-9_-]+)\/revoke$/, (request, env, [id]) => revoke(request, env, id)],
  ["GET", "/login", login],
  ["GET", LOGIN_CALLBACK_PATH, loginCallback],
  ["POST", "/logout", logout],
  ["POST", "/credentials", addCredential],
  ["POST", /^\/credentials\/([0-9a-f-]+)\/delete$/, (request, env, [id]) => deleteCredential(request, env, id)],
  ["POST", "/connect", connectStart],
  ["GET", "/admin/services", listServices],
  ["POST", "/admin/services", (request, env) => saveService(request, env)],
  ["GET", "/admin/services/new", newService],
  ["GET", /^\/admin\/services\/([a-z0-9][a-z0-9-]*)$/, (request, env, [name]) => editService(request, env, name)],
  ["POST", /^\/admin\/services\/([a-z0-9][a-z0-9-]*)$/, (request, env, [name]) => saveService(request, env, name)],
  ["GET", /^\/admin\/services\/([a-z0-9][a-z0-9-]*)\/delete$/, (request, env, [name]) => confirmDeleteService(request, env, name)],
  ["POST", /^\/admin\/services\/([a-z0-9][a-z0-9-]*)\/delete$/, (request, env, [name]) => deleteService(request, env, name)],
  ["GET", /^\/admin\/clients\/([a-z0-9][a-z0-9-]*)$/, (request, env, [name]) => editClient(request, env, name)],
  ["POST", /^\/admin\/clients\/([a-z0-9][a-z0-9-]*)$/, (request, env, [name]) => saveClient(request, env, name)],
  ["POST", /^\/admin\/clients\/([a-z0-9][a-z0-9-]*)\/delete$/, (request, env, [name]) => deleteClient(request, env, name)],
  ["GET", "/admin/plugins", listPluginsPage],
  ["POST", "/admin/plugins", uploadPlugin],
  ["GET", /^\/admin\/plugins\/([a-z0-9][a-z0-9-]*)\/delete$/, (request, env, [name]) => confirmDeletePlugin(request, env, name)],
  ["POST", /^\/admin\/plugins\/([a-z0-9][a-z0-9-]*)\/delete$/, (request, env, [name]) => deletePlugin(request, env, name)],
  ["GET", CONNECT_CALLBACK_PATH, connectCallback],
  ["GET", /^\/features\/([a-z0-9][a-z0-9-]*)\/consent$/, (request, env, [name]) => consentPage(request, env, name)],
  ["POST", /^\/features\/([a-z0-9][a-z0-9-]*)\/consent$/, (request, env, [name]) => consentSubmit(request, env, name)],
  ["POST", /^\/features\/([a-z0-9][a-z0-9-]*)\/disable$/, (request, env, [name]) => disableFeature(request, env, name)],
];

function route(method: string, pathname: string): { route: Route; params: string[] } | null {
  for (const r of ROUTES) {
    if (r[0] !== method) continue;
    if (typeof r[1] === "string") {
      if (r[1] === pathname) return { route: r, params: [] };
    } else {
      const match = pathname.match(r[1]);
      if (match) return { route: r, params: match.slice(1) };
    }
  }
  return null;
}

// A feature's public routes (webhooks, its own pages) live under `/<name>/`; its API only
// behind the token proxy (`/api/<name>/...`), so `/<name>/api/` is not routed.
function featureRoute(env: Env, pathname: string) {
  for (const f of features(env)) {
    const prefix = `/${f.name}`;
    if (!pathname.startsWith(`${prefix}/`)) continue;
    const rest = pathname.slice(prefix.length);
    return rest === "/api" || rest.startsWith("/api/") ? null : { feature: f, path: rest };
  }
  return null;
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(API_PREFIX)) return handleProxy(request, env, ctx);
    const own = featureRoute(env, pathname);
    if (own) return own.feature.fetch(withPath(request, own.path), ctx);
    const found = route(request.method, pathname);
    if (!found) return new Response("not found", { status: 404 });
    return found.route[2](request, env as RouteEnv, found.params);
  },
};

// The provider's options depend on PUBLIC_URL, which is only known per request.
let cached: { url: string; provider: OAuthProvider<Env> } | undefined;

function provider(env: Env): OAuthProvider<Env> {
  const url = publicUrl(env);
  if (cached?.url !== url) {
    cached = {
      url,
      provider: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler as never,
        defaultHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: [MCP_SCOPE],
        accessTokenTTL: 60 * 60,
        refreshTokenIdleTTL: 30 * DAY,
        resourceMetadata: {
          resource: `${url}/mcp`,
          authorization_servers: [url],
          scopes_supported: [MCP_SCOPE],
          resource_name: "Heddleway",
        },
      }),
    };
  }
  return cached.provider;
}

export default {
  fetch(request, env, ctx) {
    return provider(env).fetch(request, env, ctx);
  },
  // The daily cron purges expired grants; any other cron is for the features (Murmur's tick).
  async scheduled(controller, env, ctx) {
    if (controller.cron === PURGE_CRON) {
      await provider(env).purgeExpiredData(env);
      return;
    }
    for (const f of features(env)) await f.scheduled?.(controller, ctx);
  },
  // Queues belong to the features (Murmur's sync queue).
  async queue(batch, env, ctx) {
    const own = features(env).filter((f) => f.queue);
    if (own.length === 0) {
      batch.ackAll();
      return;
    }
    for (const f of own) await f.queue!(batch, ctx);
  },
} satisfies ExportedHandler<Env>;
