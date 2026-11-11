import { canDisconnect, connectJiraProject, connectorOwner, connectTaskList, connectTeamsChannel, deriveViewer, DomainError, teamsAddress, connectMailbox, replaceSharedCredential, syncSharedReaders, type ServiceDataSource } from '../domain';
import { jiraMembers } from '../connectors/jira/readers';
import type { TeamRef, TeamsApi } from '../connectors/teams/api';
import type { TodoApi } from '../connectors/todo/api';
import type { GtasksApi } from '../connectors/gtasks/api';
import type { TodoTaskList } from '../connectors/todo/task';
import { teamsMembers } from '../connectors/teams/plan';
import { ConsentRequired, GatewayAuthError, type GatewayCredential, type GatewayPort, type UpstreamCall, type UpstreamKind } from '../ports/gateway';
import type { GraphApi } from '../connectors/graph/api';
import type { JiraApi, JiraProject, JiraSite } from '../connectors/jira/api';
import type { SyncQueue } from '../connectors/graph/jobs';
import type { SourceState } from '../connectors/graph/state';
import type { ConnectorStateStore, PendingAuthorization } from '../store/connector-state';
import type { MurmurService } from './service';

// 個人の箱をつなぐ（0024 の決定 3）。ゲートウェイとのやりとりは全部ゲートウェイの口（ports/gateway.ts。0023）を通す。
// 本人がスタンドから頼み、ゲートウェイの同意の画面で本体を許可すると、
// 本体はデータソースを実行時に作り（読者は本人 1 人）、キューにサブスクリプションと初回の delta を頼む。
// Jira（0034）も同じ同意で、ゲートウェイの jira の接続からサイトを選び、本人の JQL の範囲を個人リストにする。
// To Do（0039）も同じ同意で、ゲートウェイの graph の接続からタスクのリストを 1 つ選んで個人リストにする。

/** 認可の途中の state の寿命 */
const PENDING_MINUTES = 15;

export interface ConnectionsDeps {
  gateway: GatewayPort;
  service: MurmurService;
  queue: SyncQueue;
  newId: (prefix: string) => string;
  graphFor(call: UpstreamCall): GraphApi;
  jiraFor(call: UpstreamCall): JiraApi;
  teamsFor(call: UpstreamCall): TeamsApi;
  todoFor(call: UpstreamCall): TodoApi;
  gtasksFor(call: UpstreamCall): GtasksApi;
  state: ConnectorStateStore;
  now: () => string;
  /** 共有リストを許すサービス（0037 の決定 4。管理者がデプロイの設定で決める） */
  sharedServices: readonly string[];
}

export type ConnectResult =
  /** 本人がこの URL を開いて、ゲートウェイの同意の画面で本体を許可する */
  | { status: 'authorize'; authorize_url: string }
  /** ゲートウェイに Graph の接続が複数ある。credential_id を選んでもう一度呼ぶ */
  | { status: 'choose'; credentials: GatewayCredential[] }
  /** ゲートウェイに Graph の接続がない。本人がゲートウェイでつないでからもう一度 */
  | { status: 'no_credential'; register_url: string }
  /** Jira: 接続が複数のサイトに届く。site を選んでもう一度 */
  | { status: 'choose_site'; sites: JiraSite[] }
  /** Jira: つなぐプロジェクトを選んでもう一度（0037。プロジェクト単位の共有リスト） */
  | { status: 'choose_project'; projects: JiraProject[] }
  /** Teams: つなぐチーム・チャネルを選んでもう一度（0036・0037。チャネル単位の共有リスト） */
  | { status: 'choose_team'; teams: TeamRef[] }
  | { status: 'choose_channel'; channels: TeamRef[] }
  /** To Do: つなぐタスクのリストを選んでもう一度（0039） */
  | { status: 'choose_list'; lists: { id: string; name: string; wellknown: string | null }[] }
  | { status: 'connected'; data_source: { id: string; name: string }; created: boolean };

export interface ConnectJiraInput {
  credentialId?: string;
  /** サイトの cloudId（accessible-resources の id） */
  cloudId?: string;
  /** プロジェクトのキー（0037。省けば一覧を返す） */
  projectKey?: string;
}

export interface ConnectTeamsInput {
  credentialId?: string;
  teamId?: string;
  channelId?: string;
}

