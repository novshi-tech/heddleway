import { DurableObject } from "cloudflare:workers";

// The live side of a reverse connection (docs/adr/0003): one object per local service holds
// the WebSocket that the service opened to the gateway, and relays requests over it. The
// Worker checks who may connect and who may call (src/reverse.ts) before it reaches here;
// this object only keeps the socket, matches answers to requests, and remembers the
// description the service sent. The wire format is in docs/reverse-protocol.md.

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

// What the Worker tells this object when it hands over an upgrade it already verified.
export interface ConnectGrant {
  serviceId: string;
  name: string;
  // The one-time challenge the service signed, and when it expires (ms), so that a
  // signature cannot open a second connection.
  challenge: string;
  challengeExpiresAt: number;
}

interface Attachment {
  connection: string;
  connectedAt: number;
}

interface Pending {
  connection: string;
  resolve(result: RelayResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export const GRANT_HEADER = "x-heddleway-reverse-grant";


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

export class ReverseConnection extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // The upgrade, already verified by the Worker (src/reverse.ts reverseConnect).
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const grant = JSON.parse(request.headers.get(GRANT_HEADER) ?? "null") as ConnectGrant | null;
    if (!grant) return Response.json({ error: "missing grant" }, { status: 400 });

    // A signed challenge opens one connection only.
    const now = Date.now();
    const used = await this.ctx.storage.list<number>({ prefix: "used:" });
    const expired = [...used].filter(([, exp]) => exp < now).map(([key]) => key);
    if (expired.length > 0) await this.ctx.storage.delete(expired);
    if (used.has(`used:${grant.challenge}`) && !expired.includes(`used:${grant.challenge}`)) {
      return Response.json({ error: "the challenge was already used; request a new one" }, { status: 401 });
    }
    await this.ctx.storage.put(`used:${grant.challenge}`, grant.challengeExpiresAt);

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
    const attachment: Attachment = { connection: crypto.randomUUID(), connectedAt: now };
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
    console.log(JSON.stringify({ type: "reverse_connected", service: grant.serviceId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async relay(request: RelayRequest): Promise<RelayResult> {
    if (request.body && request.body.byteLength > MAX_BODY_BYTES) return { error: "too_large" };
    const socket = this.ctx.getWebSockets().at(-1);
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
    return { ...stored, connected: this.ctx.getWebSockets().length > 0 };
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
    if (this.ctx.getWebSockets().filter((s) => s !== socket).length === 0) {
      const status = await this.ctx.storage.get<ConnectionStatus>("status");
      if (status) await this.ctx.storage.put<ConnectionStatus>("status", { ...status, connected: false, disconnectedAt: Date.now() });
    }
    console.log(JSON.stringify({ type: "reverse_disconnected", code, reason: reason.slice(0, 200) }));
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

export function connectionFor(env: Env, serviceId: string): DurableObjectStub<ReverseConnection> {
  const ns = reverseNamespace(env);
  if (!ns) throw new Error("the deployment has no REVERSE binding");
  return ns.get(ns.idFromName(serviceId));
}

// The binding is new (wrangler.example.jsonc migration v3); a deployment that has not added
// it yet has no reverse connections.
export function reverseNamespace(env: Env): DurableObjectNamespace<ReverseConnection> | undefined {
  return (env as unknown as { REVERSE?: DurableObjectNamespace<ReverseConnection> }).REVERSE;
}
