import { sameAddress } from './comm';
import type { CoreContext } from './context';
import { Directory } from './directory';
import type { Address, AddressRef, Channel, Contact, Seed } from './entities';
import { DomainError } from './errors';
import type { Projections } from './projections';
import { isOurs } from './sides';
import { canReadDataSource, type Viewer } from './viewer';

// User と Contact の作り方と名寄せ（0030 の 6〜9）。どれもマスタの写し（draft）を書き換える純関数で、
// シェルが MurmurService.changeMaster で差分と変更の記録にする。Murmur は自分では名寄せしない（候補を出すだけ）。

// ---- 6. サインイン ----

/** 検証済みの sub の User がなければ作る（名前は空。Contact は作らない） */
export function ensureUser(draft: Seed, userId: string): boolean {
  if (draft.users.some((u) => u.id === userId)) return false;
  draft.users.push({ id: userId, name: '' });
  return true;
}

/** 名前を付ける（PATCH /me） */
export function renameUser(draft: Seed, userId: string, name: string): void {
  const u = draft.users.find((x) => x.id === userId);
  if (!u) throw new DomainError('not_found', `user ${userId} not found`);
  if (!name.trim()) throw new DomainError('invalid', 'name is required');
  u.name = name.trim();
}

// ---- 7. リストでのアイデンティティ ----

export type IdentityOutcome =
  | { kind: 'created'; contactId: string }
  | { kind: 'attached'; contactId: string }
  | { kind: 'bound'; contactId: string }
  | { kind: 'already'; contactId: string }
  /** 本人の Contact とは別のゴーストにそのアドレスが付いている。まとめるかは本人に確かめる（merge） */
  | { kind: 'merge_candidate'; contactId: string; ghostContactId: string };

/**
 * リストでの本人のアイデンティティ（アドレス）で、本人の Contact を決める（0030 の 7 の表）。
 * - 付いている Contact がない → 本人の Contact に付ける（なければ作って sub に結ぶ）
 * - ゴースト → 本人に Contact がなければそのゴーストを sub に結ぶ。あればまとめる候補を返す（自動ではまとめない）
 * - 別の User の Contact → conflict
 */
export function bindIdentity(draft: Seed, userId: string, ref: AddressRef, ctx: CoreContext): IdentityOutcome {
  const dir = new Directory(draft);
  const own = dir.contactOfUser(userId);
  const holder = dir.contactIdOfAddress(ref, ctx.now);
  if (holder !== null) {
    const c = dir.contact(holder)!;
    if (c.userId === userId) return { kind: 'already', contactId: c.id };
    if (c.userId) throw new DomainError('conflict', `${ref.channel}:${ref.value} is another user's address (contact ${c.id})`);
    if (!own) {
      draftContact(draft, c.id).userId = userId;
      return { kind: 'bound', contactId: c.id };
    }
    return { kind: 'merge_candidate', contactId: own.id, ghostContactId: c.id };
  }
  if (own) {
    addAddress(draft, own.id, ref, ctx);
    return { kind: 'attached', contactId: own.id };
  }
  const id = ctx.newId('ct');
  const user = draft.users.find((u) => u.id === userId);
  draft.contacts.push({ id, name: user?.name || ref.value, userId, externalRefs: {} });
  addAddress(draft, id, ref, ctx);
  return { kind: 'created', contactId: id };
}

export interface PersonalDataSourceInput {
  channel: Channel;
  name: string;
  description?: string;
  /** そのリストでの本人のアイデンティティ（つないだアカウントのアドレス） */
  identity: string;
  /** ゲートウェイの本人の接続 */
  gatewayCredentialId: string;
  group?: boolean;
}

/**
 * 個人のリスト（個人の資格情報で取るデータソース。読者は本人だけ、0013）をスタンドから作る（0030 の 7）。
 * 窓口のアドレスは持たず、選んだアイデンティティが本人の Contact に付いて「こちら」になる
 */
