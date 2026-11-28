import { drizzle } from 'drizzle-orm/d1';
import { TopicIndexService, randomIds, systemClock } from './app/service';
import { DEFAULT_POLICY, type ThreadingMode } from './domain';
import { verifyWebhookSignature } from './auth/webhook';
import { DummyConnector } from './connectors/dummy/connector';
import { D1DummyBackend } from './connectors/dummy/d1-backend';
import type { Connectors } from './connectors/types';
import { AiDecider } from './ingest/deciders';
import { AnthropicLlm } from './ingest/llm';
import { createApp, type ConnectorHttp } from './http/app';
import { kindOf, renderMyLists } from './http/my-lists';
import { renderNow, renderSection, renderThread, tabs, type NowSection, type PageList } from './http/now';
import type { ConnectionView } from './app/connections';
import type { ListView } from './domain';
import { d1Repo, type Db } from './store/d1';
import { Connections } from './app/connections';
import { GatewayAuthError, type GatewayPort, type UpstreamCall } from './ports/gateway';
import { GatewayGraphApi } from './connectors/graph/api';
import { SyncJob, type SyncQueue } from './connectors/graph/jobs';
import { jobsFromNotifications } from './connectors/graph/notifications';
import { GraphMailSync } from './connectors/graph/sync';
import { GatewayJiraApi } from './connectors/jira/api';
import { JiraSync } from './connectors/jira/sync';
import { GatewayTeamsApi } from './connectors/teams/api';
import { TeamsSync } from './connectors/teams/sync';
import { GatewayTeamsChatApi } from './connectors/teams-chat/api';
import { TeamsChatSync } from './connectors/teams-chat/sync';
import { GatewayTodoApi } from './connectors/todo/api';
import { TodoSync } from './connectors/todo/sync';
import { GatewayGtasksApi } from './connectors/gtasks/api';
import { GtasksSync } from './connectors/gtasks/sync';
import { GatewayGmailApi } from './connectors/gmail/api';
import { GmailSync } from './connectors/gmail/sync';
import { GatewayGoogleChatApi } from './connectors/google-chat/api';
import { GoogleChatSync } from './connectors/google-chat/sync';
import { GatewayLineApi, lineTalkUrl } from './connectors/line/api';
import { LineSync } from './connectors/line/sync';
import { randomHex, sha256Hex } from './connectors/secrets';
import { onceDirectory } from './connectors/directory-once';
import { D1ConnectorState } from './store/connector-state';

// トピック索引の組み立て（0023）。env を読まず、入口が渡す設定とゲートウェイの口だけで組み立てる。
// 入口はゲートウェイの Worker（heddleway の src/topic-index-feature.ts）で、口はゲートウェイの中核が実装する。

export interface TopicIndexConfig {
  /** 本体の D1（0021） */
  db: D1Database;
  /**
   * 区切りの方式（0050）。ai は Claude で区切る（anthropicApiKey が要る）。source は AI を使わず、ソースのスレッドだけで区切る
   * （鍵は要らない。スレッドで区切れないリストはつながない）。省略は ai
   */
  threading?: ThreadingMode;
  /** threading が ai のときだけ要る */
  anthropicApiKey?: string;
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
    /** トピック索引の公開 URL（Webhook の受け口の URL になる） */
    publicUrl: string;
    gateway: GatewayPort;
    /** Jira の Webhook の受け口の URL に入れる本人ごとの秘密を導く鍵（保管しない） */
    webhookKey: string;
  };
}

export interface TopicIndexHandlers {
  fetch(request: Request, ctx: ExecutionContext): Promise<Response>;
  /** 取り込みのポーリングと期限の見回り。外部コネクタはサブスクリプションの手入れと保険の delta をキューに頼む */
  scheduled(ctx: ExecutionContext): Promise<void>;
  /** 取り込みのキュー（同時実行 1）。失敗した仕事はキューが試し直す */
  queue(batch: MessageBatch<unknown>, ctx: ExecutionContext): Promise<void>;
  /**
   * 本人の画面の本文（HTML の断片。0048・0051）。ゲートウェイがサインインを確かめた本人の User ID と、画面の根（base、例 /features/topic-index）の下の
   * 経路（path。'' は今やること、'lists' は参加中のリスト、'threads/<ID>' はトピックの詳細）で呼び、自分の枠に入れて出す。
   * 読むのはトピック索引の中だけで、上流は呼ばない。ない経路・見えないトピックは null
   */
  userPage(userId: string, page: { path: string; base: string }, ctx: ExecutionContext): Promise<{ title: string; body: string } | null>;
  /** 本人の画面を Heddleway のトップにするか（どれかのリストのメンバーなら。ゲートウェイの docs/adr/0011）。User を作らない */
  isHome(userId: string): Promise<boolean>;
}

