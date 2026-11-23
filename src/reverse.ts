import { calculateJwkThumbprint, decodeJwt, importJWK, jwtVerify, type JWK } from "jose";
import { publicUrl } from "./config";
import { randomToken } from "./crypto";
import { features } from "./features";
import { IDENTITY_CREDENTIAL } from "./identity";
import { denied, DROP_RESPONSE_HEADERS, forwardHeaders, handleProxy } from "./proxy";
import { registryFor } from "./registry";
import {
  connectionFor,
  GRANT_HEADER,
  MAX_BODY_BYTES,
  reverseNamespace,
  type ConnectGrant,
  type ConnectionStatus,
  type HeaderList,
  fromBase64,
  toBase64,
} from "./reverse-connection";
import { getDirectory } from "./services";
import { signToken, verifyToken } from "./tokens";
import { vaultFor } from "./vault";

// Reverse connections (docs/adr/0003): a service on someone's PC or in a customer's cluster
// opens a WebSocket to the gateway, and the gateway relays calls to it. Each one belongs to
// one user, who paired it, and only that user can call it. The protocol is in
// docs/reverse-protocol.md; the socket itself lives in src/reverse-connection.ts.

export const REVERSE_CREDENTIAL_PREFIX = "reverse:";
export const PAIR_PATH = "/reverse/pair";
export const PAIR_STATUS_PATH = "/reverse/pair/status";
export const CHALLENGE_PATH = "/reverse/challenge";
export const CONNECT_PATH = "/reverse/connect";
// Where the owner enters the code (src/web/reverse.ts).
export const OWNER_PAIR_PATH = "/pair";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
// How long the local service may take to pick up the decision.
const POLL_TTL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 3;
const MAX_PENDING_PAIRINGS = 100;
const CHALLENGE_TTL_SECONDS = 60;
// The service's signed assertion must be fresh.
const ASSERTION_MAX_AGE_SECONDS = 120;
const MAX_NAME = 40;
const MAX_PAIRING_DESCRIPTION = 500;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
// Codes avoid look-alike characters (0/O, 1/I/L), as boid's pairing codes do.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

// A registered local service: who owns it and the key it proves itself with.
export interface ReverseService {
  id: string;
  // Its service name under /api/<name>, unique among the owner's services.
  name: string;
  owner: string;
  ownerName: string;
  publicKey: Ed25519PublicJwk;
  // RFC 7638 thumbprint of the key, shown when pairing so the owner can compare.
  thumbprint: string;
  // What the service said about itself when it asked to pair.
  pairingDescription?: string;
  // Services the owner lets it call back as them (ADR 0003 decision 5); none at first.
  callback?: string[];
  createdAt: number;
}

export interface Pairing {
  codeHash: string;
  pollHash: string;
  name: string;
  publicKey: Ed25519PublicJwk;
  thumbprint: string;
  description?: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  serviceId?: string;
}

export type PairingDecision = ReverseService | "deny";

export type PairingPoll =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; service: ReverseService };

export function reverseCredentialId(serviceId: string): string {
  return `${REVERSE_CREDENTIAL_PREFIX}${serviceId}`;
}

export function serviceIdOfReverseCredential(credential: string): string | null {
  return credential.startsWith(REVERSE_CREDENTIAL_PREFIX) ? credential.slice(REVERSE_CREDENTIAL_PREFIX.length) : null;
}

// Off when the deployment lacks the binding, or sets REVERSE_PAIRING to "off" (ADR 0003
// decision 3: an admin can forbid pairing). Already paired services keep working.
export function reverseEnabled(env: Env): boolean {
  return reverseNamespace(env) !== undefined;
}

export function pairingAllowed(env: Env): boolean {
  const flag = (env as unknown as Record<string, unknown>).REVERSE_PAIRING;
  return reverseEnabled(env) && !(typeof flag === "string" && flag.trim().toLowerCase() === "off");
}

// REVERSE_CALLBACK "off" forbids every call back, whatever owners chose (decision 3).
export function callbackAllowed(env: Env): boolean {
  const flag = (env as unknown as Record<string, unknown>).REVERSE_CALLBACK;
  return reverseEnabled(env) && !(typeof flag === "string" && flag.trim().toLowerCase() === "off");
}