export function createPersonalDataSource(
  draft: Seed,
  userId: string,
  input: PersonalDataSourceInput,
  ctx: CoreContext,
): { dataSourceId: string; listId: string; identity: IdentityOutcome } {
  if (!input.name.trim()) throw new DomainError('invalid', 'name is required');
  if (!input.identity.trim()) throw new DomainError('invalid', 'identity is required');
  if (!input.gatewayCredentialId.trim()) throw new DomainError('invalid', 'gateway_credential_id is required');
  const address: AddressRef = { channel: input.channel, value: input.identity.trim() };
  const dup = draft.dataSources.find(
    (d) =>
      d.kind === 'service' &&
      d.channel === input.channel &&
      draft.credentialRefs.some((c) => c.id === d.credentialRefId && c.principal.kind === 'user' && c.principal.userId === userId && sameAddress(c.address, address)),
  );
  if (dup) throw new DomainError('conflict', `data source ${dup.id} already reads ${input.channel}:${address.value}`);
  const identity = bindIdentity(draft, userId, address, ctx);
  const credentialRefId = ctx.newId('cr');
  draft.credentialRefs.push({ id: credentialRefId, principal: { kind: 'user', userId }, address, gatewayCredentialId: input.gatewayCredentialId });
  const dataSourceId = ctx.newId('ds');
  draft.dataSources.push({
    kind: 'service',
    id: dataSourceId,
    channel: input.channel,
    name: input.name.trim(),
    description: input.description ?? '',
    credentialRefId,
    selfAddresses: [],
    group: input.group ?? false,
  });
  const listId = ctx.newId('l');
  draft.lists.push({ id: listId, dataSourceId });
  draft.listMembers.push({ listId, userId });
  return { dataSourceId, listId, identity };
}

/**
 * 共有のリストに読者を足す（当面は管理者だけ。0030 の 7）。identity を渡せば同じ規則で本人の Contact を決める。
 * 共有メールボックスのように本人が自分のアドレスで出てこないリストは、identity なしで入れる
 */
export function addListMember(draft: Seed, listId: string, userId: string, identity: string | undefined, ctx: CoreContext): IdentityOutcome | null {
  const list = draft.lists.find((l) => l.id === listId);
  const ds = list ? draft.dataSources.find((d) => d.id === list.dataSourceId) : undefined;
  if (!list || !ds) throw new DomainError('not_found', `list ${listId} not found`);
  if (!draft.users.some((u) => u.id === userId)) throw new DomainError('not_found', `user ${userId} not found（サインインしていない）`);
  if (!draft.listMembers.some((m) => m.listId === listId && m.userId === userId)) draft.listMembers.push({ listId, userId });
  return identity === undefined ? null : bindIdentity(draft, userId, { channel: ds.channel, value: identity.trim() }, ctx);
}

// ---- 8. 名寄せ ----

/** チームのメンバー（どれかのリストの読者）だけが Contact を読み書きできる（Contact はチームで共有する連絡先） */
export function requireMember(viewer: Viewer): void {
  if (viewer.listIds.length === 0) throw new DomainError('forbidden', 'only a team member (a reader of some list) can read or change contacts');
}

export interface UnresolvedAddress {
  channel: Channel;
  value: string;
  /** 出てきた回数（送り主と宛先の両方を数える） */
  count: number;
  lastSeenAt: string;
  threadIds: string[];
}

/**
 * Viewer が読めるデータソースのシグナルに出てきたアドレスのうち、Contact に解決できないもの（シグナルの時刻で）。
 * 窓口のアドレスは数えない。最後に見た順
 */
export function unresolvedAddresses(dir: Directory, viewer: Viewer, p: Projections): UnresolvedAddress[] {
  const out = new Map<string, UnresolvedAddress>();
  for (const s of Object.values(p.signals)) {
    if (!canReadDataSource(viewer, s.dataSourceId)) continue;
    const ds = dir.dataSource(s.dataSourceId);
    for (const ref of [s.from, ...s.to]) {
      if (dir.contactIdOfAddress(ref, s.at) !== null) continue;
      if (ds?.kind === 'service' && isOurs(dir, ds, ref, s.at)) continue;
      const key = `${ref.channel}|${ref.value.toLowerCase()}`;
      const u = out.get(key) ?? { channel: ref.channel, value: ref.value, count: 0, lastSeenAt: s.at, threadIds: [] };
      u.count++;
      if (s.at > u.lastSeenAt) u.lastSeenAt = s.at;
      if (s.threadId && !u.threadIds.includes(s.threadId)) u.threadIds.push(s.threadId);
      out.set(key, u);
    }
  }
  return [...out.values()]
    .map((u) => ({ ...u, threadIds: u.threadIds.sort() }))
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : a.value < b.value ? -1 : 1));
}

export interface ContactView {
  id: string;
  name: string;
  userId: string | null;
  addresses: { id: string; channel: Channel; value: string; validFrom: string | null; validTo: string | null }[];
  externalRefs: Record<string, string>;
}

export function contactView(dir: Directory, c: Contact): ContactView {
  return {
    id: c.id,
    name: c.name,
    userId: c.userId ?? null,
    addresses: dir.seed.addresses
      .filter((a) => a.contactId === c.id)
      .map((a) => ({ id: a.id, channel: a.channel, value: a.value, validFrom: a.validFrom ?? null, validTo: a.validTo ?? null })),
    externalRefs: c.externalRefs,
  };
}

