import { DurableObject } from "cloudflare:workers";
import type { ServiceConfig } from "./config";
import { decryptJson, encryptJson, importAesKey } from "./crypto";
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

  async remove(name: string): Promise<boolean> {
    await this.ctx.storage.delete(`client:${name}`);
    return this.ctx.storage.delete(`svc:${name}`);
  }
}

export function registryFor(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}
