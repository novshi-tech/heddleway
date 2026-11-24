import { DurableObject } from "cloudflare:workers";
import { registryFor } from "./registry";
import { handleCall } from "./tunnel";

// The live side of a tunnel connection (docs/adr/0003): one object per local service holds
// the WebSocket that the service opened to the gateway, and relays requests over it. The
// Worker checks who may connect and who may call (src/tunnel.ts) before it reaches here;
// this object only keeps the socket, matches answers to requests, and remembers the
// description the service sent. The wire format is in docs/tunnel-protocol.md.

// Bodies travel base64 in JSON text frames. Long work is asynchronous at the service
// (202 and an ID, docs/adr/0003 decision 6), so a relayed request is short.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const RELAY_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION = 8_000;
const MAX_VERSION = 100;

// Close codes the gateway sends (4000-4999 are for applications).
export const CLOSE_REPLACED = 4001;
export const CLOSE_REVOKED = 4003;
export const CLOSE_PROTOCOL = 4400;

export type HeaderList = [string, string][];

export interface RelayRequest {
  method: string;
  // The path under the service, with the query.
  path: string;
  headers: HeaderList;
  body: ArrayBuffer | null;
}

export type RelayResult =
  | { status: number; headers: HeaderList; body: ArrayBuffer | null }
  | { error: "offline" | "timeout" | "closed" | "bad_response" | "too_large" };

export interface ConnectionStatus {
  connected: boolean;
  // When the current (or last) connection was opened, and when it closed.
  connectedAt?: number;
  disconnectedAt?: number;
  // What the service sent in its last hello: instructions for agents, and its version.
  description?: string;
  version?: string;
}

export type TunnelMode = "standard" | "strict";

// What the Worker tells this object when it hands over an upgrade it already verified.
export interface ConnectGrant {
  serviceId: string;
  name: string;
  mode: TunnelMode;
  // The key the Worker checked, by thumbprint. The object checks it again against the
  // registration as it is now, so that a key replaced meanwhile cannot slip in.
  thumbprint: string;
  proof:
    // The one-time challenge the service signed, and when it expires (ms), so that a
    // signature cannot open a second connection.
    | { kind: "key"; challenge: string; challengeExpiresAt: number }
    // A resume token this object handed out on an earlier connection (strict mode).
    | { kind: "resume"; token: string };
}

// Strict mode (ADR 0003 decision 4): the key opens one connection only, and the service
// comes back with resume tokens it keeps in memory. A token lives this long and is replaced
// this often while connected, so a short drop or a deploy is survived, a long sleep is not.
export const RESUME_TTL_MS = 15 * 60 * 1000;
export const RESUME_ROTATE_MS = 5 * 60 * 1000;

interface Attachment {
  connection: string;
  connectedAt: number;
  serviceId: string;
  thumbprint: string;
}

// A resume token as stored: when it expires, and for which key's registration.
interface StoredResume {
  exp: number;
  thumbprint: string;
}

// The most calls back one connection may have in flight.
const MAX_CALLS_IN_FLIGHT = 8;

interface Pending {
  connection: string;
  resolve(result: RelayResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export const GRANT_HEADER = "x-heddleway-tunnel-grant";

function randomValue(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}


export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function headerList(value: unknown): HeaderList | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const list: HeaderList = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
    list.push([pair[0], pair[1]]);
  }
  return list;
}

