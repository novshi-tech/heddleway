import type { CoreContext } from './context';
import { Directory } from './directory';
import type { AddressRef, Channel, Seed, ServiceDataSource, SourceConnector } from './entities';
import { DomainError } from './errors';
import { bindIdentity } from './people';

// 共有リスト（0037）: スペース（Teams・Slack のチャネル、Jira のプロジェクト）に 1 つ。読者はソースの「読める人」のうち、
// 本人が名乗って対応が付いた User だけ。資格情報はつないだ人の委任。どれもマスタの写し（draft）を書き換える純関数で、
// シェルが MurmurService.changeMaster で差分と変更の記録にする。

export interface SharedSpaceInput {
  /** つなぐ人（そのスペースを読める人。読めることはシェルがつなぐ人の委任で確かめる） */
  userId: string;
  /** つなぐ人のゲートウェイの接続 */
  gatewayCredentialId: string;
  channel: Channel;
  spaceKey: string;
  name: string;
  description?: string;
  /** つなぐ人のそのサービスでのアカウント（本人が名乗ったもの。Jira の accountId など） */
  identity: string;
  connector?: SourceConnector;
  group?: boolean;
}

export type SharedSpacePlan = { kind: 'exists'; dataSource: ServiceDataSource } | { kind: 'created'; dataSource: ServiceDataSource };

/** スペースの共有リストがあればそれを返し（つなぐ人が誰でも同じもの）、なければ作る。作った人を最初の読者にする */
export function connectSharedSpace(draft: Seed, ctx: CoreContext, input: SharedSpaceInput): SharedSpacePlan {
  if (!draft.users.some((u) => u.id === input.userId)) throw new DomainError('forbidden', `user ${input.userId} はまだサインインしていない`);
  if (!input.spaceKey.trim()) throw new DomainError('invalid', 'space is required');
  if (!input.name.trim()) throw new DomainError('invalid', 'name is required');
  if (!input.identity.trim()) throw new DomainError('invalid', 'identity is required');
  const address: AddressRef = { channel: input.channel, value: input.identity.trim() };
  const existing = sharedDataSource(draft, input.spaceKey);
  if (existing) {
    // 2 人目以降: その人のアカウントを名乗りとして記録する（次の読者の同期で読者になる）。別の User のアドレスなら付けない
    try {
      bindIdentity(draft, input.userId, address, ctx);
    } catch (err) {
      if (!(err instanceof DomainError && err.code === 'conflict')) throw err;
    }
    return { kind: 'exists', dataSource: existing };
  }

  bindIdentity(draft, input.userId, address, ctx);
  const credentialRefId = ctx.newId('cr');
  draft.credentialRefs.push({ id: credentialRefId, principal: { kind: 'user', userId: input.userId }, address, gatewayCredentialId: input.gatewayCredentialId });
  const dataSource: ServiceDataSource = {
    kind: 'service',
    id: ctx.newId('ds'),
    channel: input.channel,
    name: input.name.trim(),
    description: input.description ?? '',
    credentialRefId,
    selfAddresses: [],
    group: input.group ?? true,
    ...(input.connector ? { connector: input.connector } : {}),
    shared: { spaceKey: input.spaceKey, createdBy: input.userId },
  };
  draft.dataSources.push(dataSource);
  const listId = ctx.newId('l');
  draft.lists.push({ id: listId, dataSourceId: dataSource.id });
  draft.listMembers.push({ listId, userId: input.userId });
  return { kind: 'created', dataSource };
}

export function sharedDataSource(seed: Seed, spaceKey: string): ServiceDataSource | undefined {
  return seed.dataSources.find((d): d is ServiceDataSource => d.kind === 'service' && d.shared?.spaceKey === spaceKey);
}

/**
 * ソースの読める人の 1 人。address はそのサービスのアカウント。
 * userId は IdP の ID で対応が付くとき（サインインと同じ Entra の Teams など）だけ渡す。渡されて User があれば、
 * その人の Contact に address を付ける（本人が名乗ったのと同じ扱い）。渡されなければ、address が付いている Contact の User
 */
export interface SpaceMember {
  address: AddressRef;
  userId?: string;
}

