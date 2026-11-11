import { drizzle } from 'drizzle-orm/d1';
import { MurmurService, randomIds, systemClock } from './app/service';
import { DEFAULT_POLICY } from './domain';
import { verifyWebhookSignature } from './auth/webhook';
import { DummyConnector } from './connectors/dummy/connector';
import { D1DummyBackend } from './connectors/dummy/d1-backend';
import type { Connectors } from './connectors/types';
import { AiDecider } from './ingest/deciders';
import { AnthropicLlm } from './ingest/llm';
import { createApp, type ConnectorHttp } from './http/app';
import { d1Repo, type Db } from './store/d1';
import { Connections } from './app/connections';
import type { GatewayPort, UpstreamCall } from './ports/gateway';
import { GatewayGraphApi } from './connectors/graph/api';
import { SyncJob, type SyncQueue } from './connectors/graph/jobs';
import { jobsFromNotifications } from './connectors/graph/notifications';
import { GraphMailSync } from './connectors/graph/sync';
import { GatewayJiraApi } from './connectors/jira/api';
import { JiraSync } from './connectors/jira/sync';
import { GatewayTeamsApi } from './connectors/teams/api';
import { TeamsSync } from './connectors/teams/sync';
import { GatewayTodoApi } from './connectors/todo/api';
import { TodoSync } from './connectors/todo/sync';
import { randomHex, sha256Hex } from './connectors/secrets';
import { onceDirectory } from './connectors/directory-once';
import { D1ConnectorState } from './store/connector-state';

// Murmur の組み立て（0023）。env を読まず、入口が渡す設定とゲートウェイの口だけで組み立てる。
// 入口はゲートウェイの Worker（heddleway の src/murmur-feature.ts）で、口はゲートウェイの中核が実装する。

export interface MurmurConfig {
  /** 本体の D1（0021） */
  db: D1Database;
  anthropicApiKey: string;
  claudeModel: string;
  /** 区切りの AI 判断に渡す直近のスレッドの本数 */
  recentThreadLimit?: number;
  /** ダミーの Webhook の署名の鍵 */
  webhookSecret?: string;
  /** 参照専用の画面（/admin・timeline.html）の鍵 */
  timelineToken?: string;
  /** 取り込みのキュー（同時実行 1）。なければその場で処理する（ローカルの確認用） */
  queue?: Queue<SyncJob>;
  /** 共有リストを許すサービス（0037 の決定 4。管理者がデプロイの設定で決める。既定は許さない） */
  sharedServices?: readonly string[];
  /**
   * Google Tasks の見回りの間隔（分。0041 の決定 1）。Tasks は変更の通知がなく、1 日の API の上限があるので、
   * Gmail と別に延ばせるようにする。なければ見回りのたび（Cron の間隔）。Tasks のコネクタが使う
   */
  tasksPollMinutes?: number;
  /** 外部コネクタ（0024）。なければ /api/connections と Webhook の口は 404 */
  connectors?: {
    /** Murmur の公開 URL（Webhook の受け口の URL になる） */
    publicUrl: string;
    gateway: GatewayPort;
    /** Jira の Webhook の受け口の URL に入れる本人ごとの秘密を導く鍵（保管しない） */
    webhookKey: string;
  };
}

export interface MurmurHandlers {
  fetch(request: Request, ctx: ExecutionContext): Promise<Response>;
  /** 取り込みのポーリングと期限の見回り。外部コネクタはサブスクリプションの手入れと保険の delta をキューに頼む */
  scheduled(ctx: ExecutionContext): Promise<void>;
  /** 取り込みのキュー（同時実行 1）。失敗した仕事はキューが試し直す */
  queue(batch: MessageBatch<unknown>, ctx: ExecutionContext): Promise<void>;
}

const CHANNELS = ['email', 'slack', 'line', 'jira', 'bitbucket'] as const;

/** 組み立て（IO の配線）。D1 はバインディングなので接続を張ったり閉じたりしない */
function build(config: MurmurConfig): MurmurService {
  const db = drizzle(config.db) as Db;
  const llm = new AnthropicLlm({ apiKey: config.anthropicApiKey });
  const backend = new D1DummyBackend(db);
  const connectors: Connectors = Object.fromEntries(
    CHANNELS.map((ch) => [ch, new DummyConnector(ch, backend)]),
  );
  return new MurmurService({
    repo: d1Repo(db),
    clock: systemClock,
    newId: randomIds,
    decider: new AiDecider(llm, config.claudeModel),
    connectors,
    policy: {
      recentThreadLimit: config.recentThreadLimit ?? DEFAULT_POLICY.recentThreadLimit,
    },
  });
}

interface ConnectorShell extends ConnectorHttp {
  /** キューの仕事を Outlook・Jira・Teams・To Do に渡す（それぞれ自分の経路のデータソースだけ扱う） */
  sync: { handle(job: SyncJob): Promise<void> };
}

