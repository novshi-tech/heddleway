import { DurableObject } from "cloudflare:workers";
import type { BasicAuth, HeadersAuth } from "./config";
import { decryptJson, encryptJson, importAesKey } from "./crypto";
import { upstreamTarget, type Upstream } from "./services";
import { refreshTokens, UpstreamOAuthError, type TokenSet } from "./upstream-oauth";

export interface CredentialInfo {
  id: string;
  service: string;
  // The service's display name when connected. Credentials from before one-per-service
  // (docs/adr/0004) may carry a name the user typed.
  label: string;
  createdAt: number;
  // Set when the upstream rejected the refresh token.
  needsReconnect?: boolean;
}

interface StoredCredential extends CredentialInfo {
  sealed: string;
  // upstreamTarget() when stored. Older credentials lack it until first used.
  target?: string;
}

// Values entered by the user: header values keyed by lower-case header name, or
// `username` and `password` for basic (no `username` when the definition fixes it).
export type HeaderSecrets = Record<string, string>;

// The names of the values a user enters for a service.
export function secretNames(auth: HeadersAuth | BasicAuth): string[] {
  if (auth.type === "basic") return auth.username === undefined ? ["username", "password"] : ["password"];
  return auth.headers.map((field) => field.name.toLowerCase());
}

// RFC 7617 with UTF-8.
export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export type HeadersResult =
  | { headers: Record<string, string> }
  | { error: "missing" | "reconnect" | "unavailable" }
  // The definition asks for a value this credential lacks: a header was renamed or added,
  // or a fixed basic user name was removed.
  | { error: "no_value"; field: string };

export const ALREADY_CONNECTED = "already connected";

// Refresh this long before the upstream says the access token expires.
const REFRESH_MARGIN_MS = 60 * 1000;

function info({ id, service, label, createdAt, needsReconnect }: StoredCredential): CredentialInfo {
  return needsReconnect ? { id, service, label, createdAt, needsReconnect } : { id, service, label, createdAt };
}

