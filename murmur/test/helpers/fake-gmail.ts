import { GmailError, type GmailApi } from '../../src/connectors/gmail/api';
import type { GmailPart, GmailProfile, GmailSendAs, HistoryPage } from '../../src/connectors/gmail/message';
import { GatewayAuthError } from '../../src/ports/gateway';

/** 文字（UTF-8 のバイト列）→ base64url（パディングなし） */
export function b64url(text: string | Uint8Array): string {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Gmail の偽物（本人の箱）。メッセージと、増えた順の履歴（historyId は増え続ける）を持つ。
 * history は startHistoryId より後のレコードを返す（inclusive にすると startHistoryId 以後。本物がどちらかは実物で確かめる）。
 * expireHistory() 以前の位置は 404（古すぎる）。一覧は新しい順で、SPAM・TRASH は本物と同じく既定で除く
 */
export class FakeGmail implements GmailApi {
  readonly messages = new Map<string, Record<string, unknown>>();
  /** labels は届いた時点のラベル（本物の履歴のメッセージも、その時点のラベルを持つ） */
  readonly records: { id: number; added: string[]; labels: Record<string, string[]> }[] = [];
  readonly calls: string[] = [];
  head = 1000;
  oldest = 0;
  /** history の 1 ページのレコード数 */
  historyPageSize = 2;
  /** messages.list の 1 ページの件数 */
  listPageSize = 2;
  inclusive = false;
  authBroken = false;
  /** 次の呼び出し（関数名）を失敗させる */
  failNext: { fn: string; error: Error } | null = null;
  /** history・message・list の呼び出しの前に呼ぶ（読んでいる間に外される・つなぎ直されるなどを起こす） */
  beforeCall: ((fn: string) => Promise<void> | void) | null = null;
  /** 取ろうとすると 404（消えた）にするメッセージ。履歴や一覧には残る */
  readonly vanished = new Set<string>();

  constructor(
    public email = 'bob@gws.example',
    public sendAsList: GmailSendAs[] = [{ sendAsEmail: 'bob@gws.example', displayName: 'Bob Tanaka', isPrimary: true }],
  ) {}

  /** メッセージが届く（履歴に 1 レコード）。同じレコードに複数入れてもよい */
  deliver(...msgs: Record<string, unknown>[]) {
    for (const m of msgs) this.messages.set(String(m.id), m);
    this.records.push({ id: ++this.head, added: msgs.map((m) => String(m.id)), labels: Object.fromEntries(msgs.map((m) => [String(m.id), [...((m.labelIds as string[] | undefined) ?? [])]])) });
  }

  /** 履歴は残さず箱にだけ置く（切れた履歴の間に着いたメール） */
  place(msg: Record<string, unknown>) {
    this.messages.set(String(msg.id), msg);
    this.head++;
  }

  /** いまの historyId 以前の位置は古すぎる（404）ことにする */
  expireHistory() {
    this.oldest = this.head + 1;
  }

  private check(fn: string) {
    this.calls.push(fn);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
    if (this.failNext && fn.startsWith(this.failNext.fn)) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async profile(): Promise<GmailProfile> {
    this.check('profile');
    return { emailAddress: this.email, historyId: String(this.head) };
  }

  async sendAs() {
    this.check('sendAs');
    return this.sendAsList;
  }

  async history(startHistoryId: string, pageToken?: string | null): Promise<HistoryPage> {
    this.check(`history ${startHistoryId}${pageToken ? ` ${pageToken}` : ''}`);
    await this.beforeCall?.('history');
    if (Number(startHistoryId) < this.oldest) throw new GmailError(404, 'NOT_FOUND');
    const start = Number(startHistoryId);
    const all = this.records.filter((r) => (this.inclusive ? r.id >= start : r.id > start) && r.id >= this.oldest);
    const offset = pageToken ? Number(pageToken.split(':')[1]) : 0;
    const items = all.slice(offset, offset + this.historyPageSize);
    const end = offset + items.length;
    return {
      ...(items.length > 0
        ? {
            history: items.map((r) => ({
              id: String(r.id),
              messagesAdded: r.added.map((id) => ({ message: { id, threadId: `t_${id}`, labelIds: r.labels[id] ?? [] } })),
            })),
          }
        : {}),
      ...(end < all.length ? { nextPageToken: `h:${end}` } : {}),
      historyId: String(this.head),
    };
  }

  async message(id: string) {
    this.check(`message ${id}`);
    await this.beforeCall?.('message');
    if (this.vanished.has(id)) return null;
    return this.messages.get(id) ?? null;
  }

  async list(after: number, pageToken?: string | null) {
    this.check(`list ${after}${pageToken ? ` ${pageToken}` : ''}`);
    await this.beforeCall?.('list');
    const all = [...this.messages.values()]
      .filter((m) => Number(m.internalDate) / 1000 >= after && !((m.labelIds as string[] | undefined) ?? []).some((l) => l === 'SPAM' || l === 'TRASH'))
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const offset = pageToken ? Number(pageToken.split(':')[1]) : 0;
    const items = all.slice(offset, offset + this.listPageSize);
    const end = offset + items.length;
    return { ids: items.map((m) => String(m.id)), ...(end < all.length ? { nextPageToken: `l:${end}` } : {}) };
  }

  get fetched() {
    return this.calls.filter((c) => c.startsWith('message ')).map((c) => c.slice(8));
  }
}

let n = 0;

interface MailOptions {
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  html?: string;
  /** ISO 8601 */
  at: string;
  id?: string;
  /** Message-ID（山括弧つき） */
  mid?: string | null;
  inReplyTo?: string;
  labels?: string[];
  charset?: string;
  parts?: unknown;
  headers?: { name: string; value: string }[];
}

/** Gmail の message（format=full の 1 通）。本文は text/plain（html だけを渡すと text/html） */
export function gmailMessage(o: MailOptions) {
  const id = o.id ?? `g${++n}`;
  const headers = [
    ...(o.mid === null ? [] : [{ name: 'Message-ID', value: o.mid ?? `<${id}@mail.example>` }]),
    { name: 'From', value: o.from },
    { name: 'To', value: o.to ?? 'bob@gws.example' },
    ...(o.cc ? [{ name: 'Cc', value: o.cc }] : []),
    { name: 'Subject', value: o.subject ?? '件名' },
    { name: 'Date', value: new Date(o.at).toUTCString() },
    ...(o.inReplyTo ? [{ name: 'In-Reply-To', value: o.inReplyTo }] : []),
    ...(o.headers ?? []),
  ];
  const ct = (mime: string) => ({ name: 'Content-Type', value: `${mime}; charset=${o.charset ?? 'UTF-8'}` });
  const payload = o.parts
    ? { mimeType: 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts: o.parts }
    : o.html !== undefined && o.body === undefined
      ? { mimeType: 'text/html', filename: '', headers: [...headers, ct('text/html')], body: { size: o.html.length, data: b64url(o.html) } }
      : { mimeType: 'text/plain', filename: '', headers: [...headers, ct('text/plain')], body: { size: 10, data: b64url(o.body ?? '本文') } };
  return { id, threadId: `t_${id}`, labelIds: o.labels ?? ['INBOX'], internalDate: String(Date.parse(o.at)), payload };
}

/** MIME の部分（テスト用） */
export function part(mimeType: string, text: string | null, over: { filename?: string; charset?: string; parts?: GmailPart[]; bytes?: Uint8Array } = {}): GmailPart {
  return {
    mimeType,
    filename: over.filename ?? '',
    headers: over.charset ? [{ name: 'Content-Type', value: `${mimeType}; charset="${over.charset}"` }] : [],
    body: text === null && !over.bytes ? { size: 0 } : { size: 1, data: b64url(over.bytes ?? text!) },
    ...(over.parts ? { parts: over.parts } : {}),
  };
}