export interface ConnectTodoInput {
  credentialId?: string;
  /** タスクのリストの ID（省けば一覧を返す） */
  listId?: string;
}

export interface ConnectGoogleTasksInput {
  credentialId?: string;
  /** タスクのリストの ID（省けば一覧を返す） */
  listId?: string;
}

export interface ConnectionView {
  data_source: string;
  name: string;
  kind: 'outlook' | 'jira' | 'teams' | 'todo' | 'google-tasks';
  /** Jira: サイトとプロジェクト */
  site?: string;
  project?: string;
  /** Teams: チームとチャネルの ID */
  team?: string;
  channel?: string;
  /** To Do・Google Tasks: タスクのリストの名前 */
  list?: string;
  /** 共有リスト（0037）。読者はソースから写す */
  shared?: boolean;
  /** 共有リストを作った人 */
  created_by?: string;
  status: SourceState['status'];
  reason: string | null;
  connected_at: string;
  last_sync_at: string | null;
}

export class Connections {
  constructor(private readonly deps: ConnectionsDeps) {}

  /** つなぐ。同意がまだなら認可の URL を返し、あればゲートウェイの接続を選んでデータソースを作る（何度呼んでもよい） */
  async connectOutlook(userId: string, credentialId?: string): Promise<ConnectResult> {
    return this.connect(userId, credentialId ?? null, { kind: 'outlook' });
  }

  /** Jira のプロジェクトを共有リストとしてつなぐ（0037。同意は Outlook と同じもの） */
  async connectJira(userId: string, input: ConnectJiraInput = {}): Promise<ConnectResult> {
    return this.connect(userId, input.credentialId ?? null, { kind: 'jira', cloudId: input.cloudId, projectKey: input.projectKey });
  }

  /** Teams のチャネルを共有リストとしてつなぐ（0036・0037。同意は Outlook と同じもの。ゲートウェイの graph の接続で読む） */
  async connectTeams(userId: string, input: ConnectTeamsInput = {}): Promise<ConnectResult> {
    return this.connect(userId, input.credentialId ?? null, { kind: 'teams', teamId: input.teamId, channelId: input.channelId });
  }

  /** To Do のタスクのリストを個人リストとしてつなぐ（0039。同意は Outlook と同じもの。ゲートウェイの graph の接続で読む） */
  async connectTodo(userId: string, input: ConnectTodoInput = {}): Promise<ConnectResult> {
    return this.connect(userId, input.credentialId ?? null, { kind: 'todo', listId: input.listId });
  }

  /** Google Tasks のタスクのリストを個人リストとしてつなぐ（0041。同意は同じもの。ゲートウェイの Google Tasks（tasks）の接続で読む） */
  async connectGoogleTasks(userId: string, input: ConnectGoogleTasksInput = {}): Promise<ConnectResult> {
    return this.connect(userId, input.credentialId ?? null, { kind: 'google-tasks', listId: input.listId });
  }

  private async connect(userId: string, credentialId: string | null, request: NonNullable<PendingAuthorization['request']>): Promise<ConnectResult> {
    const dir = await this.deps.service.directory();
    if (!dir.seed.users.some((u) => u.id === userId)) throw new DomainError('forbidden', `user ${userId} はまだサインインしていない`);
    try {
      return await this.connectWithGrant(userId, await this.deps.gateway.credentials(userId, this.kindOf(request)), credentialId ?? undefined, request);
    } catch (err) {
      // 同意がない・取り消された・失効した: もう一度許可してもらう
      if (err instanceof ConsentRequired) return this.authorize(userId, credentialId, request);
      // 同意は有効で、選んだ接続そのものがゲートウェイでつなぎ直しを要る。Murmur の同意を取り直しても直らない
      if (err instanceof GatewayAuthError) throw new DomainError('conflict', `ゲートウェイでこの接続をつなぎ直してから、もう一度頼んでください（${err.message}）`);
      throw err;
    }
  }

  private async authorize(userId: string, credentialId: string | null, request: NonNullable<PendingAuthorization['request']>): Promise<ConnectResult> {
    const { url, state, secret } = await this.deps.gateway.consent.begin(userId);
    await this.deps.state.putPending({ state, userId, verifier: secret, credentialId, createdAt: this.deps.now(), request });
    return { status: 'authorize', authorize_url: url };
  }