const CHANNELS = ['email', 'slack', 'line', 'jira', 'bitbucket'] as const;

/** 組み立て（IO の配線）。D1 はバインディングなので接続を張ったり閉じたりしない */
function build(config: TopicIndexConfig): TopicIndexService {
  const db = drizzle(config.db) as Db;
  const threading = config.threading ?? 'ai';
  if (threading === 'ai' && !config.anthropicApiKey) throw new Error('topic-index: threading=ai には anthropicApiKey が要る');
  const backend = new D1DummyBackend(db);
  const connectors: Connectors = Object.fromEntries(
    CHANNELS.map((ch) => [ch, new DummyConnector(ch, backend)]),
  );
  return new TopicIndexService({
    repo: d1Repo(db),
    clock: systemClock,
    newId: randomIds,
    decider: threading === 'ai' ? new AiDecider(new AnthropicLlm({ apiKey: config.anthropicApiKey! }), config.claudeModel) : undefined,
    connectors,
    policy: {
      recentThreadLimit: config.recentThreadLimit ?? DEFAULT_POLICY.recentThreadLimit,
      candidateWindowDays: DEFAULT_POLICY.candidateWindowDays,
      candidateWindowLimit: DEFAULT_POLICY.candidateWindowLimit,
      threading,
    },
  });
}

interface ConnectorShell extends ConnectorHttp {
  /** キューの仕事を Outlook・Gmail・Jira・Teams（チャネルとチャット）・Google Chat・To Do・Google Tasks・LINE に渡す（それぞれ自分の経路のデータソースだけ扱う） */
  sync: { handle(job: SyncJob): Promise<void> };
}

