import type { CoreContext } from './context';
import { sameAddress } from './comm';
import { sameValue } from './directory';
import type { DataSource, Seed, ServiceDataSource } from './entities';
import { DomainError } from './errors';
import { bindIdentity, createPersonalDataSource, type IdentityOutcome } from './people';
import { connectSharedSpace, type SharedSpacePlan } from './shared';

// 実行時のデータソースの作成（0024 の決定 3）。個人の箱は本人がゲートウェイの OAuth で本体に同意したあとに作る。
// 作り方は 0030 の個人のリスト（createPersonalDataSource）と同じ: 読者は本人だけ、窓口のアドレスは持たず、
// メールボックスのアドレスが本人の Contact に付いて「こちら」になる。マスタの書き換えはシェルの changeMaster が記録に残す。

export interface MailboxInput {
  userId: string;
  /** ゲートウェイの資格情報（本人の graph の接続）の ID */
  gatewayCredentialId: string;
  /** メールボックスの持ち主の表示名（データソースの名前に使う） */
  displayName: string;
  /** 本人のアドレスとエイリアス。先頭が主のアドレスで、リストでのアイデンティティになる */
  addresses: string[];
}

export type MailboxPlan =
  | { kind: 'exists'; dataSource: ServiceDataSource }
  | { kind: 'created'; dataSource: ServiceDataSource; identity: IdentityOutcome };

/**
 * 同じ本人・同じゲートウェイの接続のメールボックスがあればそれを返し、なければマスタの下書き（draft）に作る。
 * エイリアスも本人の Contact に付ける（別の人のアドレスなら conflict）
 */
export function connectMailbox(draft: Seed, ctx: CoreContext, input: MailboxInput): MailboxPlan {
  const user = draft.users.find((u) => u.id === input.userId);
  if (!user) throw new DomainError('forbidden', `user ${input.userId} はまだサインインしていない`);

  const existing = draft.dataSources.find((ds): ds is ServiceDataSource => {
    if (ds.kind !== 'service' || ds.connector?.kind !== 'graph-mail') return false;
    const cred = draft.credentialRefs.find((c) => c.id === ds.credentialRefId);
    return cred?.principal.kind === 'user' && cred.principal.userId === input.userId && cred.gatewayCredentialId === input.gatewayCredentialId;
  });
  if (existing) return { kind: 'exists', dataSource: existing };

  const values = dedupe(input.addresses.map((a) => a.trim()).filter((a) => a.includes('@')));
  if (values.length === 0) throw new DomainError('invalid', 'メールボックスのアドレスがわからない');
  const name = input.displayName || user.name || values[0]!;

  const created = createPersonalDataSource(
    draft,
    input.userId,
    {
      channel: 'email',
      name: `${name} の Outlook`,
      description: `${name} の個人のメールボックス。本人の同意で取り込む（読者は本人だけ）`,
      identity: values[0]!,
      gatewayCredentialId: input.gatewayCredentialId,
    },
    ctx,
  );
  for (const alias of values.slice(1)) bindIdentity(draft, input.userId, { channel: 'email', value: alias }, ctx);
  const dataSource = draft.dataSources.find((d) => d.id === created.dataSourceId) as ServiceDataSource;
  dataSource.connector = { kind: 'graph-mail', mailbox: 'me', folders: ['inbox', 'sentitems'] };
  return { kind: 'created', dataSource, identity: created.identity };
}

// ---- To Do（0039）: 本人のタスクのリスト ----

export interface TaskListInput {
  userId: string;
  /** ゲートウェイの資格情報（本人の graph の接続）の ID */
  gatewayCredentialId: string;
  /** 持ち主の表示名 */
  displayName: string;
  /** 本人の主のアドレス。リストでのアイデンティティ（チャネル todo）になる */
  address: string;
  listId: string;
  listName: string;
  /** タスクのサービス（経路）。省けば To Do（0041 で Google Tasks を足した。作り方は同じ） */
  service?: TaskService;
}

export type TaskService = 'graph-todo' | 'google-tasks';

const TASK_SERVICE_LABEL: Record<TaskService, string> = { 'graph-todo': 'To Do', 'google-tasks': 'Google Tasks' };