// The services an owner can let a local service call back: those the owner reaches through
// the gateway with one credential (their connections, identity services, features), never
// another local service.
export async function callableServices(env: Env, owner: string): Promise<{ service: string; displayName: string; credential: string }[]> {
  const directory = await getDirectory(env);
  const out = new Map<string, { service: string; displayName: string; credential: string }>();
  for (const c of await vaultFor(env, owner).list()) {
    if (c.needsReconnect || out.has(c.service) || !directory.available(c.service)) continue;
    out.set(c.service, { service: c.service, displayName: directory.services[c.service].display_name ?? c.service, credential: c.id });
  }
  for (const [name, config] of Object.entries(directory.services)) {
    if (config.auth.type === "identity") out.set(name, { service: name, displayName: config.display_name ?? name, credential: IDENTITY_CREDENTIAL });
  }
  for (const f of features(env)) out.set(f.name, { service: f.name, displayName: f.displayName, credential: IDENTITY_CREDENTIAL });
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashCode(code: string): Promise<string> {
  return sha256(`code:${normalizeCode(code)}`);
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function parsePublicKey(raw: unknown): Ed25519PublicJwk | null {
  if (!raw || typeof raw !== "object") return null;
  const jwk = raw as Record<string, unknown>;
  // A private key sent by mistake is refused rather than stored.
  if ("d" in jwk) return null;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) return null;
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export function validName(name: string): boolean {
  return name.length <= MAX_NAME && NAME.test(name);
}

// A name must not be one that the proxy resolves to something else.
export async function nameInUse(env: Env, name: string): Promise<boolean> {
  if (features(env).some((f) => f.name === name)) return true;
  return Object.hasOwn((await getDirectory(env)).services, name);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// POST /reverse/pair: the local service asks to be paired and gets a code to show its owner.
export async function startPairing(request: Request, env: Env): Promise<Response> {
  if (!reverseEnabled(env)) return json({ error: "this gateway does not accept reverse connections" }, 404);
  if (!pairingAllowed(env)) return json({ error: "pairing is turned off at this gateway; ask an admin" }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: "send a JSON object" }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!validName(name)) return json({ error: `name must match ${NAME.source} and be at most ${MAX_NAME} characters` }, 400);
  const publicKey = parsePublicKey(body.public_key);
  if (!publicKey) return json({ error: "public_key must be an Ed25519 public JWK ({kty: OKP, crv: Ed25519, x}) without the private part" }, 400);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, MAX_PAIRING_DESCRIPTION) : undefined;

  const code = newCode();
  const pairingId = randomToken();
  const now = Date.now();
  const pairing: Pairing = {
    codeHash: await hashCode(code),
    pollHash: await sha256(`poll:${pairingId}`),
    name,
    publicKey,
    thumbprint: await calculateJwkThumbprint(publicKey as JWK),
    ...(description ? { description } : {}),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    status: "pending",
  };
  if (!(await registryFor(env).createPairing(pairing, MAX_PENDING_PAIRINGS))) {
    return json({ error: "too many pairings are waiting; try again in a few minutes" }, 429);
  }
  const base = publicUrl(env);
  return json(
    {
      code,
      pairing_id: pairingId,
      verification_uri: `${base}${OWNER_PAIR_PATH}`,
      verification_uri_complete: `${base}${OWNER_PAIR_PATH}?code=${encodeURIComponent(code)}`,
      thumbprint: pairing.thumbprint,
      expires_in: PAIRING_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    },
    201,
  );
}

// POST /reverse/pair/status: the local service polls with the pairing ID until the owner decides.
export async function pairingStatus(request: Request, env: Env): Promise<Response> {
  if (!reverseEnabled(env)) return json({ error: "this gateway does not accept reverse connections" }, 404);
  const body = await readJson(request);
  const pairingId = typeof body?.pairing_id === "string" ? body.pairing_id : "";
  if (!pairingId) return json({ error: "pairing_id is required" }, 400);
  const result = await registryFor(env).pollPairing(await sha256(`poll:${pairingId}`));
  if (result.status !== "approved") return json({ status: result.status }, result.status === "expired" ? 404 : 200);
  return json({ status: "approved", service_id: result.service.id, name: result.service.name, connect_url: connectUrl(env) });
}

function connectUrl(env: Env): string {
  return `${publicUrl(env).replace(/^http/, "ws")}${CONNECT_PATH}`;
}

// POST /reverse/challenge: a one-time value for the service to sign when it connects.
export async function challenge(_request: Request, env: Env): Promise<Response> {
  if (!reverseEnabled(env)) return json({ error: "this gateway does not accept reverse connections" }, 404);
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "rchallenge", "reverse", { jti: randomToken() }, CHALLENGE_TTL_SECONDS);
  return json({ challenge: token, expires_in: CHALLENGE_TTL_SECONDS });
}