  /**
   * ゲートウェイの同意の画面から戻ってきた。許可したのが頼んだ本人かを口が確かめてから保管する
   * （別の人がこの URL を開いて許可しても、その人の箱を頼んだ本人のデータソースにはしない）
   */
  async callback(input: { state: string | null; code: string | null; error: string | null }): Promise<CallbackResult> {
    if (!input.state) return { ok: false, message: '認可の state がありません。' };
    const notBefore = new Date(Date.parse(this.deps.now()) - PENDING_MINUTES * 60_000).toISOString();
    const pending = await this.deps.state.takePending(input.state, notBefore);
    if (!pending) return { ok: false, message: 'この認可は期限が切れたか、もう使われています。エージェント（Claude など）からもう一度つないでください。' };
    if (input.error || !input.code) return { ok: false, message: `ゲートウェイで許可されませんでした（${input.error ?? 'no code'}）。` };

    const request = pending.request ?? { kind: 'outlook' };
    const kind = this.kindOf(request);
    const label = kind === 'jira' ? 'Jira' : kind === 'gtasks' ? 'Google Tasks' : 'Microsoft Graph';
    const done = await this.deps.gateway.consent.complete({ userId: pending.userId, code: input.code, secret: pending.verifier, kind });
    if (done === 'no_credential') return { ok: false, message: `ゲートウェイに ${label} の接続がありません。ゲートウェイでつないでから、もう一度頼んでください。` };
    if (done === 'wrong_user') {
      return { ok: false, message: '許可したアカウントが、つなぐように頼んだ人と違います。本人のアカウントでもう一度許可してください。' };
    }
    const result = await this.connectWithGrant(pending.userId, await this.deps.gateway.credentials(pending.userId, kind), pending.credentialId ?? undefined, request);
    switch (result.status) {
      case 'connected':
        return {
          ok: true,
          message:
            request.kind === 'jira'
              ? `${result.data_source.name} をつなぎました。これから更新される課題を取り込みます（過去のコメントは取りません）。`
              : request.kind === 'todo' || request.kind === 'google-tasks'
                ? `${result.data_source.name} をつなぎました。リストの開いているタスクと、これから変わるタスクを取り込みます。`
                : `${result.data_source.name} をつなぎました。これから届くメールを取り込みます（過去のメールは取りません）。`,
        };
      case 'choose':
        return { ok: true, message: `ゲートウェイに ${label} の接続が複数あります。エージェント（Claude など）に戻って、どれをつなぐか選んでください。` };
      case 'choose_site':
        return { ok: true, message: 'Jira のサイトが複数あります。エージェント（Claude など）に戻って、どのサイトをつなぐか選んでください。' };
      case 'choose_list':
        return { ok: true, message: `${label} のタスクのリストを選んでください。エージェント（Claude など）に戻って、どのリストをつなぐか選んでください。` };
      default:
        return { ok: false, message: 'つなげませんでした。エージェント（Claude など）からもう一度頼んでください。' };
    }
  }

  private kindOf(request: NonNullable<PendingAuthorization['request']>): UpstreamKind {
    return request.kind === 'jira' ? 'jira' : request.kind === 'teams' ? 'teams' : request.kind === 'google-tasks' ? 'gtasks' : 'graph';
  }