/**
 * 本人の To Do・Google Tasks のタスクのリストを個人リストとして作る（同じリストがあればそれを返す）。
 * To Do のリスト 1 つが Murmur のリスト 1 つで、いくつでもつなげる（0039 の未決 2）。どのリストも同じ扱いで、特別なリストは置かない。
 * 同じアカウントの 2 つめからは、最初のリストの資格情報を使い回す（資格情報はアカウントに 1 つ）
 */
export function connectTaskList(draft: Seed, ctx: CoreContext, input: TaskListInput): MailboxPlan {
  const user = draft.users.find((u) => u.id === input.userId);
  if (!user) throw new DomainError('forbidden', `user ${input.userId} はまだサインインしていない`);
  const address = input.address.trim();
  if (!address.includes('@')) throw new DomainError('invalid', 'アカウントのアドレスがわからない');
  const service = input.service ?? 'graph-todo';
  const label = TASK_SERVICE_LABEL[service];
  // 本人のそのアカウントの資格情報（同じアカウントのリストで共有する）。ゲートウェイの接続を足し直して ID が変わったら付け替える
  const cred = draft.credentialRefs.find(
    (c) => c.principal.kind === 'user' && c.principal.userId === input.userId && sameAddress(c.address, { channel: 'todo', value: address }),
  );
  if (cred) cred.gatewayCredentialId = input.gatewayCredentialId;
  const same = draft.dataSources.find(
    (ds): ds is ServiceDataSource => ds.kind === 'service' && (ds.connector?.kind === 'graph-todo' || ds.connector?.kind === 'google-tasks') && ds.connector.kind === service && ds.connector.listId === input.listId && ds.credentialRefId === cred?.id,
  );
  if (same) {
    if (same.connector?.kind === 'graph-todo' || same.connector?.kind === 'google-tasks') same.connector.listName = input.listName;
    return { kind: 'exists', dataSource: same };
  }
  const name = input.displayName || user.name || address;
  const connector = { kind: service, listId: input.listId, listName: input.listName };
  const naming = { name: `${name} の ${label}（${input.listName}）`, description: `${name} の ${label} のタスクのリスト「${input.listName}」。本人の同意で取り込む（読者は本人だけ。0039・0041）` };
  if (cred) {
    const identity = bindIdentity(draft, input.userId, { channel: 'todo', value: address }, ctx);
    const dataSource: ServiceDataSource = { kind: 'service', id: ctx.newId('ds'), channel: 'todo', ...naming, credentialRefId: cred.id, selfAddresses: [], group: false, connector };
    draft.dataSources.push(dataSource);
    const listId = ctx.newId('l');
    draft.lists.push({ id: listId, dataSourceId: dataSource.id });
    draft.listMembers.push({ listId, userId: input.userId });
    return { kind: 'created', dataSource, identity };
  }
  const created = createPersonalDataSource(
    draft,
    input.userId,
    { channel: 'todo', ...naming, identity: address, gatewayCredentialId: input.gatewayCredentialId },
    ctx,
  );
  const dataSource = draft.dataSources.find((d) => d.id === created.dataSourceId) as ServiceDataSource;
  dataSource.connector = connector;
  return { kind: 'created', dataSource, identity: created.identity };
}

/** タスクのサービスの側でリストの名前が変わった（見回りで気づく）。データソースの名前と、写しの statusLabel に使う名前を直す */
export function renameTaskList(draft: Seed, dataSourceId: string, listName: string): boolean {
  const ds = draft.dataSources.find((d) => d.id === dataSourceId);
  const kind = ds?.connector?.kind;
  if (!ds || (kind !== 'graph-todo' && kind !== 'google-tasks') || ds.connector?.kind !== kind || ds.connector.listName === listName || !listName.trim()) return false;
  const label = TASK_SERVICE_LABEL[kind];
  const displayName = ds.name.split(` の ${label}（`)[0] || ds.name;
  ds.connector.listName = listName;
  ds.name = `${displayName} の ${label}（${listName}）`;
  ds.description = `${displayName} の ${label} のタスクのリスト「${listName}」。本人の同意で取り込む（読者は本人だけ。0039・0041）`;
  return true;
}