/** Contact を名前かアドレスで引く（部分一致、大文字小文字を区別しない）。q がなければ全部 */
export function searchContacts(dir: Directory, q: string | undefined): ContactView[] {
  const needle = q?.trim().toLowerCase() ?? '';
  return dir.seed.contacts
    .filter(
      (c) =>
        needle === '' ||
        c.name.toLowerCase().includes(needle) ||
        dir.seed.addresses.some((a) => a.contactId === c.id && a.value.toLowerCase().includes(needle)),
    )
    .map((c) => contactView(dir, c));
}

/** ゴーストを作る（名前と最初のアドレス） */
export function createContact(draft: Seed, input: { name: string; address?: AddressRef }, ctx: CoreContext): string {
  if (!input.name.trim()) throw new DomainError('invalid', 'name is required');
  const id = ctx.newId('ct');
  draft.contacts.push({ id, name: input.name.trim(), externalRefs: {} });
  if (input.address) addAddress(draft, id, input.address, ctx);
  return id;
}

/** アドレスを付ける（整合性: 同じ時点で 2 つの Contact に付かないことは planMasterEdit が確かめる） */
export function addAddress(draft: Seed, contactId: string, ref: AddressRef, ctx: CoreContext, validFrom?: string): string {
  draftContact(draft, contactId);
  if (!ref.value.trim()) throw new DomainError('invalid', 'address value is required');
  const holder = new Directory(draft).contactIdOfAddress(ref, validFrom ?? ctx.now);
  if (holder === contactId) throw new DomainError('conflict', `${ref.channel}:${ref.value} is already attached to ${contactId}`);
  if (holder !== null) throw new DomainError('conflict', `${ref.channel}:${ref.value} is attached to contact ${holder}（付け替えるなら先に終わらせる）`);
  const id = ctx.newId('adr');
  const a: Address = { id, channel: ref.channel, value: ref.value.trim(), contactId };
  if (validFrom) a.validFrom = validFrom;
  draft.addresses.push(a);
  return id;
}

/** アドレスを終わらせる（削除ではなく validTo。過去のシグナルは元の Contact のまま） */
export function endAddress(draft: Seed, contactId: string, addressId: string, ctx: CoreContext, validTo?: string): void {
  const a = draft.addresses.find((x) => x.id === addressId && x.contactId === contactId);
  if (!a) throw new DomainError('not_found', `address ${addressId} of contact ${contactId} not found`);
  const end = validTo ?? ctx.now;
  if (a.validFrom && end <= a.validFrom) throw new DomainError('invalid', 'valid_to must be after valid_from');
  a.validTo = end;
}

export function renameContact(draft: Seed, contactId: string, name: string): void {
  if (!name.trim()) throw new DomainError('invalid', 'name is required');
  draftContact(draft, contactId).name = name.trim();
}

// ---- 9. 直す操作 ----

/**
 * 2 つの Contact を 1 つにまとめる（from を into に）。アドレスは into に移し、from の ID は into の別名として残す
 * （イベントに残る Contact ID はクエリ層が読み替える。イベントは書き換えない）。両方に User が結ばれていればまとめない
 */
export function mergeContacts(draft: Seed, intoId: string, fromId: string): void {
  if (intoId === fromId) throw new DomainError('invalid', 'cannot merge a contact into itself');
  const into = draftContact(draft, intoId);
  const from = draftContact(draft, fromId);
  if (into.userId && from.userId) throw new DomainError('conflict', `both ${intoId} and ${fromId} are bound to users`);
  if (!into.userId && from.userId) into.userId = from.userId;
  into.externalRefs = { ...from.externalRefs, ...into.externalRefs };
  for (const a of draft.addresses) if (a.contactId === fromId) a.contactId = intoId;
  draft.contacts = draft.contacts.filter((c) => c.id !== fromId);
  draft.contactAliases = [...draft.contactAliases.map((x) => (x.contactId === fromId ? { ...x, contactId: intoId } : x)), { id: fromId, contactId: intoId }];
}

/** User との結びを外す（本人だけ。見えるものは変わらず、ボールの判定だけが変わる） */
export function unbindContact(draft: Seed, contactId: string, userId: string): void {
  const c = draftContact(draft, contactId);
  if (c.userId !== userId) throw new DomainError('forbidden', 'only the bound user can unbind the contact');
  delete c.userId;
}

function draftContact(draft: Seed, contactId: string): Contact {
  const c = draft.contacts.find((x) => x.id === contactId);
  if (!c) throw new DomainError('not_found', `contact ${contactId} not found`);
  return c;
}