// GET /reverse/connect (WebSocket upgrade): proves the service with a JWT signed by its key
// (EdDSA, iss = its service ID, aud = this URL, nonce = a challenge), then hands the upgrade
// to the service's object. The connection is the session from then on (ADR 0003 decision 4).
export async function reverseConnect(request: Request, env: Env): Promise<Response> {
  if (!reverseEnabled(env)) return json({ error: "this gateway does not accept reverse connections" }, 404);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a WebSocket upgrade" }, 426);
  const assertion = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!assertion) return json({ error: "missing assertion: send Authorization: Bearer <JWT signed with the service's key>" }, 401);
  const refuse = (reason: string) => {
    console.warn(JSON.stringify({ type: "reverse_refused", reason }));
    return json({ error: "the assertion was not accepted" }, 401);
  };

  let issuer: string | undefined;
  try {
    issuer = decodeJwt(assertion).iss;
  } catch {
    return refuse("malformed");
  }
  if (!issuer) return refuse("no_issuer");
  const service = await registryFor(env).getReverse(issuer);
  if (!service) return refuse("unknown_service");

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(service.publicKey as JWK, "EdDSA");
    ({ payload } = await jwtVerify(assertion, key, {
      algorithms: ["EdDSA"],
      issuer: service.id,
      audience: `${publicUrl(env)}${CONNECT_PATH}`,
      maxTokenAge: ASSERTION_MAX_AGE_SECONDS,
      requiredClaims: ["iat", "exp", "nonce"],
    }));
  } catch {
    return refuse("bad_signature");
  }
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const issued = await verifyToken<{ jti?: string; exp?: number }>(env.SIGNING_KEY, publicUrl(env), "rchallenge", nonce);
  if (!issued?.jti || typeof issued.exp !== "number") return refuse("bad_challenge");

  const grant: ConnectGrant = { serviceId: service.id, name: service.name, challenge: issued.jti, challengeExpiresAt: issued.exp * 1000 };
  const headers = new Headers({ upgrade: "websocket", [GRANT_HEADER]: JSON.stringify(grant) });
  return connectionFor(env, service.id).fetch("https://reverse.internal/connect", { headers });
}

// The proxy's leg for a reverse credential (src/proxy.ts): only the owner reaches it.
export async function relayToLocal(
  request: Request,
  env: Env,
  who: { user: string; credential: string; service: string; via: string; app?: string },
  upstreamPath: string,
): Promise<Response> {
  const id = serviceIdOfReverseCredential(who.credential);
  const service = id && reverseEnabled(env) ? await registryFor(env).getReverse(id) : null;
  if (!service || service.owner !== who.user || service.name !== who.service) return denied(403, `token does not cover service: ${who.service}`);

  let body: ArrayBuffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return denied(413, `the body is larger than ${MAX_BODY_BYTES} bytes, the most a reverse connection relays`);
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return denied(413, `the body is larger than ${MAX_BODY_BYTES} bytes, the most a reverse connection relays`);
    if (body.byteLength === 0) body = null;
  }
  const headers: HeaderList = [...forwardHeaders(request.headers, {})];
  const path = `${upstreamPath || "/"}${new URL(request.url).search}`;
  const result = await connectionFor(env, service.id).relay({ method: request.method, path, headers, body });

  console.log(
    JSON.stringify({
      type: "audit",
      user: who.user,
      credential: who.credential,
      service: who.service,
      via: who.via,
      reverse: service.id,
      ...(who.app !== undefined ? { app: who.app } : {}),
      method: request.method,
      path: upstreamPath || "/",
      status: "error" in result ? result.error : result.status,
    }),
  );

  if ("error" in result) {
    if (result.error === "offline") return denied(503, `the local service "${service.name}" is not connected to the gateway right now`);
    if (result.error === "timeout") {
      return denied(504, `the local service "${service.name}" did not answer in time; long work should be started asynchronously (202 and an ID) and fetched later`);
    }
    if (result.error === "too_large") return denied(502, `the local service's answer is larger than ${MAX_BODY_BYTES} bytes, the most a reverse connection relays`);
    if (result.error === "closed") return denied(502, `the connection to the local service "${service.name}" closed before it answered`);
    return denied(502, `the local service "${service.name}" sent an answer the gateway could not read`);
  }
  const out = new Headers();
  for (const [name, value] of result.headers) {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower) || lower === "content-length") continue;
    try {
      out.append(name, value);
    } catch {
      // An invalid header name or value from the service is dropped.
    }
  }
  const nullBody = [204, 205, 304].includes(result.status) || request.method === "HEAD";
  return new Response(nullBody ? null : result.body, { status: result.status, headers: out });
}

// Local services as the owner sees them, with whether each is connected and what it said.
export interface OwnedService {
  service: ReverseService;
  status: ConnectionStatus;
}

export async function listOwned(env: Env, owner?: string): Promise<OwnedService[]> {
  if (!reverseEnabled(env)) return [];
  const all = await registryFor(env).listReverse();
  const mine = owner === undefined ? all : all.filter((s) => s.owner === owner);
  return Promise.all(
    mine.map(async (service) => {
      try {
        return { service, status: await connectionFor(env, service.id).status() };
      } catch {
        return { service, status: { connected: false } };
      }
    }),
  );
}

