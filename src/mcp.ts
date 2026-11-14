import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { appServices, getApp, type AppDefinition } from "./apps";
import { organizationName, publicUrl } from "./config";
import { feature, features } from "./features";
import { IDENTITY_CREDENTIAL, identityCredentialId, serviceOfIdentityCredential } from "./identity";
import { callApi, DEFAULT_MAX_CHARS, MAX_MAX_CHARS } from "./mcp-api";
import { getDirectory, getServices } from "./services";
import { GATEWAY_TOKEN_TTL_SECONDS, signToken } from "./tokens";
import { vaultFor } from "./vault";

export interface McpProps {
  userId: string;
  name: string;
  // Set on a grant for a registered app (docs/adr/0008): the tools reach only the app's services.
  app?: string;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const IDP_NAMES: Record<string, string> = { entra: "Microsoft Entra ID", google: "Google Workspace" };

// One deployment serves one organization, and gateways of several organizations may be
// connected side by side with the same tools (docs/adr/0004). The server names its
// organization so that Claude can pick the right connector.
function instructions(organization: string, idp: string, base: string): string {
  return (
    `This connector is the API gateway of the organization "${organization}" (sign-in: ${idp}, ${base}). ` +
    `Its credentials and the data reached through it belong to "${organization}" only. ` +
    "Gateways of other organizations may be connected as other connectors with the same tools. " +
    "Use the connector of the organization the task is about; if that is unclear and more than one connector offers the service, ask the user. " +
    "Do not carry data read through one organization's gateway into another organization's (sending, filing, uploading) without the user's confirmation."
  );
}

export function buildServer(env: Env, props: McpProps, ctx: ExecutionContext): McpServer {
  const base = publicUrl(env);
  const organization = organizationName(env);
  const idp = IDP_NAMES[env.IDP_TYPE as string] ?? (env.IDP_TYPE as string);
  const gateway = { organization, idp, url: base };
  const server = new McpServer(
    { name: "heddleway", title: `Heddleway (${organization})`, version: "0.0.0" },
    { instructions: instructions(organization, idp, base) },
  );
  const vault = vaultFor(env, props.userId);

  // The app's registration as it is now, read on every call so that narrowing or removing it
  // takes effect at once. null for a stand.
  async function currentApp(): Promise<{ app: AppDefinition | null } | { error: string }> {
    if (!props.app) return { app: null };
    const entry = await getApp(env, props.app);
    if (!entry) {
      console.warn(JSON.stringify({ type: "app_refused", app: props.app, user: props.userId, reason: "unregistered", via: "mcp" }));
      return { error: `the app "${props.app}" is no longer registered at this gateway` };
    }
    return { app: entry.definition };
  }
  const reaches = (app: AppDefinition | null, service: string) => app === null || appServices(app).includes(service);

  // Credential IDs to the credential each service uses, at most one per service.
  async function resolveCredentials(ids: string[]): Promise<{ creds: Record<string, string> } | { error: string }> {
    const creds: Record<string, string> = {};
    const current = await currentApp();
    if ("error" in current) return current;
    const services = await getServices(env);
    for (const id of new Set(ids)) {
      const identityService = serviceOfIdentityCredential(id);
      if (identityService !== null) {
        const known = feature(env, identityService) || (Object.hasOwn(services, identityService) && services[identityService].auth.type === "identity");
        if (!known) return { error: `unknown credential: ${id}` };
        if (!reaches(current.app, identityService)) return { error: `the app may not use service: ${identityService}` };
        if (creds[identityService]) return { error: `more than one credential for service: ${identityService}` };
        creds[identityService] = IDENTITY_CREDENTIAL;
        continue;
      }
      const info = await vault.get(id);
      if (!info) return { error: `unknown credential: ${id}` };
      if (!reaches(current.app, info.service)) return { error: `the app may not use service: ${info.service}` };
      if (info.needsReconnect) return { error: `credential ${id} must be reconnected by the user at ${base}/` };
      if (creds[info.service]) return { error: `more than one credential for service: ${info.service}` };
      creds[info.service] = id;
    }
    return { creds };
  }

  server.registerTool(
    "list_credentials",
    {
      title: "List credentials",
      description:
        `Lists the upstream services the API gateway of "${organization}" can reach and the credentials the current user has registered for them. ` +
        `Credentials are registered by the user at ${base}/. ` +
        `Services that trust the gateway's sign-in need no registration: they appear with the credential ID "${IDENTITY_CREDENTIAL}:<service>".`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const current = await currentApp();
      if ("error" in current) return error(current.error);
      const app = current.app;
      const directory = await getDirectory(env);
      const config = directory.services;
      // Features of this Worker (src/features.ts) are reached like identity services; one takes
      // its name over a configured service of the same name.
      const own = features(env);
      const identity = [
        ...own.map((f) => ({ id: identityCredentialId(f.name), service: f.name, label: `${f.displayName}(サインイン中のユーザー)` })),
        ...Object.entries(config)
          .filter(([service, c]) => c.auth.type === "identity" && !own.some((f) => f.name === service))
          .map(([service, c]) => ({ id: identityCredentialId(service), service, label: `${c.display_name}(サインイン中のユーザー)` })),
      ];
      const services = [...new Set([...own.map((f) => f.name), ...Object.keys(config).filter((name) => directory.available(name))])];
      const credentials = [...(await vault.list()), ...identity];
      return json({
        gateway,
        services: services.filter((s) => reaches(app, s)),
        credentials: credentials.filter((c) => reaches(app, c.service)),
        register_url: `${base}/`,
      });
    },
  );

  server.registerTool(
    "issue_token",
    {
      title: "Issue gateway token",
      description:
        `Issues a short-lived (${GATEWAY_TOKEN_TTL_SECONDS / 60} min) token for calling upstream APIs through the REST endpoint of the API gateway of "${organization}". ` +
        "Pass at most one credential per service. Send requests to `<base_url>/<service>/<upstream path>` " +
        "with `Authorization: Bearer <token>`; the gateway replaces that header with the upstream credentials. " +
        "Request a new token when it expires. " +
        "For a few small JSON calls, api_get and api_request reach the same APIs without a token or a script. " +
        "Always set an explicit User-Agent header (for example `heddleway-client`): Cloudflare rejects some default client user agents such as Python-urllib with error 1010.",
      inputSchema: {
        credential_ids: z.array(z.string()).min(1).describe("Credential IDs from list_credentials"),
      },
      // Issuing a token changes nothing upstream, so it is marked read-only: claude.ai
      // otherwise asks for approval every time a token is issued.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ credential_ids }) => {
      const resolved = await resolveCredentials(credential_ids);
      if ("error" in resolved) return error(resolved.error);
      const creds = resolved.creds;
      const { token, expiresAt } = await signToken(
        env.SIGNING_KEY,
        base,
        "api",
        props.userId,
        { creds, ...(props.app ? { app: props.app } : {}) },
        GATEWAY_TOKEN_TTL_SECONDS,
      );
      return json({
        gateway,
        token,
        base_url: `${base}/api`,
        services: Object.fromEntries(Object.keys(creds).map((s) => [s, `${base}/api/${s}`])),
        expires_at: new Date(expiresAt * 1000).toISOString(),
      });
    },
  );

  // Calling an upstream API from a tool, without a script (docs/adr/0007). Reads and writes are
  // separate tools so that clients can run reads without asking and ask before each write.
  const callInput = {
    credential_id: z.string().describe("Credential ID from list_credentials; it decides the service"),
    path: z
      .string()
      .describe("Upstream path, starting with /, as after `<base_url>/<service>` (for example `/api/1/deals`). Non-ASCII characters may be written as they are."),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .optional()
      .describe("Query parameters; an array repeats the key"),
    headers: z.record(z.string(), z.string()).optional().describe("Extra request headers. Authorization is set by the gateway."),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(MAX_MAX_CHARS)
      .optional()
      .describe(`Longest body returned, in characters (default ${DEFAULT_MAX_CHARS}). Longer bodies are cut and marked truncated.`),
  };
  const callNote =
    "Returns the status, selected response headers and the body (JSON parsed, otherwise text). " +
    "Binary bodies (files) are not returned: download or upload files with a script and issue_token. " +
    "For loops over many requests, bulk data or files, use a script instead.";

  async function runCall(method: string, args: { credential_id: string; path: string; query?: Record<string, string | number | boolean | string[]>; headers?: Record<string, string>; max_chars?: number; json?: unknown; text?: string }) {
    const resolved = await resolveCredentials([args.credential_id]);
    if ("error" in resolved) return error(resolved.error);
    const [[service, credential]] = Object.entries(resolved.creds);
    const outcome = await callApi(env, ctx, base, props.userId, {
      app: props.app,
      method,
      service,
      credential,
      path: args.path,
      query: args.query,
      headers: args.headers,
      json: args.json,
      text: args.text,
      maxChars: args.max_chars ?? DEFAULT_MAX_CHARS,
    });
    if ("error" in outcome) return error(outcome.error);
    return { ...json({ gateway, service, ...outcome.result }), ...(outcome.status >= 400 ? { isError: true } : {}) };
  }

  server.registerTool(
    "api_get",
    {
      title: "GET an upstream API",
      description:
        `Sends a GET request to an upstream API through the API gateway of "${organization}", with the user's credential, and returns the response. ` +
        callNote,
      inputSchema: callInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runCall("GET", args),
  );

  server.registerTool(
    "api_request",
    {
      title: "Send a request to an upstream API",
      description:
        `Sends a POST, PUT, PATCH or DELETE request to an upstream API through the API gateway of "${organization}", with the user's credential, and returns the response. ` +
        "These requests can change or delete data upstream: confirm the content with the user first. " +
        "Use it also for reads that an API only offers as POST, such as GraphQL queries and search endpoints. " +
        callNote,
      inputSchema: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        ...callInput,
        json: z.unknown().optional().describe("JSON body; sent with Content-Type: application/json unless headers say otherwise"),
        text: z.string().optional().describe("Raw text body, instead of json; set Content-Type in headers (default text/plain)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, ...args }) => runCall(method, args),
  );

  return server;
}

export const mcpHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const props = (ctx as ExecutionContext & { props: McpProps }).props;
    const server = buildServer(env, props, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