// One vault per user. A Durable Object runs one request at a time, but another
// can start while one awaits a fetch, so refreshes are shared per credential.
// The caller resolves the service and passes it in; the vault reads no service definitions.
export class UserVault extends DurableObject<Env> {
  private keyPromise?: Promise<CryptoKey>;
  private refreshing = new Map<string, Promise<HeadersResult>>();

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= importAesKey(this.env.ENCRYPTION_KEY);
    return this.keyPromise;
  }

  private aad(id: string): string {
    return `${this.ctx.id.toString()}:${id}`;
  }

  async list(): Promise<CredentialInfo[]> {
    const stored = await this.ctx.storage.list<StoredCredential>({ prefix: "cred:" });
    return [...stored.values()]
      .map(info)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<CredentialInfo | null> {
    const stored = await this.ctx.storage.get<StoredCredential>(`cred:${id}`);
    return stored ? info(stored) : null;
  }

  // One credential per service and user (docs/adr/0004): accounts of another organization
  // belong in that organization's gateway. Checked right before writing, with no await
  // other than storage in between, so two concurrent connects cannot both pass.
  private async alreadyConnected(service: string): Promise<boolean> {
    return (await this.list()).some((c) => c.service === service);
  }

  async add(upstream: Upstream, secrets: HeaderSecrets): Promise<CredentialInfo | { error: string }> {
    const { service, config } = upstream;
    if (config.auth.type === "identity") return { error: `${service} needs no credential` };
    if (config.auth.type === "client_credentials") return { error: `${service} is not connected by users` };
    if (config.auth.type !== "headers" && config.auth.type !== "basic") return { error: `${service} is connected with OAuth` };
    const values: HeaderSecrets = {};
    for (const name of secretNames(config.auth)) {
      const value = secrets[name]?.trim();
      if (!value) return { error: `missing value for ${name}` };
      values[name] = value;
    }
    const id = crypto.randomUUID();
    const info: CredentialInfo = { id, service, label: config.display_name ?? service, createdAt: Date.now() };
    const sealed = await encryptJson(await this.key(), values, this.aad(id));
    if (await this.alreadyConnected(service)) return { error: ALREADY_CONNECTED };
    await this.ctx.storage.put<StoredCredential>(`cred:${id}`, { ...info, sealed, target: upstreamTarget(upstream) });
    return info;
  }

  // Stores tokens from an OAuth connection; with `replaceId`, reconnects that credential.
  async addOAuth(
    upstream: Upstream,
    tokens: TokenSet,
    replaceId?: string,
  ): Promise<CredentialInfo | { error: string }> {
    const { service, config } = upstream;
    if (config.auth.type !== "oauth2") return { error: `${service} is not an OAuth service` };
    let record: CredentialInfo;
    if (replaceId) {
      const existing = await this.ctx.storage.get<StoredCredential>(`cred:${replaceId}`);
      if (!existing || existing.service !== service) return { error: "credential not found" };
      record = { id: replaceId, service, label: existing.label, createdAt: existing.createdAt };
    } else {
      record = { id: crypto.randomUUID(), service, label: config.display_name ?? service, createdAt: Date.now() };
    }
    const sealed = await encryptJson(await this.key(), tokens, this.aad(record.id));
    if (!replaceId && (await this.alreadyConnected(service))) return { error: ALREADY_CONNECTED };
    await this.ctx.storage.put<StoredCredential>(`cred:${record.id}`, { ...record, sealed, target: upstreamTarget(upstream) });
    return record;
  }

  // Whether the user turned a feature on (src/features.ts). Off until they do. A consent recorded
  // under one of the feature's former names counts (docs/adr/0009).
  async consented(feature: string, formerNames: string[] = []): Promise<boolean> {
    for (const name of [feature, ...formerNames]) {
      if ((await this.ctx.storage.get<boolean>(`consent:${name}`)) === true) return true;
    }
    return false;
  }

  // Recorded under the feature's name only; any record under a former name goes either way.
  async setConsent(feature: string, on: boolean, formerNames: string[] = []): Promise<void> {
    if (on) await this.ctx.storage.put(`consent:${feature}`, true);
    else await this.ctx.storage.delete(`consent:${feature}`);
    for (const name of formerNames) await this.ctx.storage.delete(`consent:${name}`);
  }

  async remove(id: string): Promise<boolean> {
    return this.ctx.storage.delete(`cred:${id}`);
  }

  // Returns the headers to inject into an upstream request for `upstream`.
  async headers(id: string, upstream: Upstream): Promise<HeadersResult> {
    const stored = await this.ctx.storage.get<StoredCredential>(`cred:${id}`);
    if (!stored || stored.service !== upstream.service) return { error: "missing" };
    if (stored.needsReconnect) return { error: "reconnect" };
    const target = upstreamTarget(upstream);
    if (stored.target === undefined) {
      await this.ctx.storage.put<StoredCredential>(`cred:${id}`, { ...stored, target });
    } else if (stored.target !== target) {
      console.warn(JSON.stringify({ type: "upstream_changed", credential: id, service: stored.service }));
      await this.ctx.storage.put<StoredCredential>(`cred:${id}`, { ...stored, needsReconnect: true });
      return { error: "reconnect" };
    }
    const config = upstream.config;
    if (config.auth.type === "oauth2") return this.oauthHeaders(id, stored, upstream);
    if (config.auth.type !== "headers" && config.auth.type !== "basic") return { error: "missing" };
    const values = await decryptJson<HeaderSecrets>(await this.key(), stored.sealed, this.aad(id));
    if (config.auth.type === "basic") {
      const username = config.auth.username ?? values.username;
      if (username === undefined) return { error: "no_value", field: "username" };
      if (values.password === undefined) return { error: "no_value", field: "password" };
      return { headers: { authorization: basicAuthorization(username, values.password) } };
    }
    const headers: Record<string, string> = {};
    for (const field of config.auth.headers) {
      const name = field.name.toLowerCase();
      if (values[name] === undefined) return { error: "no_value", field: `header ${field.name}` };
      headers[name] = `${field.prefix ?? ""}${values[name]}`;
    }
    return { headers };
  }

  private async oauthHeaders(id: string, stored: StoredCredential, upstream: Upstream): Promise<HeadersResult> {
    const tokens = await decryptJson<TokenSet>(await this.key(), stored.sealed, this.aad(id));
    if (tokens.expires_at === undefined || tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) {
      return { headers: { authorization: `Bearer ${tokens.access_token}` } };
    }
    let pending = this.refreshing.get(id);
    if (!pending) {
      pending = this.refresh(id, stored, tokens, upstream).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, pending);
    }
    return pending;
  }

  private async refresh(id: string, stored: StoredCredential, tokens: TokenSet, { config, client }: Upstream): Promise<HeadersResult> {
    if (config.auth.type !== "oauth2" || !client) return { error: "unavailable" };
    let next: TokenSet;
    try {
      next = await refreshTokens(config.auth, client, tokens);
    } catch (error) {
      if (!(error instanceof UpstreamOAuthError)) throw error;
      console.warn(JSON.stringify({ type: "refresh_failed", credential: id, reason: error.message }));
      if (!error.invalidGrant) return { error: "unavailable" };
      const current = await this.ctx.storage.get<StoredCredential>(`cred:${id}`);
      if (current?.sealed === stored.sealed) await this.ctx.storage.put(`cred:${id}`, { ...current, needsReconnect: true });
      return { error: "reconnect" };
    }
    // Skip the write if the credential was reconnected or deleted meanwhile.
    const current = await this.ctx.storage.get<StoredCredential>(`cred:${id}`);
    if (current?.sealed === stored.sealed) {
      const sealed = await encryptJson(await this.key(), next, this.aad(id));
      await this.ctx.storage.put<StoredCredential>(`cred:${id}`, { ...current, sealed });
    }
    return { headers: { authorization: `Bearer ${next.access_token}` } };
  }
}

export function vaultFor(env: Env, userId: string): DurableObjectStub<UserVault> {
  return env.VAULT.get(env.VAULT.idFromName(userId));
}