// ---- Jira（0034・0037）: プロジェクト単位の共有リスト ----

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

export function jiraSpaceKey(cloudId: string, projectKey: string): string {
  return `jira:${cloudId}/${projectKey}`;
}

/** 取り込む範囲。セキュリティレベル付きの課題は、プロジェクトを閲覧できても見えない人がいるので入れない（0037 の決定 3） */
export function jiraProjectJql(projectKey: string): string {
  return `project = ${projectKey} AND level IS EMPTY`;
}

export interface JiraProjectInput {
  userId: string;
  /** つなぐ人のゲートウェイの jira の接続 */
  gatewayCredentialId: string;
  cloudId: string;
  /** サイトの URL と名前（accessible-resources） */
  site: string;
  siteName: string;
  projectKey: string;
  projectName: string;
  /** つなぐ人の accountId（myself）。名乗り */
  accountId: string;
}

/** Jira のプロジェクトの共有リストを作る（あればそれを返す）。読者は見回りでプロジェクトを閲覧できる人から写す */
export function connectJiraProject(draft: Seed, ctx: CoreContext, input: JiraProjectInput): SharedSpacePlan {
  if (!PROJECT_KEY.test(input.projectKey)) throw new DomainError('invalid', `project key ${input.projectKey} is invalid`);
  return connectSharedSpace(draft, ctx, {
    userId: input.userId,
    gatewayCredentialId: input.gatewayCredentialId,
    channel: 'jira',
    spaceKey: jiraSpaceKey(input.cloudId, input.projectKey),
    name: `${input.projectName}（Jira）`,
    description: `${input.site} のプロジェクト ${input.projectKey} の課題（セキュリティレベル付きを除く）。読者はプロジェクトを閲覧できる人（0037）`,
    identity: input.accountId,
    connector: { kind: 'jira', cloudId: input.cloudId, site: input.site, jql: jiraProjectJql(input.projectKey), projectKey: input.projectKey },
    group: true,
  });
}

// ---- Teams（0036・0037）: チャネルの共有リスト ----

export function teamsSpaceKey(teamId: string, channelId: string): string {
  return `teams:${teamId}/${channelId}`;
}

/** Teams のアドレスの値。別のテナントのゲストと衝突しないよう、テナントを前に付ける */
export function teamsAddress(tenantId: string, objectId: string): string {
  return `${tenantId}/${objectId}`;
}

export interface TeamsChannelInput {
  userId: string;
  /** つなぐ人のゲートウェイの graph の接続 */
  gatewayCredentialId: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  /** つなぐ人の Entra のテナントとオブジェクト ID（名乗り） */
  tenantId: string;
  objectId: string;
}

/** Teams のチャネルの共有リストを作る（あればそれを返す）。読者は見回りでチャネルのメンバーから写す */
export function connectTeamsChannel(draft: Seed, ctx: CoreContext, input: TeamsChannelInput): SharedSpacePlan {
  return connectSharedSpace(draft, ctx, {
    userId: input.userId,
    gatewayCredentialId: input.gatewayCredentialId,
    channel: 'teams',
    spaceKey: teamsSpaceKey(input.teamId, input.channelId),
    name: `${input.teamName} / ${input.channelName}（Teams）`,
    description: `Teams のチーム ${input.teamName} のチャネル ${input.channelName}。読者はチャネルのメンバー（0036・0037）`,
    identity: teamsAddress(input.tenantId, input.objectId),
    connector: { kind: 'teams', teamId: input.teamId, channelId: input.channelId },
    group: true,
  });
}

/** 実行時に作ったメールボックスのデータソースの持ち主（個人の資格情報の本人） */
export function connectorOwner(seed: Seed, ds: DataSource): string | null {
  if (ds.kind !== 'service') return null;
  const cred = seed.credentialRefs.find((c) => c.id === ds.credentialRefId);
  return cred?.principal.kind === 'user' ? cred.principal.userId : null;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (!out.some((o) => sameValue(o, v))) out.push(v);
  return out;
}