export interface SyncReadersResult {
  readers: string[];
  added: string[];
  removed: string[];
  /** 資格情報の持ち主（つないだ人）がもう読めない。シェルは取り込みを broken にする */
  ownerLost: boolean;
}

/** 共有リストの読者を、ソースの読める人に合わせる（0037 の決定 2）。対応の付かない人は読者にしない（推測しない） */
export function syncSharedReaders(draft: Seed, ctx: CoreContext, dataSourceId: string, members: readonly SpaceMember[]): SyncReadersResult {
  const ds = draft.dataSources.find((d) => d.id === dataSourceId);
  if (!ds || ds.kind !== 'service' || !ds.shared) throw new DomainError('not_found', `shared data source ${dataSourceId} not found`);
  const list = draft.lists.find((l) => l.dataSourceId === ds.id);
  if (!list) throw new DomainError('not_found', `list of ${dataSourceId} not found`);

  const readers = new Set<string>();
  for (const m of members) {
    if (m.userId) {
      if (!draft.users.some((u) => u.id === m.userId)) continue;
      try {
        bindIdentity(draft, m.userId, m.address, ctx);
      } catch (err) {
        // 別の User に付いているアドレスは付け替えない（名寄せは人とスタンド。0030）
        if (!(err instanceof DomainError && err.code === 'conflict')) throw err;
      }
      readers.add(m.userId);
      continue;
    }
    const dir = new Directory(draft);
    const contactId = dir.contactIdOfAddress(m.address, ctx.now);
    const userId = contactId ? dir.contact(contactId)?.userId : undefined;
    if (userId) readers.add(userId);
  }

  const current = draft.listMembers.filter((m) => m.listId === list.id).map((m) => m.userId);
  const added = [...readers].filter((u) => !current.includes(u));
  const removed = current.filter((u) => !readers.has(u));
  draft.listMembers = draft.listMembers.filter((m) => m.listId !== list.id || readers.has(m.userId));
  for (const userId of added) draft.listMembers.push({ listId: list.id, userId });
  const cred = draft.credentialRefs.find((c) => c.id === ds.credentialRefId);
  const owner = cred?.principal.kind === 'user' ? cred.principal.userId : null;
  return { readers: [...readers], added, removed, ownerLost: owner !== null && !readers.has(owner) };
}

/** つなぎ直し: 読者の 1 人の委任に資格情報を入れ替える（スレッドとリストはそのまま。0037 の決定 3） */
export function replaceSharedCredential(
  draft: Seed,
  ctx: CoreContext,
  dataSourceId: string,
  input: { userId: string; gatewayCredentialId: string; identity: string },
): ServiceDataSource {
  const ds = draft.dataSources.find((d) => d.id === dataSourceId);
  if (!ds || ds.kind !== 'service' || !ds.shared) throw new DomainError('not_found', `shared data source ${dataSourceId} not found`);
  const list = draft.lists.find((l) => l.dataSourceId === ds.id);
  if (!list || !draft.listMembers.some((m) => m.listId === list.id && m.userId === input.userId)) {
    throw new DomainError('forbidden', `user ${input.userId} は ${dataSourceId} の読者ではない`);
  }
  const address: AddressRef = { channel: ds.channel, value: input.identity.trim() };
  bindIdentity(draft, input.userId, address, ctx);
  const cred = draft.credentialRefs.find((c) => c.id === ds.credentialRefId);
  if (!cred) throw new DomainError('not_found', `credential ${ds.credentialRefId} not found`);
  cred.principal = { kind: 'user', userId: input.userId };
  cred.address = address;
  cred.gatewayCredentialId = input.gatewayCredentialId;
  return ds;
}

/** 外せる（つなぐのをやめる）のは、共有リストは作った人と管理者、個人のリストは本人（0037 の決定 4） */
export function canDisconnect(seed: Seed, dataSourceId: string, userId: string, isAdmin: boolean): boolean {
  const ds = seed.dataSources.find((d) => d.id === dataSourceId);
  if (!ds || ds.kind !== 'service') return false;
  if (ds.shared) return ds.shared.createdBy === userId || isAdmin;
  const cred = seed.credentialRefs.find((c) => c.id === ds.credentialRefId);
  return cred?.principal.kind === 'user' && cred.principal.userId === userId;
}