/** 外部コネクタの配線。ゲートウェイを呼ぶ仕事は全部 queue を通す（Queues がなければ waitUntil でその場で） */
function buildConnectors(config: MurmurConfig, service: MurmurService, waitUntil: (p: Promise<unknown>) => void): ConnectorShell | null {
  const c = config.connectors;
  if (!c) return null;
  const { gateway } = c;
  const publicUrl = c.publicUrl.replace(/\/+$/, '');
  const now = () => new Date().toISOString();
  const state = new D1ConnectorState(drizzle(config.db) as Db);
  const graphFor = (call: UpstreamCall) => new GatewayGraphApi(call);
  const jiraFor = (call: UpstreamCall) => new GatewayJiraApi(call);
  const teamsFor = (call: UpstreamCall) => new GatewayTeamsApi(call);
  const todoFor = (call: UpstreamCall) => new GatewayTodoApi(call);
  // Jira の Webhook の受け口の秘密（本人ごと。S0: REST の Webhook の URL は本人ごとに 1 つ）。鍵から導くので保管しない
  const jiraSecret = (userId: string) => sha256Hex(`${c.webhookKey}:jira-webhook:${userId}`);

  let sync: ConnectorShell['sync'];
  const queue: SyncQueue = config.queue
    ? { send: async (job) => void (await config.queue!.send(job)) }
    : { send: async (job) => waitUntil(sync.handle(job).catch((err) => console.error(JSON.stringify({ msg: 'sync_failed', job, error: String(err) })))) };
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
  const jira = new JiraSync({
    service,
    state,
    queue,
    jiraFor: async (source) => jiraFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'jira')),
    now,
    webhookUrlFor: async (userId) => `${publicUrl}/webhooks/jira/${await jiraSecret(userId)}`,
    log,
  });
  const graph = new GraphMailSync({
    service,
    state,
    queue,
    graphFor: async (source) => graphFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'graph')),
    now,
    notificationUrl: `${publicUrl}/webhooks/graph`,
    newClientState: () => randomHex(32),
    hash: sha256Hex,
    log,
  });
  const teams = new TeamsSync({
    service,
    state,
    queue,
    teamsFor: async (source) => teamsFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'teams')),
    now,
    notificationUrl: `${publicUrl}/webhooks/graph`,
    newClientState: () => randomHex(32),
    hash: sha256Hex,
    log,
  });
  const todo = new TodoSync({
    service,
    state,
    queue,
    todoFor: async (source) => todoFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'graph')),
    now,
    notificationUrl: `${publicUrl}/webhooks/graph`,
    newClientState: () => randomHex(32),
    hash: sha256Hex,
    log,
  });
  sync = {
    async handle(job) {
      // 見回りは、マスタを 1 回だけ読んで全コネクタの全データソースで使い回す
      const directory = job.kind === 'maintain' ? onceDirectory(() => service.directory()) : undefined;
      await graph.handle(job, directory);
      await jira.handle(job, directory);
      await teams.handle(job, directory);
      await todo.handle(job, directory);
    },
  };
  const connections = new Connections({ gateway, service, queue, newId: randomIds, graphFor, jiraFor, teamsFor, todoFor, state, now, sharedServices: config.sharedServices ?? [] });
  return {
    sync,
    connections,
    notifications: async (body) => {
      const { jobs, rejected } = await jobsFromNotifications(body, { subscription: (id) => state.subscription(id), hash: sha256Hex });
      if (rejected > 0) console.warn(JSON.stringify({ msg: 'graph_notification_rejected', rejected }));
      for (const job of jobs) await queue.send(job);
      return jobs.length;
    },
    jiraNotified: async (secret, body) => {
      const users = [...new Set((await state.sources()).filter((s) => s.kind === 'jira').map((s) => s.userId))];
      for (const userId of users) {
        if ((await jiraSecret(userId)) !== secret) continue;
        // 本文の形を確かめるため、キーと種類だけ残す（0034 の S0 の残り。中身は使わない）
        const b = (body ?? {}) as Record<string, unknown>;
        log({ msg: 'jira_webhook', keys: Object.keys(b).sort(), webhookEvent: b.webhookEvent, matchedWebhookIds: b.matchedWebhookIds });
        return jira.notified(userId);
      }
      console.warn(JSON.stringify({ msg: 'jira_webhook_rejected' }));
      return null;
    },
  };
}

/** API のトークンの確かめ方。外部コネクタの設定がなくても API は使うので、口とは別に渡せる */
export function createMurmur(config: MurmurConfig, authenticate: GatewayPort['authenticate']): MurmurHandlers {
  return {
    async fetch(request, ctx) {
      const service = build(config);
      let shell: ConnectorShell | null | undefined;
      const app = createApp({
        service: () => service,
        authenticate,
        webhookVerify: (body, sig) => (config.webhookSecret ? verifyWebhookSignature(body, sig, config.webhookSecret) : Promise.resolve(false)),
        timelineToken: config.timelineToken,
        connectors: () => (shell === undefined ? (shell = buildConnectors(config, service, (p) => ctx.waitUntil(p))) : shell),
      });
      return app.fetch(request);
    },

    async scheduled(ctx) {
      const service = build(config);
      const r = await service.tick();
      console.log(JSON.stringify({ msg: 'tick', ...r }));
      const shell = buildConnectors(config, service, (p) => ctx.waitUntil(p));
      if (shell) await (config.queue ? config.queue.send({ kind: 'maintain' }) : shell.sync.handle({ kind: 'maintain' }));
    },

    async queue(batch, ctx) {
      const service = build(config);
      const shell = buildConnectors(config, service, (p) => ctx.waitUntil(p));
      for (const message of batch.messages) {
        const job = SyncJob.safeParse(message.body);
        if (!shell || !job.success) {
          message.ack();
          continue;
        }
        try {
          await shell.sync.handle(job.data);
          message.ack();
        } catch (err) {
          console.error(JSON.stringify({ msg: 'sync_failed', job: job.data, error: String(err) }));
          message.retry();
        }
      }
    },
  };
}
