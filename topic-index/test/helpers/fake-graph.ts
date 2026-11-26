import { GraphAccessDenied, GraphError, GRAPH_ORIGIN, type CreatedSubscription, type GraphApi, type GraphMe } from '../../src/connectors/graph/api';
import { GatewayAuthError } from '../../src/ports/gateway';
import type { DeltaPage } from '../../src/connectors/graph/message';

/** Graph の偽物（本人の箱）。フォルダごとのメールと、delta の位置（何通目まで渡したか）とサブスクリプションを持つ */
export class FakeGraph implements GraphApi {
  readonly folders = new Map<string, Record<string, unknown>[]>();
  readonly subscriptions = new Map<string, { folder: string; clientState: string; expiresAt: string; notificationUrl: string }>();
  readonly calls: string[] = [];
  pageSize = 2;
  /** これを立てると同意の問題（ゲートウェイの 403）になる */
  authBroken = false;
  /** 共有メールボックス（0042）: 読める箱のアドレス（小文字）。delta の呼び出しは calls に `deltaStart <フォルダ> @<箱>` で残る */
  readonly readable = new Set<string>();
  /** 無効にした delta の位置 */
  readonly invalidLinks = new Set<string>();
  private seq = 0;

  constructor(readonly meInfo: GraphMe = { id: 'oid_bob', displayName: 'Bob', addresses: ['bob@ubs.example'] }) {}

  deliver(folder: string, msg: Record<string, unknown>) {
    const list = this.folders.get(folder) ?? [];
    list.push(msg);
    this.folders.set(folder, list);
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async me() {
    this.check('me');
    return this.meInfo;
  }

  async deltaStart(folder: string, since: string, mailbox = 'me'): Promise<DeltaPage> {
    this.check(mailbox === 'me' ? `deltaStart ${folder}` : `deltaStart ${folder} @${mailbox}`);
    if (mailbox !== 'me' && !this.readable.has(mailbox.toLowerCase())) throw new GraphAccessDenied('ErrorAccessDenied');
    return this.page(folder, since, 0);
  }

  async mailboxReadable(mailbox: string) {
    this.check(`readable ${mailbox}`);
    return mailbox === 'me' || this.readable.has(mailbox.toLowerCase());
  }

  async deltaNext(link: string): Promise<DeltaPage> {
    this.check(`deltaNext ${link.replace(GRAPH_ORIGIN, '')}`);
    if (this.invalidLinks.has(link)) throw new GraphError(410, 'syncStateNotFound');
    const u = new URL(link);
    const [folder, since, offset] = (u.searchParams.get('$skiptoken') ?? u.searchParams.get('$deltatoken'))!.split('|');
    return this.page(folder!, since!, Number(offset));
  }

  private page(folder: string, since: string, offset: number): DeltaPage {
    const all = (this.folders.get(folder) ?? []).filter((m) => String(m.receivedDateTime) >= since);
    const value = all.slice(offset, offset + this.pageSize);
    const end = offset + value.length;
    const base = `${GRAPH_ORIGIN}/v1.0/me/mailFolders/${folder}/messages/delta`;
    if (end < all.length) return { value, '@odata.nextLink': `${base}?$skiptoken=${folder}|${since}|${end}` };
    return { value, '@odata.deltaLink': `${base}?$deltatoken=${folder}|${since}|${end}` };
  }

  async createSubscription(input: { folder: string; notificationUrl: string; clientState: string; expiresAt: string }): Promise<CreatedSubscription> {
    this.check(`create ${input.folder}`);
    const id = `sub_${++this.seq}`;
    this.subscriptions.set(id, { folder: input.folder, clientState: input.clientState, expiresAt: input.expiresAt, notificationUrl: input.notificationUrl });
    return { id, expiresAt: input.expiresAt };
  }

  async renewSubscription(id: string, expiresAt: string) {
    this.check(`renew ${id}`);
    const s = this.subscriptions.get(id);
    if (!s) return null;
    s.expiresAt = expiresAt;
    return expiresAt;
  }

  async deleteSubscription(id: string) {
    this.check(`delete ${id}`);
    this.subscriptions.delete(id);
  }

  /** そのフォルダのサブスクリプションへの通知の本文（Graph が受け口に POST するもの） */
  notification(folder: string, lifecycleEvent?: string) {
    const [id, s] = [...this.subscriptions].find(([, x]) => x.folder === folder)!;
    return { value: [{ subscriptionId: id, clientState: s.clientState, ...(lifecycleEvent ? { lifecycleEvent } : { changeType: 'created', resource: 'x' }) }] };
  }
}

let n = 0;
/** Graph の message（delta の 1 件） */
export function mail(over: { from: string; to?: string[]; subject?: string; body?: string; at: string; id?: string; mid?: string; inReplyTo?: string; uniqueBody?: boolean }) {
  const id = over.id ?? `m${++n}`;
  return {
    id,
    internetMessageId: over.mid ?? `<${id}@mail.example>`,
    subject: over.subject ?? '件名',
    from: { emailAddress: { address: over.from } },
    toRecipients: (over.to ?? ['bob@ubs.example']).map((address) => ({ emailAddress: { address } })),
    receivedDateTime: over.at,
    isDraft: false,
    body: { contentType: 'text', content: over.body ?? '本文' },
    ...(over.uniqueBody === false ? {} : { uniqueBody: { contentType: 'text', content: over.body ?? '本文' } }),
    // 受信トレイは delta でヘッダーが付く。送信済みには付かない（実物）ので、テストでは渡したときだけ付ける
    ...(over.inReplyTo ? { internetMessageHeaders: [{ name: 'In-Reply-To', value: over.inReplyTo }] } : {}),
  };
}
