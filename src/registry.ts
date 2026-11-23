import { DurableObject } from "cloudflare:workers";
import type { AppEntry } from "./apps";
import type { ServiceConfig } from "./config";
import { decryptJson, encryptJson, importAesKey } from "./crypto";
import type { Pairing, PairingDecision, PairingPoll, ReverseService } from "./reverse";
import type { OAuthClient } from "./upstream-oauth";

export interface RegistryEntry {
  config: ServiceConfig;
  updatedAt: number;
  updatedBy: string;
}

export interface RegistrySnapshot {
  services: Record<string, RegistryEntry>;
  // OAuth clients of admin-registered services, by service name.
  clients: Record<string, OAuthClient>;
  // OAuth clients that admins set for built-in and SERVICES services, by client name
  // (`auth.client`, or the service name). OAUTH_<CLIENT>_* secrets take precedence.
  sharedClients: Record<string, OAuthClient>;
}

// A plugin zip an admin uploaded for users to download (src/plugins.ts).
export interface PluginMeta {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  size: number;
  updatedAt: number;
  updatedBy: string;
}

// Services that admins register from the web UI, shared by everyone: one object
// for the whole deployment. Callers validate definitions before putting them.
export class Registry extends DurableObject<Env> {
  private keyPromise?: Promise<CryptoKey>;

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= importAesKey(this.env.ENCRYPTION_KEY);
    return this.keyPromise;
  }

  async snapshot(): Promise<RegistrySnapshot> {
    const services: Record<string, RegistryEntry> = {};
    for (const [key, entry] of await this.ctx.storage.list<RegistryEntry>({ prefix: "svc:" })) services[key.slice(4)] = entry;
    const clients: Record<string, OAuthClient> = {};
    for (const [key, sealed] of await this.ctx.storage.list<string>({ prefix: "client:" })) {
      clients[key.slice(7)] = await decryptJson<OAuthClient>(await this.key(), sealed, key);
    }
    const sharedClients: Record<string, OAuthClient> = {};
    for (const [key, sealed] of await this.ctx.storage.list<string>({ prefix: "oauthclient:" })) {
      sharedClients[key.slice(12)] = await decryptJson<OAuthClient>(await this.key(), sealed, key);
    }
    return { services, clients, sharedClients };
  }

  // The client of built-in and SERVICES services named `name`; null removes it.
  async putSharedClient(name: string, client: OAuthClient | null): Promise<boolean> {
    const key = `oauthclient:${name}`;
    if (client === null) return this.ctx.storage.delete(key);
    await this.ctx.storage.put(key, await encryptJson(await this.key(), client, key));
    return true;
  }

  // `client` undefined keeps the stored one; null removes it.
  async put(name: string, config: ServiceConfig, client: OAuthClient | null | undefined, updatedBy: string): Promise<void> {
    await this.ctx.storage.put<RegistryEntry>(`svc:${name}`, { config, updatedAt: Date.now(), updatedBy });
    if (client === null) await this.ctx.storage.delete(`client:${name}`);
    else if (client) await this.ctx.storage.put(`client:${name}`, await encryptJson(await this.key(), client, `client:${name}`));
  }

  // Metadata under "plugin:", the zip itself under "pluginzip:", so listing reads no zips.
  async listPlugins(): Promise<PluginMeta[]> {
    return [...(await this.ctx.storage.list<PluginMeta>({ prefix: "plugin:" })).values()];
  }

  async getPlugin(name: string): Promise<{ meta: PluginMeta; zip: ArrayBuffer } | null> {
    const [meta, zip] = await Promise.all([this.ctx.storage.get<PluginMeta>(`plugin:${name}`), this.ctx.storage.get<ArrayBuffer>(`pluginzip:${name}`)]);
    return meta && zip ? { meta, zip } : null;
  }

  async putPlugin(meta: Omit<PluginMeta, "updatedAt">, zip: ArrayBuffer): Promise<void> {
    await this.ctx.storage.put({ [`plugin:${meta.name}`]: { ...meta, updatedAt: Date.now() }, [`pluginzip:${meta.name}`]: zip });
  }

  async removePlugin(name: string): Promise<boolean> {
    await this.ctx.storage.delete(`pluginzip:${name}`);
    return this.ctx.storage.delete(`plugin:${name}`);
  }

  // Apps (src/apps.ts) under "app:", the definition as the admin approved it.
  async listApps(): Promise<AppEntry[]> {
    return [...(await this.ctx.storage.list<AppEntry>({ prefix: "app:" })).values()];
  }

  async getApp(name: string): Promise<AppEntry | null> {
    return (await this.ctx.storage.get<AppEntry>(`app:${name}`)) ?? null;
  }

  async putApp(entry: AppEntry): Promise<void> {
    await this.ctx.storage.put<AppEntry>(`app:${entry.definition.name}`, entry);
  }

  async removeApp(name: string): Promise<boolean> {
    return this.ctx.storage.delete(`app:${name}`);
  }

  // Reverse connections (src/reverse.ts, docs/adr/0003): the registrations under "reverse:",
  // pending pairings under "pairing:<hash of the code>", and the pairing's poll ID under
  // "pairpoll:<hash>". One object for the deployment, so approving a code is atomic.
  async listReverse(): Promise<ReverseService[]> {
    return [...(await this.ctx.storage.list<ReverseService>({ prefix: "reverse:" })).values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getReverse(id: string): Promise<ReverseService | null> {
    return (await this.ctx.storage.get<ReverseService>(`reverse:${id}`)) ?? null;
  }

  async setReverseCallback(id: string, owner: string, callback: string[]): Promise<ReverseService | null> {
    const service = await this.getReverse(id);
    if (!service || service.owner !== owner) return null;
    const next = { ...service, callback };
    await this.ctx.storage.put(`reverse:${id}`, next);
    return next;
  }

  async removeReverse(id: string): Promise<boolean> {
    return this.ctx.storage.delete(`reverse:${id}`);
  }

  private async sweepPairings(now: number): Promise<Pairing[]> {
    const all = await this.ctx.storage.list<Pairing>({ prefix: "pairing:" });
    const live: Pairing[] = [];
    const dead: string[] = [];
    for (const [key, p] of all) {
      if (p.expiresAt < now) dead.push(key, `pairpoll:${p.pollHash}`);
      else live.push(p);
    }
    if (dead.length > 0) await this.ctx.storage.delete(dead);
    return live;
  }

  // false when too many pairings are pending, in all or from the pairing's address: the
  // endpoint is open to anyone.
  async createPairing(pairing: Pairing, maxPending: number, maxPerSource: number): Promise<boolean> {
    const pending = (await this.sweepPairings(Date.now())).filter((p) => p.status === "pending");
    if (pending.length >= maxPending) return false;
    if (pairing.source && pending.filter((p) => p.source === pairing.source).length >= maxPerSource) return false;
    await this.ctx.storage.put({ [`pairing:${pairing.codeHash}`]: pairing, [`pairpoll:${pairing.pollHash}`]: pairing.codeHash });
    return true;
  }

  // A pending pairing that has not expired.
  async getPairing(codeHash: string): Promise<Pairing | null> {
    const p = await this.ctx.storage.get<Pairing>(`pairing:${codeHash}`);
    return p && p.status === "pending" && p.expiresAt >= Date.now() ? p : null;
  }

  // Approving stores the registration. The name must be free among the owner's services, unless
  // the owner confirmed replacing the service of that name (`replaces`, its ID): the new
  // registration then takes over that ID in the same write, so that nothing is lost if this
  // fails, and what holds `reverse:<ID>` keeps working.
  async decidePairing(codeHash: string, decision: PairingDecision, pollTtlMs: number, replaces?: string): Promise<{ status: "ok"; service?: ReverseService; replaced?: ReverseService } | { status: "expired" | "name_taken" }> {
    const p = await this.getPairing(codeHash);
    if (!p) return { status: "expired" };
    const expiresAt = Date.now() + pollTtlMs;
    if (decision === "deny") {
      await this.ctx.storage.put<Pairing>(`pairing:${codeHash}`, { ...p, status: "denied", expiresAt });
      return { status: "ok" };
    }
    const existing = (await this.listReverse()).find((s) => s.owner === decision.owner && s.name === decision.name);
    if (existing && existing.id !== replaces) return { status: "name_taken" };
    const service: ReverseService = { ...decision, id: existing?.id ?? decision.id };
    await this.ctx.storage.put({
      [`reverse:${service.id}`]: service,
      [`pairing:${codeHash}`]: { ...p, status: "approved", serviceId: service.id, expiresAt } satisfies Pairing,
    });
    return { status: "ok", service, ...(existing ? { replaced: existing } : {}) };
  }

  // What the local service learns when it polls; a decided pairing is told once, then forgotten.
  async pollPairing(pollHash: string): Promise<PairingPoll> {
    const codeHash = await this.ctx.storage.get<string>(`pairpoll:${pollHash}`);
    const p = codeHash ? await this.ctx.storage.get<Pairing>(`pairing:${codeHash}`) : undefined;
    if (!codeHash || !p || p.expiresAt < Date.now()) return { status: "expired" };
    if (p.status === "pending") return { status: "pending" };
    await this.ctx.storage.delete([`pairing:${codeHash}`, `pairpoll:${pollHash}`]);
    if (p.status === "denied") return { status: "denied" };
    const service = p.serviceId ? await this.getReverse(p.serviceId) : null;
    return service ? { status: "approved", service } : { status: "expired" };
  }

  async remove(name: string): Promise<boolean> {
    await this.ctx.storage.delete(`client:${name}`);
    return this.ctx.storage.delete(`svc:${name}`);
  }
}

export function registryFor(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}
