import { and, eq, lt } from 'drizzle-orm';
import type { SourceState, SubscriptionRecord } from '../connectors/graph/state';
import type { Db } from './d1';
import * as schema from './schema';

// 取り込みの運用の状態のストア（0024）。メモリ実装と D1 実装。

export interface PendingAuthorization {
  state: string;
  userId: string;
  /** 口の実装（同意）が使う値。今は使っていない（空）。列の名前は前の形（PKCE の verifier）のまま */
  verifier: string;
  /** 本人が選んだゲートウェイの接続（なければ 1 つだけのときに選ぶ） */
  credentialId: string | null;
  createdAt: string;
  /** 何をつなぐ途中か。なければ Outlook（Jira より前の行）。Jira はサイトと範囲の JQL も持ち越す（0034） */
  request?:
    | { kind: 'outlook' }
    | { kind: 'gmail' }
    | { kind: 'jira'; cloudId?: string; projectKey?: string }
    | { kind: 'teams'; teamId?: string; channelId?: string }
    | { kind: 'todo'; listId?: string }
    | { kind: 'google-tasks'; listId?: string };
}

export interface ConnectorStateStore {
  putPending(p: PendingAuthorization): Promise<void>;
  /** 取り出して消す。olderThan より前に作ったものは捨てる */
  takePending(state: string, notBefore: string): Promise<PendingAuthorization | null>;

  source(dataSourceId: string): Promise<SourceState | null>;
  sources(): Promise<SourceState[]>;
  putSource(s: SourceState): Promise<void>;

  subscription(id: string): Promise<SubscriptionRecord | null>;
  subscriptions(dataSourceId: string): Promise<SubscriptionRecord[]>;
  putSubscription(s: SubscriptionRecord): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
}

export class MemoryConnectorState implements ConnectorStateStore {
  readonly pending = new Map<string, PendingAuthorization>();
  readonly sourceMap = new Map<string, SourceState>();
  readonly subs = new Map<string, SubscriptionRecord>();

  async putPending(p: PendingAuthorization) {
    this.pending.set(p.state, structuredClone(p));
  }
  async takePending(state: string, notBefore: string) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    return p && p.createdAt >= notBefore ? p : null;
  }
  async source(id: string) {
    const s = this.sourceMap.get(id);
    return s ? structuredClone(s) : null;
  }
  async sources() {
    return [...this.sourceMap.values()].map((s) => structuredClone(s));
  }
  async putSource(s: SourceState) {
    this.sourceMap.set(s.dataSourceId, structuredClone(s));
  }
  async subscription(id: string) {
    const s = this.subs.get(id);
    return s ? structuredClone(s) : null;
  }
  async subscriptions(dataSourceId: string) {
    return [...this.subs.values()].filter((s) => s.dataSourceId === dataSourceId).map((s) => structuredClone(s));
  }
  async putSubscription(s: SubscriptionRecord) {
    this.subs.set(s.id, structuredClone(s));
  }
  async deleteSubscription(id: string) {
    this.subs.delete(id);
  }
}

export class D1ConnectorState implements ConnectorStateStore {
  constructor(private readonly db: Db) {}

  async putPending(p: PendingAuthorization) {
    await this.db.insert(schema.oauthPending).values({ state: p.state, createdAt: p.createdAt, data: p });
  }

  async takePending(state: string, notBefore: string) {
    // 古いものはついでに掃除する
    await this.db.delete(schema.oauthPending).where(lt(schema.oauthPending.createdAt, notBefore));
    const [row] = await this.db.delete(schema.oauthPending).where(eq(schema.oauthPending.state, state)).returning();
    return row ? (row.data as PendingAuthorization) : null;
  }

  async source(id: string) {
    const [row] = await this.db.select().from(schema.connectorSources).where(eq(schema.connectorSources.dataSourceId, id));
    return row ? (row.data as SourceState) : null;
  }

  async sources() {
    const rows = await this.db.select().from(schema.connectorSources);
    return rows.map((r) => r.data as SourceState);
  }

  async putSource(s: SourceState) {
    await this.db
      .insert(schema.connectorSources)
      .values({ dataSourceId: s.dataSourceId, userId: s.userId, data: s })
      .onConflictDoUpdate({ target: schema.connectorSources.dataSourceId, set: { userId: s.userId, data: s } });
  }

  async subscription(id: string) {
    const [row] = await this.db.select().from(schema.graphSubscriptions).where(eq(schema.graphSubscriptions.id, id));
    return row ? (row.data as SubscriptionRecord) : null;
  }

  async subscriptions(dataSourceId: string) {
    const rows = await this.db.select().from(schema.graphSubscriptions).where(eq(schema.graphSubscriptions.dataSourceId, dataSourceId));
    return rows.map((r) => r.data as SubscriptionRecord);
  }

  async putSubscription(s: SubscriptionRecord) {
    await this.db
      .insert(schema.graphSubscriptions)
      .values({ id: s.id, dataSourceId: s.dataSourceId, data: s })
      .onConflictDoUpdate({ target: schema.graphSubscriptions.id, set: { dataSourceId: s.dataSourceId, data: s } });
  }

  async deleteSubscription(id: string) {
    await this.db.delete(schema.graphSubscriptions).where(eq(schema.graphSubscriptions.id, id));
  }
}
