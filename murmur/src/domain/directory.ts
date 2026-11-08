import type { Address, Channel, CredentialRef, DataSource, List, Contact, Seed, User } from './entities';
import type { AddressRef } from './events';

/**
 * マスタの読み取り専用ビュー。純粋な検索だけを持つ。
 * シェルは DB か seed.json からマスタを読み、これに包んでコアへ渡す。
 */
export class Directory {
  constructor(readonly seed: Seed) {}

  /** Contact を引く。まとめて消えた ID なら、まとめ先（0030 の 9） */
  contact(contactId: string): Contact | undefined {
    const id = this.seed.contactAliases.find((a) => a.id === contactId)?.contactId ?? contactId;
    return this.seed.contacts.find((p) => p.id === id);
  }

  dataSource(dataSourceId: string): DataSource | undefined {
    return this.seed.dataSources.find((d) => d.id === dataSourceId);
  }

  list(listId: string): List | undefined {
    return this.seed.lists.find((l) => l.id === listId);
  }

  credentialRef(credentialRefId: string): CredentialRef | undefined {
    return this.seed.credentialRefs.find((c) => c.id === credentialRefId);
  }

  listOfDataSource(dataSourceId: string): List | undefined {
    return this.seed.lists.find((l) => l.dataSourceId === dataSourceId);
  }

  /** User の Contact（このデプロイに 1 つまで）。ゴースト Contact は User を持たないので出てこない */
  contactOfUser(userId: string): Contact | undefined {
    return this.seed.contacts.find((p) => p.userId === userId);
  }

  user(userId: string): User | undefined {
    return this.seed.users.find((u) => u.id === userId);
  }

  listIdsOfUser(userId: string): string[] {
    return this.seed.listMembers.filter((m) => m.userId === userId).map((m) => m.listId);
  }

  /** リストの読者の User ID（ListMember の順） */
  readersOfList(listId: string): string[] {
    return this.seed.listMembers.filter((m) => m.listId === listId).map((m) => m.userId);
  }

  /** 読者の Contact（ボールの判定に使う。Contact のない読者は出てこない） */
  readerContactsOfList(listId: string): Contact[] {
    return this.readersOfList(listId)
      .map((u) => this.contactOfUser(u))
      .filter((c): c is Contact => c !== undefined);
  }

  address(addressId: string): Address | undefined {
    return this.seed.addresses.find((a) => a.id === addressId);
  }

  /** at 時点で有効な Address を引く。期間付きの紐づけに対応する */
  findAddress(ref: AddressRef, at?: string): Address | undefined {
    return this.seed.addresses.find((a) => a.channel === ref.channel && sameValue(a.value, ref.value) && isValidAt(a, at));
  }

  contactIdOfAddress(ref: AddressRef, at?: string): string | null {
    return this.findAddress(ref, at)?.contactId ?? null;
  }

  addressesOfContact(contactId: string, channel?: Channel, at?: string): Address[] {
    return this.seed.addresses.filter(
      (a) => a.contactId === contactId && (channel === undefined || a.channel === channel) && isValidAt(a, at),
    );
  }
}

export function sameValue(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function overlaps(a: Address, b: Address): boolean {
  const start = (x: Address) => x.validFrom ?? '';
  const end = (x: Address) => x.validTo ?? '\uffff';
  return start(a) < end(b) && start(b) < end(a);
}

function isValidAt(a: Address, at?: string): boolean {
  if (!at) return true;
  if (a.validFrom && at < a.validFrom) return false;
  if (a.validTo && at >= a.validTo) return false;
  return true;
}

/**
 * マスタの整合性（H3 の前提）。問題の一覧を返す（空なら整合している）。
 * - User の Contact は 1 つまで（1 デプロイ = 1 チーム、0020・0021）
 * - データソース 1 つにリスト 1 つ
 * - 個人の資格情報は読者 1 人（その本人）のデータソースにしか使わない。共有のデータソースは組織の資格情報（0013）か、
 *   読者をソースから写す共有リスト（0037）。共有リストはスペースに 1 つ
 */
export function seedProblems(seed: Seed): string[] {
  const dir = new Directory(seed);
  const problems: string[] = [];
  for (const u of seed.users) {
    const contacts = seed.contacts.filter((p) => p.userId === u.id);
    if (contacts.length > 1) problems.push(`user ${u.id}: Contact が ${contacts.length} 個（1 個まで）`);
  }
  for (const ds of seed.dataSources) {
    const lists = seed.lists.filter((l) => l.dataSourceId === ds.id);
    if (lists.length !== 1) {
      problems.push(`data source ${ds.id}: リストが ${lists.length} 個（1 個のはず）`);
      continue;
    }
    const list = lists[0]!;
    const readers = dir.readersOfList(list.id);
    for (const r of readers) {
      if (!dir.user(r)) problems.push(`list ${list.id}: 読者 ${r} が User ではない`);
    }
    const cred = seed.credentialRefs.find((c) => c.id === ds.credentialRefId);
    if (!cred) {
      problems.push(`data source ${ds.id}: 資格情報 ${ds.credentialRefId} がない`);
    } else if (cred.principal.kind === 'user' && !ds.shared) {
      if (readers.length !== 1 || readers[0] !== cred.principal.userId) {
        problems.push(`data source ${ds.id}: 個人の資格情報は読者 1 人（その本人）のデータソースにしか使わない`);
      }
    }
    for (const a of ds.selfAddresses) {
      if (a.channel !== ds.channel) problems.push(`data source ${ds.id}: 窓口のアドレス ${a.value} のチャネルが ${a.channel}`);
    }
  }
  for (const l of seed.lists) {
    if (!dir.dataSource(l.dataSourceId)) problems.push(`list ${l.id}: data source ${l.dataSourceId} がない`);
  }
  // 共有リストはスペースに 1 つ（0037 の決定 1）
  const spaces = new Map<string, string>();
  for (const ds of seed.dataSources) {
    if (ds.kind !== 'service' || !ds.shared) continue;
    const other = spaces.get(ds.shared.spaceKey);
    if (other) problems.push(`data source ${ds.id}: スペース ${ds.shared.spaceKey} の共有リストは ${other} がある`);
    else spaces.set(ds.shared.spaceKey, ds.id);
  }
  for (const a of seed.contactAliases) {
    if (!seed.contacts.some((c) => c.id === a.contactId)) problems.push(`contact alias ${a.id}: まとめ先 ${a.contactId} がない`);
    if (seed.contacts.some((c) => c.id === a.id)) problems.push(`contact alias ${a.id}: まだ Contact として残っている`);
  }
  // 1 つのアドレスは、ある時点で 1 つの Contact にしか付かない（0030）
  const byValue = new Map<string, Address[]>();
  for (const a of seed.addresses) {
    if (!dir.contact(a.contactId)) problems.push(`address ${a.id}: contact ${a.contactId} がない`);
    const k = `${a.channel}|${a.value.toLowerCase()}`;
    byValue.set(k, [...(byValue.get(k) ?? []), a]);
  }
  for (const xs of byValue.values()) {
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        if (overlaps(xs[i]!, xs[j]!)) problems.push(`address ${xs[i]!.value}: ${xs[i]!.id} と ${xs[j]!.id} の期間が重なる`);
      }
    }
  }
  return problems;
}