export class TunnelConnection extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private callsInFlight = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // The upgrade, already verified by the Worker (src/tunnel.ts tunnelConnect).
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const grant = JSON.parse(request.headers.get(GRANT_HEADER) ?? "null") as ConnectGrant | null;
    if (!grant) return Response.json({ error: "missing grant" }, { status: 400 });

    const now = Date.now();
    await this.purge(now);
    const refuse = (message: string) => Response.json({ error: message }, { status: 401 });
    if (grant.proof.kind === "key") {
      // A signed challenge opens one connection only.
      const key = `used:${grant.proof.challenge}`;
      if ((await this.ctx.storage.get(key)) !== undefined) return refuse("the challenge was already used; request a new one");
      // In strict mode, the key itself opens one connection only.
      if (grant.mode === "strict" && (await this.ctx.storage.get("keySpent")) === grant.thumbprint) {
        return refuse("in strict mode the key opens one connection only; come back with a resume token, or pair again");
      }
      await this.ctx.storage.put(key, grant.proof.challengeExpiresAt);
    } else {
      const key = `resume:${await hashToken(grant.proof.token)}`;
      const stored = await this.ctx.storage.get<StoredResume>(key);
      if (!stored || stored.exp < now || stored.thumbprint !== grant.thumbprint) return refuse("the resume token is unknown or expired; pair again");
      // Using one token ends all that were handed out before it: a leaked older token cannot
      // take the connection over.
      await this.ctx.storage.delete([...(await this.ctx.storage.list({ prefix: "resume:" })).keys()]);
    }
    // The registration as it is now: removed or re-paired with another key since the Worker
    // checked, and the connection is refused.
    const current = await registryFor(this.env).getTunnel(grant.serviceId);
    if (!current || current.thumbprint !== grant.thumbprint) return refuse("the registration changed; pair again");
    if (grant.mode === "strict" && grant.proof.kind === "key") await this.ctx.storage.put("keySpent", grant.thumbprint);
    await this.ctx.storage.put("mode", grant.mode);

    // One connection per service for now (ADR 0003, open question 2): the newest wins, so a
    // restarted service does not wait for the old socket to time out.
    for (const old of this.ctx.getWebSockets()) {
      this.failPending(this.attachment(old)?.connection);
      try {
        old.close(CLOSE_REPLACED, "replaced by a newer connection");
      } catch {
        // Already closing.
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { connection: crypto.randomUUID(), connectedAt: now, serviceId: grant.serviceId, thumbprint: grant.thumbprint };
    server.serializeAttachment(attachment);
    const status = (await this.ctx.storage.get<ConnectionStatus>("status")) ?? { connected: false };
    await this.ctx.storage.put<ConnectionStatus>("status", { ...status, connected: true, connectedAt: now, disconnectedAt: undefined });
    server.send(
      JSON.stringify({
        type: "welcome",
        service_id: grant.serviceId,
        name: grant.name,
        max_body_bytes: MAX_BODY_BYTES,
        timeout_ms: RELAY_TIMEOUT_MS,
      }),
    );
    if (grant.mode === "strict") {
      await this.sendResume(server, grant.serviceId, grant.thumbprint, now);
      await this.ctx.storage.setAlarm(now + RESUME_ROTATE_MS);
    }
    console.log(JSON.stringify({ type: "tunnel_connected", service: grant.serviceId, mode: grant.mode, proof: grant.proof.kind }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Replaces the resume token while connected (strict mode). The previous one stays valid until
  // it expires, in case the new one is lost with the connection.
  async alarm(): Promise<void> {
    const socket = this.newest();
    const attachment = socket && this.attachment(socket);
    if (!socket || !attachment || (await this.ctx.storage.get("mode")) !== "strict") return;
    const now = Date.now();
    await this.purge(now);
    await this.sendResume(socket, attachment.serviceId, attachment.thumbprint, now);
    await this.ctx.storage.setAlarm(now + RESUME_ROTATE_MS);
  }

  private async sendResume(socket: WebSocket, serviceId: string, thumbprint: string, now: number): Promise<void> {
    const token = `${serviceId}.${randomValue()}`;
    await this.ctx.storage.put<StoredResume>(`resume:${await hashToken(token)}`, { exp: now + RESUME_TTL_MS, thumbprint });
    try {
      socket.send(JSON.stringify({ type: "resume", token, expires_in: RESUME_TTL_MS / 1000 }));
    } catch {
      // Closed meanwhile.
    }
  }

  private async purge(now: number): Promise<void> {
    const dead: string[] = [];
    for (const [key, exp] of await this.ctx.storage.list<number>({ prefix: "used:" })) if (exp < now) dead.push(key);
    for (const [key, r] of await this.ctx.storage.list<StoredResume>({ prefix: "resume:" })) if (r.exp < now) dead.push(key);
    if (dead.length > 0) await this.ctx.storage.delete(dead);
  }

  // The newest open socket; with `thumbprint`, only one opened with that key.
  private newest(thumbprint?: string): WebSocket | undefined {
    let best: { socket: WebSocket; at: number } | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const a = this.attachment(socket);
      if (!a || (thumbprint !== undefined && a.thumbprint !== thumbprint)) continue;
      if (!best || a.connectedAt >= best.at) best = { socket, at: a.connectedAt };
    }
    return best?.socket;
  }

  // `thumbprint` is the registration's key as the Worker read it: a socket opened with
  // another key gets nothing.
  async relay(request: RelayRequest, thumbprint: string): Promise<RelayResult> {
    if (request.body && request.body.byteLength > MAX_BODY_BYTES) return { error: "too_large" };
    const socket = this.newest(thumbprint);
    const connection = socket && this.attachment(socket)?.connection;
    if (!socket || !connection) return { error: "offline" };
    const id = crypto.randomUUID();
    const frame = JSON.stringify({
      type: "request",
      id,
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: request.body ? toBase64(request.body) : null,
    });
    return new Promise<RelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: "timeout" });
      }, RELAY_TIMEOUT_MS);
      this.pending.set(id, { connection, resolve, timer });
      try {
        socket.send(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: "offline" });
      }
    });
  }

  async status(): Promise<ConnectionStatus> {
    const stored = (await this.ctx.storage.get<ConnectionStatus>("status")) ?? { connected: false };
    return { ...stored, connected: this.newest() !== undefined };
  }

  // The registration was paired again with the key `thumbprint`: sockets and resume tokens of
  // the old key go, and the new key may open its first connection.
  async reset(thumbprint: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.thumbprint === thumbprint) continue;
      this.failPending(this.attachment(socket)?.connection);
      try {
        socket.close(CLOSE_REVOKED, "the registration was paired again with another key");
      } catch {
        // Already closing.
      }
    }
    const stale = [...(await this.ctx.storage.list<StoredResume>({ prefix: "resume:" }))].filter(([, r]) => r.thumbprint !== thumbprint).map(([k]) => k);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    if ((await this.ctx.storage.get("keySpent")) !== thumbprint) await this.ctx.storage.delete("keySpent");
  }

  // The registration was deleted: drop the socket and everything stored.
  async revoke(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      this.failPending(this.attachment(socket)?.connection);
      try {
        socket.close(CLOSE_REVOKED, "the registration was removed at the gateway");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAll();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connection = this.attachment(socket)?.connection;
    if (typeof message !== "string") return this.protocolError(socket, "frames must be JSON text");
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.protocolError(socket, "frames must be JSON text");
    }
    if (!frame || typeof frame !== "object") return this.protocolError(socket, "frames must be JSON objects");

    if (frame.type === "response") {
      const id = typeof frame.id === "string" ? frame.id : "";
      const waiting = this.pending.get(id);
      // An answer to a request that timed out, or one sent on another connection, is dropped.
      if (!waiting || waiting.connection !== connection) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.resolve(this.parseResponse(frame));
      return;
    }

    if (frame.type === "hello") {
      const description = typeof frame.description === "string" ? frame.description.slice(0, MAX_DESCRIPTION) : undefined;
      const version = typeof frame.version === "string" ? frame.version.slice(0, MAX_VERSION) : undefined;
      const status = (await this.ctx.storage.get<ConnectionStatus>("status")) ?? { connected: true };
      await this.ctx.storage.put<ConnectionStatus>("status", { ...status, description, version });
      return;
    }

    // A call back to the gateway as the owner (src/tunnel.ts handleCall).
    if (frame.type === "call") {
      const attachment = this.attachment(socket);
      if (!attachment) return this.protocolError(socket, "unknown connection");
      const { serviceId, thumbprint } = attachment;
      const busy = (this.callsInFlight.get(attachment.connection) ?? 0) >= MAX_CALLS_IN_FLIGHT;
      const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
      let result: Record<string, unknown>;
      if (busy) {
        result = { type: "call_result", id: frame.id, status: 429, headers: [["content-type", "application/json"]], body: btoa(`{"error":"at most ${MAX_CALLS_IN_FLIGHT} calls may be in flight on one connection"}`) };
      } else {
        this.callsInFlight.set(attachment.connection, (this.callsInFlight.get(attachment.connection) ?? 0) + 1);
        try {
          result = await handleCall(this.env, ctx, serviceId, thumbprint, frame);
        } catch (error) {
          console.error(JSON.stringify({ type: "tunnel_call_failed", tunnel: serviceId, error: String(error) }));
          result = { type: "call_result", id: frame.id, status: 502, headers: [["content-type", "application/json"]], body: btoa('{"error":"the gateway could not complete the call"}') };
        } finally {
          const n = (this.callsInFlight.get(attachment.connection) ?? 1) - 1;
          if (n > 0) this.callsInFlight.set(attachment.connection, n);
          else this.callsInFlight.delete(attachment.connection);
        }
      }
      try {
        socket.send(JSON.stringify(result));
      } catch {
        // The connection closed meanwhile.
      }
      return;
    }

    return this.protocolError(socket, `unknown frame type: ${String(frame.type)}`);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.failPending(this.attachment(socket)?.connection);
    // Completes the closing handshake (runtimes without auto-reply to close).
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    if (this.ctx.getWebSockets().filter((s) => s !== socket && s.readyState === WebSocket.OPEN).length === 0) {
      const status = await this.ctx.storage.get<ConnectionStatus>("status");
      if (status) await this.ctx.storage.put<ConnectionStatus>("status", { ...status, connected: false, disconnectedAt: Date.now() });
    }
    console.log(JSON.stringify({ type: "tunnel_disconnected", code, reason: reason.slice(0, 200) }));
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.failPending(this.attachment(socket)?.connection);
  }

  private parseResponse(frame: Record<string, unknown>): RelayResult {
    const status = frame.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return { error: "bad_response" };
    const headers = headerList(frame.headers);
    if (!headers) return { error: "bad_response" };
    let body: ArrayBuffer | null = null;
    if (typeof frame.body === "string") {
      try {
        body = fromBase64(frame.body);
      } catch {
        return { error: "bad_response" };
      }
      if (body.byteLength > MAX_BODY_BYTES) return { error: "too_large" };
    } else if (frame.body !== undefined && frame.body !== null) {
      return { error: "bad_response" };
    }
    return { status, headers, body };
  }

  private protocolError(socket: WebSocket, message: string): void {
    try {
      socket.send(JSON.stringify({ type: "error", message }));
      socket.close(CLOSE_PROTOCOL, message.slice(0, 120));
    } catch {
      // Already closing.
    }
  }

  private failPending(connection: string | undefined): void {
    for (const [id, waiting] of this.pending) {
      if (connection !== undefined && waiting.connection !== connection) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.resolve({ error: "closed" });
    }
  }

  private attachment(socket: WebSocket): Attachment | undefined {
    return (socket.deserializeAttachment() as Attachment | null) ?? undefined;
  }
}

export function connectionFor(env: Env, serviceId: string): DurableObjectStub<TunnelConnection> {
  const ns = tunnelNamespace(env);
  if (!ns) throw new Error("the deployment has no TUNNEL binding");
  return ns.get(ns.idFromName(serviceId));
}

// The binding is new (wrangler.example.jsonc migration v3); a deployment that has not added
// it yet has no tunnel connections.
export function tunnelNamespace(env: Env): DurableObjectNamespace<TunnelConnection> | undefined {
  return (env as unknown as { TUNNEL?: DurableObjectNamespace<TunnelConnection> }).TUNNEL;
}
