import { acknowledgeAttention, visibleThreadOrThrow } from './commands';
import type { CoreContext } from './context';
import { DomainError } from './errors';
import { draft, type AddressRef, type Anchors, type DraftEvent, type ThreadChoice, type ThreadedBy } from './events';
import { defaultTitle, resolveAnchors, type SignalPayload } from './ingest';
import { indexKey, type Projections } from './projections';
import { directionOf, isOurs } from './sides';
import { isTaskSource, replyStateOf } from './turn';
import type { Directory } from './directory';
import { canReadDataSource, type Viewer } from './viewer';

// 送信の記録（0012）と期限の見回り。本体は外に何も書かない。送信・起票・コメントはスタンドがゲートウェイ経由で行い、
// 送った直後に record_sent で事実だけを記録する。

export interface RecordSentInput {
  dataSourceId: string;
  /** 宛先のアドレス（チャネルはデータソースのもの） */
  to: string[];
  /** 宛先の Contact（そのチャネルの有効なアドレスに直す） */
  toContactIds: string[];
  /** 送ったアドレス。そのデータソースでこちらのアドレスであること。省けば窓口、窓口がなければ送った人の Contact のアドレス */
  from?: string;
  subject?: string;
  body: string;
  /** メールの Message-ID・Slack の ts・LINE の sentMessages[].id・Jira の課題キーやコメント ID・タスクのサービスのタスクの ID */
  sentRef: string;
  /** 送ったメッセージの構造アンカー（In-Reply-To・thread_ts・課題キーなど） */
  anchors?: Omit<Anchors, 'messageId'>;
  /** 返事をしているスレッド（同じデータソース）。送ったシグナルはそこに入る */
  replyToThreadId?: string;
  /** 送る元になったスレッド（どのデータソースでもよい）。送ったスレッドと経路 sent で結ぶ */
  sourceThreadId?: string;
  /** UTC の ISO 8601（シェルがそろえる） */
  replyExpectedBy?: string;
  /** 送ったスレッドの、送る前までの自分への名指し（自分のアドレスとリスト宛て）を一緒に外す（0038 の決定 3。明示の指定） */
  acknowledge?: boolean;
}

/**
 * record_sent の判断。
 * - 送ったシグナルの置き先: reply_to のスレッド → アンカー（同じデータソースの中）→ 新しいスレッド
 * - 同じ sent_ref の観測された送信が先に届いていれば、そのシグナルに記録を重ねる（H5。reply_to が違えば移す）
 * - 同じ sent_ref の記録が既にあれば何もしない（冪等）
 * - source のスレッドがあれば経路 sent で結ぶ（Murmur が張るリンクの唯一の例外。スタンドの操作の一部）
 * - acknowledge なら、送ったスレッドの自分への名指しを送る前の分まで外す
 * - タスクのサービス（0039 の決定 3）: タスクを作った記録。宛先は要らず、タスクの ID（sent_ref）がソースの区切りになる。
 *   写しが先に届いていればそのスレッドに入り、あとから届く写しも同じスレッドに入る
 */
