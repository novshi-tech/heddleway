import { scopeTarget, type ReadScope, type UpstreamMethod } from "../murmur/src/ports/gateway";
import { features } from "./features";
import { registryFor } from "./registry";
import { getDirectory } from "./services";

// Apps (docs/adr/0008): clients that are not stands. An admin registers one from its client
// metadata document; the definition is copied when approved, so a later edit of the document
// widens nothing. A grant for an app reaches only the app's ports, checked by the proxy on
// every call against the registration as it is now.

export const APP_SCOPE_PREFIX = "app:";
// The member of the client metadata document that holds the app's definition.
export const METADATA_MEMBER = "heddleway_app";

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const METHODS: readonly UpstreamMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_PORTS = 50;
const MAX_EXAMPLES = 50;
const MAX_DESCRIPTION = 500;

// One port: a service, a method and a regular expression over the upstream path (before the query).
export interface AppPort {
  service: string;
  method: UpstreamMethod;
  path: string;
}

export interface AppDefinition {
  name: string;
  displayName: string;
  clientId: string;
  description: string;
  ports: AppPort[];
  // Calls written as "METHOD service /path?query", checked when the definition is read.
  examples: { allow: string[]; deny: string[] };
}

export interface AppEntry {
  definition: AppDefinition;
  approvedAt: number;
  approvedBy: string;
}

export class AppDefinitionError extends Error {}

function fail(message: string): never {
  throw new AppDefinitionError(message);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) fail(`${field} は文字列の配列にしてください`);
  if (value.length > MAX_EXAMPLES) fail(`${field} は ${MAX_EXAMPLES} 個までです`);
  return value;
}

function parsePort(raw: unknown, i: number): AppPort {
  if (!raw || typeof raw !== "object") fail(`ports[${i}] がオブジェクトではありません`);
  const { service, method, path } = raw as Record<string, unknown>;
  if (typeof service !== "string" || !SERVICE_NAME.test(service)) fail(`ports[${i}].service が正しくありません`);
  if (typeof method !== "string" || !METHODS.includes(method as UpstreamMethod)) fail(`ports[${i}].method は ${METHODS.join("・")} のどれかにしてください`);
  if (typeof path !== "string") fail(`ports[${i}].path がありません`);
  // Whole-match only: a pattern without anchors would let any path that contains it through.
  if (!path.startsWith("^/") || !path.endsWith("$")) fail(`ports[${i}].path は ^/ で始まり $ で終わる正規表現にしてください(全体一致)`);
  try {
    new RegExp(path);
  } catch {
    fail(`ports[${i}].path が正規表現として読めません`);
  }
  return { service, method: method as UpstreamMethod, path };
}

// Reads the definition from a client metadata document fetched from `clientId`.
export function parseAppDefinition(doc: unknown, clientId: string): AppDefinition {
  if (!doc || typeof doc !== "object") fail("メタデータ文書が JSON のオブジェクトではありません");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) fail("メタデータ文書の client_id が、入力した URL と一致しません");
  const app = d[METADATA_MEMBER];
  if (!app || typeof app !== "object") fail(`メタデータ文書に ${METADATA_MEMBER} がありません`);
  const a = app as Record<string, unknown>;
  if (typeof a.name !== "string" || !APP_NAME.test(a.name)) fail(`${METADATA_MEMBER}.name は英小文字・数字・ハイフン(40 文字まで)にしてください`);
  if (typeof a.description !== "string" || !a.description.trim()) fail(`${METADATA_MEMBER}.description がありません`);
  if (a.description.length > MAX_DESCRIPTION) fail(`${METADATA_MEMBER}.description は ${MAX_DESCRIPTION} 文字までです`);
  if (!Array.isArray(a.ports) || a.ports.length === 0) fail(`${METADATA_MEMBER}.ports に口を 1 つ以上書いてください`);
  if (a.ports.length > MAX_PORTS) fail(`${METADATA_MEMBER}.ports は ${MAX_PORTS} 個までです`);
  const examples = (a.examples ?? {}) as Record<string, unknown>;
  const displayName = typeof d.client_name === "string" && d.client_name.trim() ? d.client_name.trim() : a.name;
  return {
    name: a.name,
    displayName,
    clientId,
    description: a.description.trim(),
    ports: a.ports.map(parsePort),
    examples: { allow: stringList(examples.allow, "examples.allow"), deny: stringList(examples.deny, "examples.deny") },
  };
}

function scopeOf(app: AppDefinition, service: string): ReadScope {
  return app.ports.filter((p) => p.service === service).map((p) => [p.method, new RegExp(p.path)] as const);
}

// Whether the app may make this call. `path` is the upstream path, with or without the query.
// The same check as a feature's read scope (scopeTarget), so `..` and encoded tricks are refused.
export function appAllows(app: AppDefinition, service: string, method: string, path: string): boolean {
  if (!METHODS.includes(method as UpstreamMethod)) return false;
  return scopeTarget(scopeOf(app, service), method as UpstreamMethod, path || "/") !== null;
}

export function appServices(app: AppDefinition): string[] {
  return [...new Set(app.ports.map((p) => p.service))];
}

export interface ExampleResult {
  example: string;
  expected: boolean;
  actual: boolean;
}

// Runs the definition's examples; an example that cannot be read counts as allowed, so it fails a deny.
export function checkExamples(app: AppDefinition): ExampleResult[] {
  const run = (example: string, expected: boolean): ExampleResult => {
    const m = example.trim().match(/^([A-Z]+)\s+([a-z0-9][a-z0-9-]*)\s+(\/\S*)$/);
    const actual = m ? appAllows(app, m[2], m[1], m[3]) : !expected;
    return { example, expected, actual };
  };
  return [...app.examples.allow.map((e) => run(e, true)), ...app.examples.deny.map((e) => run(e, false))];
}

export function appScope(name: string): string {
  return `${APP_SCOPE_PREFIX}${name}`;
}

// The app a requested scope names, or null for the stand's scope. More than one app, or an app
// together with another scope, is refused by the caller.
export function requestedApps(scopes: string[]): string[] {
  return scopes.filter((s) => s.startsWith(APP_SCOPE_PREFIX)).map((s) => s.slice(APP_SCOPE_PREFIX.length));
}

export async function getApp(env: Env, name: string): Promise<AppEntry | null> {
  return registryFor(env).getApp(name);
}

export async function listApps(env: Env): Promise<AppEntry[]> {
  return registryFor(env).listApps();
}

// Display names of services, for the consent and admin pages; a feature takes its name over a service.
export async function serviceNames(env: Env, services: string[]): Promise<string[]> {
  const directory = await getDirectory(env);
  const own = features(env);
  return services.map(
    (s) => own.find((f) => f.name === s)?.displayName ?? (Object.hasOwn(directory.services, s) ? (directory.services[s].display_name ?? s) : s),
  );
}