/** 外部コネクタの配線。ゲートウェイを呼ぶ仕事は全部 queue を通す（Queues がなければ waitUntil でその場で） */
function buildConnectors(config: TopicIndexConfig, service: TopicIndexService, waitUntil: (p: Promise<unknown>) => void): ConnectorShell | null {
  const c = config.connectors;
  if (!c) return null;
  const { gateway } = c;
  const publicUrl = c.publicUrl.replace(/\/+$/, '');
  const now = () => new Date().toISOString();
  const state = new D1ConnectorState(drizzle(config.db) as Db);
  const graphFor = (call: UpstreamCall) => new GatewayGraphApi(call);
  const jiraFor = (call: UpstreamCall) => new GatewayJiraApi(call);
  const teamsFor = (call: UpstreamCall) => new GatewayTeamsApi(call);
  const teamsChatFor = (call: UpstreamCall) => new GatewayTeamsChatApi(call);
  const todoFor = (call: UpstreamCall) => new GatewayTodoApi(call);
  const gtasksFor = (call: UpstreamCall) => new GatewayGtasksApi(call);
  const gmailFor = (call: UpstreamCall) => new GatewayGmailApi(call);
  const googleChatFor = (call: UpstreamCall) => new GatewayGoogleChatApi(call);
  const lineFor = (call: UpstreamCall) => new GatewayLineApi(call);
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
    // 共有メールボックスの読者の確かめ直し（0042）: 読者それぞれの graph の接続。同意がなければ読めない人として扱う
    graphsOfUser: async (userId) => {
      let creds;
      try {
        creds = await gateway.credentials(userId, 'graph');
      } catch (err) {
        if (err instanceof GatewayAuthError) return [];
        throw err;
      }
      const out = [];
      for (const cred of creds) {
        try {
          out.push({ credentialId: cred.id, graph: graphFor(await gateway.upstream(userId, cred.id, 'graph')) });
        } catch (err) {
          if (!(err instanceof GatewayAuthError)) throw err;
        }
      }
      return out;
    },
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
  // Teams のチャット（0044）: 本人の全チャットの購読の通知と、保険の見回り。受け口と台帳は Outlook・Teams のチャネルと同じ
  const teamsChat = new TeamsChatSync({
    service,
    state,
    queue,
    chatsFor: async (source) => teamsChatFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'teams-chat')),
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
  // Google Tasks は変更の通知がなく、見回りで読む（キューの仕事は maintain と setup だけ。0041）
  const gtasks = new GtasksSync({
    service,
    state,
    gtasksFor: async (source) => gtasksFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'gtasks')),
    now,
    pollMinutes: config.tasksPollMinutes,
    log,
  });
  // Gmail も変更の通知を使わず、見回りで履歴を読む（キューの仕事は maintain と setup だけ。0041）
  const gmail = new GmailSync({
    service,
    state,
    gmailFor: async (source) => gmailFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'gmail')),
    now,
    log,
  });
  // Google Chat（0045）も変更の通知を使わず、見回りで読む。スペースと DM で読める口（種類）が違う
  const googleChat = new GoogleChatSync({
    service,
    state,
    chatFor: async (source) => googleChatFor(await gateway.upstream(source.userId, source.gatewayCredentialId, source.kind === 'google-chat-dm' ? 'google-chat-dm' : 'google-chat')),
    now,
    log,
  });
  // LINE 公式アカウント（0049）: 受け口（業務システム）の原本を見回りで読む。読者は自分の受け口の接続で読めた人
  const line = new LineSync({
    service,
    state,
    lineFor: async (source) => lineFor(await gateway.upstream(source.userId, source.gatewayCredentialId, 'line')),
    linesOfUser: async (userId) => {
      let creds;
      try {
        creds = await gateway.credentials(userId, 'line');
      } catch (err) {
        if (err instanceof GatewayAuthError) return [];
        throw err;
      }
      const out = [];
      for (const cred of creds) {
        try {
          out.push({ credentialId: cred.id, api: lineFor(await gateway.upstream(userId, cred.id, 'line')) });
        } catch (err) {
          if (!(err instanceof GatewayAuthError)) throw err;
        }
      }
      return out;
    },
    now,
    log,
  });
  sync = {
    async handle(job) {
      // 見回りは、マスタを 1 回だけ読んで全コネクタの全データソースで使い回す
      const directory = job.kind === 'maintain' ? onceDirectory(() => service.directory()) : undefined;
      await graph.handle(job, directory);
      await jira.handle(job, directory);
      await teams.handle(job, directory);
      await teamsChat.handle(job, directory);
      await todo.handle(job, directory);
      await gtasks.handle(job, directory);
      await gmail.handle(job, directory);
      await googleChat.handle(job, directory);
      await line.handle(job, directory);
    },
  };
  const connections = new Connections({ gateway, service, queue, newId: randomIds, graphFor, jiraFor, teamsFor, teamsChatFor, todoFor, gtasksFor, gmailFor, googleChatFor, lineFor, state, now, sharedServices: config.sharedServices ?? [], threading: config.threading ?? 'ai' });
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
export function createTopicIndex(config: TopicIndexConfig, authenticate: GatewayPort['authenticate']): TopicIndexHandlers {
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

    async isHome(userId) {
      const { viewer } = await build(config).viewer(userId);
      return viewer.dataSourceIds.length > 0;
    },

    async userPage(userId, { path, base }, ctx) {
      const service = build(config);
      const now = systemClock.now();
      if (path === 'lists') {
        const shell = buildConnectors(config, service, (p) => ctx.waitUntil(p));
        const [data, connections] = await Promise.all([service.myLists(userId), shell ? shell.connections.list(userId) : Promise.resolve([])]);
        return { title: '参加中のリスト', body: `${tabs(base, 'lists')}\n${renderMyLists({ ...data, userId, connections, sharedServices: config.sharedServices ?? [] })}` };
      }
      // 今やることと区分の画面（0052）。リストの種類はデータソースの出所で決まるので、接続の状態は読まない
      const section = /^(?:(mine|awaiting|triage)|attention(?:\/([A-Za-z0-9_-]{1,128}))?)$/.exec(path);
      if (path === '' || section) {
        const data = await service.myLists(userId);
        const lists = data.lists.map((l) => pageList(l.dataSource, l.shared));
        const input = { base, name: data.name, lists, threads: data.threads, now };
        if (path === '') return { title: '今やること', body: renderNow(input) };
        return renderSection(input, (section![1] as NowSection | undefined) ?? 'attention', section![2]);
      }
      const m = /^threads\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (!m) return null;
      const data = await service.threadPage(userId, m[1]!);
      if (!data) return null;
      const list = pageList(data.view.dataSource, data.shared);
      return {
        title: data.view.thread.title,
        body: renderThread({ base, thread: data.view.thread, list, assigneeNames: data.assigneeNames, counterparts: data.counterparts, linked: data.linked, entries: data.entries, now, sourceLink: data.lineConversation ? { href: lineTalkUrl(data.lineConversation), label: 'LINE のトークを開く' } : null }),
      };
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
          // どの仕事が重いか（CPU の上限で打ち切られたとき、ログにはこの行しか残らない）を見分けるため、始める前に種類を残す
          console.log(JSON.stringify({ msg: 'sync_job', kind: job.data.kind, dataSourceId: 'dataSourceId' in job.data ? job.data.dataSourceId : undefined }));
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

/** 画面に出すリスト（0051）。種類は取り込みの状態か、データソースの経路から */
function pageList(ds: Pick<ListView['dataSource'], 'id' | 'name' | 'origin'>, shared: boolean, connection?: ConnectionView): PageList {
  const o = ds.origin;
  return { id: ds.id, name: ds.name, kind: kindOf({ dataSource: ds }, connection), shared, jiraSite: o?.kind === 'jira' ? o.site : null };
}