export function recordSent(
  p: Projections,
  viewer: Viewer,
  ctx: CoreContext,
  input: RecordSentInput,
): { events: DraftEvent[]; threadId: string; signalId: string } {
  const ds = ctx.dir.dataSource(input.dataSourceId);
  if (!ds || !canReadDataSource(viewer, ds.id)) {
    throw new DomainError('not_found', `data source ${input.dataSourceId} not found`);
  }
  if (!input.body.trim()) throw new DomainError('invalid', 'body is required');
  if (!input.sentRef.trim()) throw new DomainError('invalid', 'sent_ref is required');

  const to: AddressRef[] = input.to.map((value) => ({ channel: ds.channel, value }));
  for (const contactId of input.toContactIds) {
    const contact = ctx.dir.contact(contactId);
    const address = contact ? ctx.dir.addressesOfContact(contact.id, ds.channel, ctx.now)[0] : undefined;
    if (!address) throw new DomainError('invalid', `contact ${contactId} has no ${ds.channel} address`);
    if (!to.some((a) => a.value === address.value)) to.push({ channel: ds.channel, value: address.value });
  }
  const task = isTaskSource(ds);
  if (to.length === 0 && !task) throw new DomainError('invalid', 'to or to_contact_ids is required');
  // 送り主: 指定があればそれ（こちらのアドレスに限る）、なければ窓口（共有メールボックスなど）、窓口がなければ（個人の箱）送った人の Contact のアドレス
  let from: AddressRef | undefined;
  if (input.from !== undefined) {
    from = { channel: ds.channel, value: input.from };
    if (!isOurs(ctx.dir, ds, from, ctx.now)) throw new DomainError('invalid', `from ${input.from} is not an address of this data source`);
  } else {
    const own = viewer.contactId !== null ? ctx.dir.addressesOfContact(viewer.contactId, ds.channel, ctx.now)[0] : undefined;
    from = ds.selfAddresses[0] ?? (own ? { channel: ds.channel, value: own.value } : undefined);
  }
  if (!from) throw new DomainError('invalid', `data source ${ds.id} has no address to send from`);

  const replyTo = input.replyToThreadId !== undefined ? visibleThreadOrThrow(p, viewer, input.replyToThreadId) : undefined;
  if (replyTo && replyTo.dataSourceId !== ds.id) throw new DomainError('invalid', `reply_to thread ${replyTo.id} is in another data source`);
  const source = input.sourceThreadId !== undefined ? visibleThreadOrThrow(p, viewer, input.sourceThreadId) : undefined;

  const existing = p.signals[p.index.messageIds[indexKey(ds.id, input.sentRef)] ?? ''];
  if (existing?.recorded) return { events: [], threadId: existing.threadId!, signalId: existing.signalId };
  if (existing && directionOf(ctx.dir, existing) !== 'outbound') {
    throw new DomainError('conflict', `sent_ref ${input.sentRef} is already a received message`);
  }

  const events: DraftEvent[] = [];
  const signalId = existing?.signalId ?? ctx.newId('sig');
  const anchors = { ...(input.anchors ?? {}), ...(task && !input.anchors?.threadKey ? { threadKey: input.sentRef } : {}) };
  events.push(
    draft('OutboundRecorded', {
      signalId,
      merged: existing !== undefined,
      dataSourceId: ds.id,
      channel: ds.channel,
      from,
      to,
      subject: input.subject,
      body: input.body,
      anchors,
      sentRef: input.sentRef,
      sourceThreadId: source?.id ?? null,
      replyExpectedBy: input.replyExpectedBy ?? null,
      actorUserId: viewer.userId,
    }),
  );

  let threadId: string;
  if (existing) {
    // 観測が先に届いていた。置き先は Ingest の判断のまま、reply_to が違えば本人の指定に移す
    threadId = existing.threadId!;
    if (replyTo && replyTo.id !== threadId) {
      events.push(threaded(signalId, { kind: 'existing', threadId: replyTo.id }, 'self', '送った本人が返事をしているスレッド'));
      threadId = replyTo.id;
    }
  } else {
    let choice: ThreadChoice;
    let by: ThreadedBy;
    let reason: string;
    const sig = { signalId, dataSourceId: ds.id, anchors: { ...anchors, messageId: input.sentRef } } as SignalPayload;
    const anchored = replyTo ? null : resolveAnchors(p, sig);
    if (replyTo) {
      choice = { kind: 'existing', threadId: replyTo.id };
      by = 'self';
      reason = '送った本人が返事をしているスレッド';
    } else if (anchored?.kind === 'existing') {
      choice = { kind: 'existing', threadId: anchored.threadId };
      by = 'anchor';
      reason = anchored.reason;
    } else {
      choice = { kind: 'new', threadId: ctx.newId('thr'), title: defaultTitle(input) };
      by = anchored ? 'anchor' : 'self';
      reason = anchored?.kind === 'new' ? anchored.reason : '送った本人の新しい送信';
    }
    events.push(threaded(signalId, choice, by, reason));
    threadId = choice.threadId;
  }

  if (input.acknowledge && p.threads[threadId]) {
    events.push(...acknowledgeAttention(p, viewer, ctx.dir, { threadId, reason: `返事を送った（${input.sentRef}）` }));
  }

  if (source && source.id !== threadId && !source.links.some((l) => l.threadId === threadId)) {
    events.push(
      draft('ThreadLinked', { a: source.id, b: threadId, op: 'link', route: 'sent', actorUserId: viewer.userId, reason: `送信 ${input.sentRef}` }),
    );
  }
  return { events, threadId, signalId };

  function threaded(id: string, choice: ThreadChoice, by: ThreadedBy, reason: string): DraftEvent {
    return draft('SignalThreaded', { signalId: id, thread: choice, by, confidence: 1, reason, actorUserId: viewer.userId });
  }
}

/** 期限の見回り（Cron）。返事期待が続いていて（相手の名指しが外れていない）期限を過ぎ、まだ超過になっていないスレッドに ReplyOverdue を出す。冪等 */
export function planOverdue(dir: Directory, p: Projections, now: string): DraftEvent[] {
  return Object.values(p.threads)
    .filter((t) => {
      if (t.dismissed || t.closedAtSource || t.overdue || t.replyExpectedSignalId === null) return false;
      const r = replyStateOf(dir, t);
      return r.replyExpectedBy !== null && r.replyExpectedBy < now;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t) => draft('ReplyOverdue', { threadId: t.id, signalId: t.replyExpectedSignalId!, replyExpectedBy: t.replyExpectedBy! }));
}