export async function getOwned(env: Env, owner: string, serviceId: string): Promise<ReverseService | null> {
  if (!reverseEnabled(env)) return null;
  const service = await registryFor(env).getReverse(serviceId);
  return service && service.owner === owner ? service : null;
}

// Deletes the registration and cuts the connection; the service must pair again.
export async function removeService(env: Env, serviceId: string): Promise<boolean> {
  const removed = await registryFor(env).removeReverse(serviceId);
  await connectionFor(env, serviceId).revoke();
  return removed;
}

export async function setCallback(env: Env, owner: string, serviceId: string, chosen: string[]): Promise<ReverseService | null> {
  const service = await getOwned(env, owner, serviceId);
  if (!service) return null;
  const callable = new Set((await callableServices(env, owner)).map((c) => c.service));
  const callback = [...new Set(chosen)].filter((s) => callable.has(s)).sort();
  return registryFor(env).setReverseCallback(serviceId, owner, callback);
}

// The token a call back carries only has to live while the proxy (and a feature's port) checks it.
const CALL_TOKEN_TTL_SECONDS = 60;

// A local service calling the gateway as its owner over its connection (ADR 0003 decision 5):
// `{"type": "call", id, method, service, path, headers, body}` in, the proxy's answer out.
// The registration is read on every call, so removing it or narrowing the services takes effect
// at once. The answer is a `call_result` frame; refusals are ordinary 4xx answers.
export async function handleCall(env: Env, ctx: ExecutionContext, serviceId: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = typeof frame.id === "string" ? frame.id : "";
  const answer = (status: number, error: string) => ({ type: "call_result", id, status, headers: [["content-type", "application/json"]], body: toBase64(new TextEncoder().encode(JSON.stringify({ error })).buffer as ArrayBuffer) });
  const service = typeof frame.service === "string" ? frame.service : "";
  const method = typeof frame.method === "string" ? frame.method.toUpperCase() : "";
  const path = typeof frame.path === "string" ? frame.path : "";
  if (!id) return answer(400, "a call needs an id");
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return answer(400, `unsupported method: ${method}`);
  if (!path.startsWith("/")) return answer(400, "path must start with /");

  const local = await registryFor(env).getReverse(serviceId);
  if (!local) return answer(403, "the registration was removed");
  const refuse = (reason: string, message: string) => {
    console.warn(JSON.stringify({ type: "reverse_call_refused", reverse: serviceId, user: local.owner, service, method, reason }));
    return answer(403, message);
  };
  if (!callbackAllowed(env)) return refuse("deployment", "calls back to the gateway are turned off at this gateway");
  if (!(local.callback ?? []).includes(service)) return refuse("not_chosen", `the owner has not let this local service call ${service || "that service"}; they choose the services at the gateway's home page`);
  const target = (await callableServices(env, local.owner)).find((c) => c.service === service);
  if (!target) return refuse("not_connected", `the owner has no usable connection to ${service}`);

  const base = publicUrl(env);
  const prefix = `/api/${service}`;
  let url: URL;
  try {
    url = new URL(`${base}${prefix}${path}`);
  } catch {
    return answer(400, `invalid path: ${path}`);
  }
  if (url.origin !== new URL(base).origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return answer(400, `path leaves the service: ${path}`);

  const headers = new Headers();
  const list = Array.isArray(frame.headers) ? frame.headers : [];
  for (const pair of list) {
    if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
      try {
        headers.append(pair[0], pair[1]);
      } catch {
        // An invalid header is dropped.
      }
    }
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "heddleway-reverse");
  let body: ArrayBuffer | undefined;
  if (typeof frame.body === "string" && method !== "GET" && method !== "HEAD") {
    try {
      body = fromBase64(frame.body);
    } catch {
      return answer(400, "body must be base64");
    }
    if (body.byteLength > MAX_BODY_BYTES) return answer(413, `the body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  const { token } = await signToken(env.SIGNING_KEY, base, "api", local.owner, { creds: { [service]: target.credential }, reverse: serviceId }, CALL_TOKEN_TTL_SECONDS);
  headers.set("authorization", `Bearer ${token}`);

  const response = await handleProxy(new Request(url, { method, headers, body }), env, ctx, "reverse");
  const out = await response.arrayBuffer();
  if (out.byteLength > MAX_BODY_BYTES) return answer(502, `the answer is larger than ${MAX_BODY_BYTES} bytes, the most a reverse connection relays`);
  return { type: "call_result", id, status: response.status, headers: [...response.headers], body: out.byteLength > 0 ? toBase64(out) : null };
}

export { POLL_TTL_MS };