  private async connectWithGrant(
    userId: string,
    /** 本人のゲートウェイの接続のうち、つなぐ種類のもの */
    creds: GatewayCredential[],
    credentialId: string | undefined,
    request: NonNullable<PendingAuthorization['request']>,
  ): Promise<ConnectResult> {
    const kind = this.kindOf(request);
    const chosen = credentialId ? creds.find((c) => c.id === credentialId) : creds.length === 1 ? creds[0] : undefined;
    if (credentialId && !chosen) throw new DomainError('not_found', `credential ${credentialId} はゲートウェイの ${kind} の接続にない`);
    if (creds.length === 0) return { status: 'no_credential', register_url: this.deps.gateway.homeUrl };
    if (!chosen) return { status: 'choose', credentials: creds };
    if (request.kind === 'jira') return this.connectJiraWith(userId, chosen.id, request);
    if (request.kind === 'teams') return this.connectTeamsWith(userId, chosen.id, request);
    if (request.kind === 'todo') return this.connectTodoWith(userId, chosen.id, request);
    if (request.kind === 'google-tasks') return this.connectGoogleTasksWith(userId, chosen.id, request);

    const me = await this.deps.graphFor(await this.deps.gateway.upstream(userId, chosen.id, 'graph')).me();
    const { result: plan } = await this.deps.service.changeMaster(userId, 'Outlook をつなぐ', (d, ctx) =>
      connectMailbox(d, ctx, { userId, gatewayCredentialId: chosen.id, displayName: me.displayName, addresses: me.addresses }),
    );

    const ds = plan.dataSource;
    const current = await this.deps.state.source(ds.id);
    if (!current || current.status !== 'ok') {
      await this.deps.state.putSource({
        kind: 'outlook',
        dataSourceId: ds.id,
        userId,
        gatewayCredentialId: chosen.id,
        status: 'setup',
        reason: null,
        // 外したあとのつなぎ直しも、その時点から取る（間の分は取らない）
        folders: current?.status === 'broken' ? current.folders : {},
        connectedAt: current?.status === 'broken' ? current.connectedAt : this.deps.now(),
        lastSyncAt: current?.lastSyncAt ?? null,
        lastRetryAt: null,
      });
      await this.deps.queue.send({ kind: 'setup', dataSourceId: ds.id });
    }
    return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: plan.kind === 'created' };
  }

  private async connectJiraWith(userId: string, credentialId: string, request: { kind: 'jira'; cloudId?: string; projectKey?: string }): Promise<ConnectResult> {
    if (!this.deps.sharedServices.includes('jira')) {
      throw new DomainError('forbidden', 'このデプロイでは Jira の共有リストを許していない（管理者がデプロイの設定 MURMUR_SHARED_SERVICES に jira を足す）');
    }
    const api = this.deps.jiraFor(await this.deps.gateway.upstream(userId, credentialId, 'jira'));
    const sites = await api.sites();
    const site = request.cloudId ? sites.find((s) => s.id === request.cloudId) : sites.length === 1 ? sites[0] : undefined;
    if (request.cloudId && !site) throw new DomainError('not_found', `site ${request.cloudId} はこの Jira の接続から届かない`);
    if (!site) {
      if (sites.length === 0) throw new DomainError('conflict', 'この Jira の接続から届くサイトがない');
      return { status: 'choose_site', sites };
    }
    // つなぐ人が見えるプロジェクトだけを選べる（見えることが、作ってよい条件。0037 の決定 4）
    const projects = await api.projects(site.id);
    if (!request.projectKey) return { status: 'choose_project', projects };
    const project = projects.find((p) => p.key === request.projectKey);
    if (!project) throw new DomainError('not_found', `project ${request.projectKey} はこの Jira の接続から見えない`);
    const me = await api.myself(site.id);
    const { result: plan } = await this.deps.service.changeMaster(userId, 'Jira のプロジェクトをつなぐ', (d, ctx) =>
      connectJiraProject(d, ctx, {
        userId,
        gatewayCredentialId: credentialId,
        cloudId: site.id,
        site: site.url,
        siteName: site.name,
        projectKey: project.key,
        projectName: project.name,
        accountId: me.accountId,
      }),
    );
    const ds = plan.dataSource;
    const current = await this.deps.state.source(ds.id);
    if (plan.kind === 'exists') {
      // つなぐ人の権限で、その場で読者を写す（つないだ人も名乗ったので読者になる）
      const members = jiraMembers(await api.browsers(site.id, project.key));
      await this.deps.service.changeMaster(null, 'Jira の読者の同期', (d, ctx) => syncSharedReaders(d, ctx, ds.id, members));
      // 動いていれば何もしない。止まっていれば（つないだ人が読めなくなった・外した）、この人の委任でつなぎ直す
      if (current && current.status === 'ok') return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: false };
      await this.deps.service.changeMaster(userId, 'Jira の共有リストをつなぎ直す', (d, ctx) =>
        replaceSharedCredential(d, ctx, ds.id, { userId, gatewayCredentialId: credentialId, identity: me.accountId }),
      );
    }
    const now = this.deps.now();
    await this.deps.state.putSource({
      kind: 'jira',
      dataSourceId: ds.id,
      userId,
      gatewayCredentialId: credentialId,
      status: 'setup',
      reason: null,
      folders: {},
      // 作った直後はその時点から取る（過去のコメントは取らない）。broken からの戻りは続きから
      jira:
        current?.status === 'broken' && current.jira
          ? { ...current.jira, readersSyncedAt: undefined }
          : { syncedUntil: now, webhookIds: current?.jira?.webhookIds ?? [], webhookExpiresAt: null },
      connectedAt: current?.status === 'broken' ? current.connectedAt : now,
      lastSyncAt: current?.lastSyncAt ?? null,
      lastRetryAt: null,
    });
    await this.deps.queue.send({ kind: 'setup', dataSourceId: ds.id });
    return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: plan.kind === 'created' };
  }

  private async connectTeamsWith(userId: string, credentialId: string, request: { kind: 'teams'; teamId?: string; channelId?: string }): Promise<ConnectResult> {
    if (!this.deps.sharedServices.includes('teams')) {
      throw new DomainError('forbidden', 'このデプロイでは Teams の共有リストを許していない（管理者がデプロイの設定 MURMUR_SHARED_SERVICES に teams を足す）');
    }
    // 読者はチャネルのメンバーの Entra の ID でゲートウェイの User に対応を付ける（0037 の決定 2）ので、Entra でサインインするゲートウェイだけ
    const me = /^entra_([0-9a-f-]+)_([0-9a-f-]+)$/i.exec(userId);
    if (!me) throw new DomainError('forbidden', 'Teams の共有リストは、Microsoft Entra ID でサインインするゲートウェイだけで使える');
    const [, tenantId, objectId] = me as unknown as [string, string, string];
    const api = this.deps.teamsFor(await this.deps.gateway.upstream(userId, credentialId, 'teams'));
    // つなぐ人が入っているチームとチャネルだけを選べる（読めることが、作ってよい条件。0037 の決定 4）
    const teams = await api.joinedTeams();
    if (!request.teamId) return { status: 'choose_team', teams };
    const team = teams.find((t) => t.id === request.teamId);
    if (!team) throw new DomainError('not_found', `team ${request.teamId} にこの人は入っていない`);
    const channels = await api.channels(team.id);
    if (!request.channelId) return { status: 'choose_channel', channels };
    const channel = channels.find((c) => c.id === request.channelId);
    if (!channel) throw new DomainError('not_found', `channel ${request.channelId} はこの人から見えない`);

    const { result: plan } = await this.deps.service.changeMaster(userId, 'Teams のチャネルをつなぐ', (d, ctx) =>
      connectTeamsChannel(d, ctx, {
        userId,
        gatewayCredentialId: credentialId,
        teamId: team.id,
        teamName: team.name,
        channelId: channel.id,
        channelName: channel.name,
        tenantId,
        objectId,
      }),
    );
    const ds = plan.dataSource;
    const current = await this.deps.state.source(ds.id);
    if (plan.kind === 'exists') {
      const members = teamsMembers(await api.members(team.id, channel.id));
      await this.deps.service.changeMaster(null, 'Teams の読者の同期', (d, ctx) => syncSharedReaders(d, ctx, ds.id, members));
      if (current && current.status === 'ok') return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: false };
      await this.deps.service.changeMaster(userId, 'Teams の共有リストをつなぎ直す', (d, ctx) =>
        replaceSharedCredential(d, ctx, ds.id, { userId, gatewayCredentialId: credentialId, identity: teamsAddress(tenantId, objectId) }),
      );
    }
    const now = this.deps.now();
    await this.deps.state.putSource({
      kind: 'teams',
      dataSourceId: ds.id,
      userId,
      gatewayCredentialId: credentialId,
      status: 'setup',
      reason: null,
      folders: {},
      // 作った直後はその時点から取る（過去の投稿は取らない）。broken からの戻りは続きから
      teams: current?.status === 'broken' && current.teams ? { ...current.teams, readersSyncedAt: undefined } : { syncedUntil: now },
      connectedAt: current?.status === 'broken' ? current.connectedAt : now,
      lastSyncAt: current?.lastSyncAt ?? null,
      lastRetryAt: null,
    });
    await this.deps.queue.send({ kind: 'setup', dataSourceId: ds.id });
    return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: plan.kind === 'created' };
  }

  private async connectTodoWith(userId: string, credentialId: string, request: { kind: 'todo'; listId?: string }): Promise<ConnectResult> {
    const api = this.deps.todoFor(await this.deps.gateway.upstream(userId, credentialId, 'graph'));
    const lists = await api.lists();
    const view = (l: TodoTaskList) => ({ id: l.id, name: l.displayName, wellknown: l.wellknownListName && l.wellknownListName !== 'none' ? l.wellknownListName : null });
    if (!request.listId) return { status: 'choose_list', lists: lists.map(view) };
    const list = lists.find((l) => l.id === request.listId);
    if (!list) throw new DomainError('not_found', `task list ${request.listId} はこの接続から見えない`);
    const me = await api.me();
    const { result: plan } = await this.deps.service.changeMaster(userId, 'To Do のタスクのリストをつなぐ', (d, ctx) =>
      connectTaskList(d, ctx, { userId, gatewayCredentialId: credentialId, displayName: me.displayName, address: me.addresses[0] ?? '', listId: list.id, listName: list.displayName }),
    );
    const ds = plan.dataSource;
    // ゲートウェイの接続を足し直した（ID が変わった）: 同じアカウントのほかのリストも新しい接続で読む
    const dir = await this.deps.service.directory();
    for (const s of await this.deps.state.sources()) {
      if (s.kind !== 'todo' || s.dataSourceId === ds.id || s.userId !== userId || s.gatewayCredentialId === credentialId) continue;
      if (dir.dataSource(s.dataSourceId)?.credentialRefId !== ds.credentialRefId || s.status === 'disconnected') continue;
      await this.deps.state.putSource({ ...s, gatewayCredentialId: credentialId, ...(s.status === 'broken' ? { status: 'setup' as const, reason: null } : {}) });
      if (s.status === 'broken') await this.deps.queue.send({ kind: 'setup', dataSourceId: s.dataSourceId });
    }
    const current = await this.deps.state.source(ds.id);
    if (!current || current.status !== 'ok' || current.gatewayCredentialId !== credentialId) {
      await this.deps.state.putSource({
        kind: 'todo',
        dataSourceId: ds.id,
        userId,
        gatewayCredentialId: credentialId,
        status: 'setup',
        reason: null,
        // つなぎ直しも delta を最初から読む（写しは冪等なので、変わっていないタスクは何もしない）
        folders: {},
        connectedAt: current?.connectedAt ?? this.deps.now(),
        lastSyncAt: current?.lastSyncAt ?? null,
        lastRetryAt: null,
      });
      await this.deps.queue.send({ kind: 'setup', dataSourceId: ds.id });
    }
    return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: plan.kind === 'created' };
  }

  private async connectGoogleTasksWith(userId: string, credentialId: string, request: { kind: 'google-tasks'; listId?: string }): Promise<ConnectResult> {
    const api = this.deps.gtasksFor(await this.deps.gateway.upstream(userId, credentialId, 'gtasks'));
    const lists = await api.lists();
    if (!request.listId) return { status: 'choose_list', lists: lists.map((l) => ({ id: l.id, name: l.title, wellknown: null })) };
    const list = lists.find((l) => l.id === request.listId);
    if (!list) throw new DomainError('not_found', `task list ${request.listId} はこの接続から見えない`);
    // つないだアカウントのアドレス（userinfo）。確認済みのメールアドレスがわからなければ、To Do が Graph の /me で
    // 本人を特定できないときと同じく、つながない（connectTaskList が invalid にする）
    const address = await api.account();
    const { result: plan } = await this.deps.service.changeMaster(userId, 'Google Tasks のタスクのリストをつなぐ', (d, ctx) =>
      connectTaskList(d, ctx, { userId, gatewayCredentialId: credentialId, displayName: '', address, listId: list.id, listName: list.title, service: 'google-tasks' }),
    );
    const ds = plan.dataSource;
    // ゲートウェイの接続を足し直した（ID が変わった）: 同じアカウントのほかのリストも新しい接続で読む
    const dir = await this.deps.service.directory();
    for (const s of await this.deps.state.sources()) {
      if (s.kind !== 'gtasks' || s.dataSourceId === ds.id || s.userId !== userId || s.gatewayCredentialId === credentialId) continue;
      if (dir.dataSource(s.dataSourceId)?.credentialRefId !== ds.credentialRefId || s.status === 'disconnected') continue;
      await this.deps.state.putSource({ ...s, gatewayCredentialId: credentialId, ...(s.status === 'broken' ? { status: 'setup' as const, reason: null } : {}) });
      if (s.status === 'broken') await this.deps.queue.send({ kind: 'setup', dataSourceId: s.dataSourceId });
    }
    const current = await this.deps.state.source(ds.id);
    if (!current || current.status !== 'ok' || current.gatewayCredentialId !== credentialId) {
      await this.deps.state.putSource({
        kind: 'gtasks',
        dataSourceId: ds.id,
        userId,
        gatewayCredentialId: credentialId,
        status: 'setup',
        reason: null,
        // つなぎ直しもリストを最初から読む（写しは冪等なので、変わっていないタスクは何もしない）
        folders: {},
        gtasks: { updatedMin: null, resume: null, listCheckedAt: null },
        connectedAt: current?.connectedAt ?? this.deps.now(),
        lastSyncAt: current?.lastSyncAt ?? null,
        lastRetryAt: null,
      });
      await this.deps.queue.send({ kind: 'setup', dataSourceId: ds.id });
    }
    return { status: 'connected', data_source: { id: ds.id, name: ds.name }, created: plan.kind === 'created' };
  }

  /** 自分がつないだもの（個人のリストと、自分の委任で読んでいる共有リスト）と、読者になっている共有リスト */
  async list(userId: string): Promise<ConnectionView[]> {
    const dir = await this.deps.service.directory();
    const readable = new Set(deriveViewer(dir, userId).dataSourceIds);
    const sources = (await this.deps.state.sources()).filter((s) => {
      if (s.userId === userId) return true;
      const ds = dir.dataSource(s.dataSourceId);
      return ds?.kind === 'service' && !!ds.shared && readable.has(ds.id);
    });
    return sources.map((s) => {
      const ds = dir.dataSource(s.dataSourceId) as ServiceDataSource | undefined;
      const jira = ds?.connector?.kind === 'jira' ? ds.connector : undefined;
      const teams = ds?.connector?.kind === 'teams' ? ds.connector : undefined;
      const todo = ds?.connector?.kind === 'graph-todo' || ds?.connector?.kind === 'google-tasks' ? ds.connector : undefined;
      return {
        data_source: s.dataSourceId,
        name: ds?.name ?? s.dataSourceId,
        kind: s.kind === 'gtasks' ? ('google-tasks' as const) : (s.kind ?? ('outlook' as const)),
        ...(jira ? { site: jira.site, ...(jira.projectKey ? { project: jira.projectKey } : {}) } : {}),
        ...(teams ? { team: teams.teamId, channel: teams.channelId } : {}),
        ...(todo ? { list: todo.listName } : {}),
        ...(ds?.shared ? { shared: true, created_by: ds.shared.createdBy } : {}),
        status: s.status,
        reason: s.reason,
        connected_at: s.connectedAt,
        last_sync_at: s.lastSyncAt,
      };
    });
  }

  /** 外す。サブスクリプションを消し、cursor を捨てる。スレッドとデータソースは残る（読者はそのまま読める） */
  async disconnect(userId: string, dataSourceId: string): Promise<ConnectionView[]> {
    const dir = await this.deps.service.directory();
    const ds = dir.dataSource(dataSourceId);
    const source = await this.deps.state.source(dataSourceId);
    if (!ds || !source) throw new DomainError('not_found', `connection ${dataSourceId} not found`);
    // 外せるのは、共有リストは作った人と管理者、個人のリストは本人（0037 の決定 4）。外せない人には、ないのと同じに見せる
    const admin = ds.kind === 'service' && !!ds.shared && (await this.deps.gateway.isAdmin(userId));
    if (!canDisconnect(dir.seed, dataSourceId, userId, admin)) throw new DomainError('not_found', `connection ${dataSourceId} not found`);
    const who = connectorOwner(dir.seed, ds) === userId ? '本人が外した' : admin ? '管理者が外した' : '作った人が外した';
    // Webhook の ID は消すまで残す（disconnect の仕事が消す）
    await this.deps.state.putSource({ ...source, status: 'disconnected', reason: who, folders: {} });
    await this.deps.queue.send({ kind: 'disconnect', dataSourceId });
    return this.list(userId);
  }
}

export type CallbackResult = { ok: boolean; message: string };
