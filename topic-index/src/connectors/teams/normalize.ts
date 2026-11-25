import { teamsAddress, type AddressRef, type InboundSignal } from '../../domain';
import type { ChannelMessage, ChannelReply, TeamsMessage } from './message';

// Teams のチャネルのメッセージ → InboundSignal（純関数。0036）。
// - 投稿と返信は Teams の上で 1 つのスレッド。アンカー threadTs に投稿の ID を入れ、返信は構造で投稿のスレッドに入る
// - 個人へのメンションを宛先（to）にする。チャネル・タグへのメンションは個人に落とさない
// - 編集・削除・リアクションは取り込まない（シグナルは追記だけ）。システムのメッセージとアプリの投稿も取り込まない

export type Normalized = { kind: 'signal'; signal: InboundSignal } | { kind: 'skip'; reason: string };

export function normalizeChannelMessage(dataSourceId: string, channelId: string, msg: ChannelMessage | ChannelReply, root?: ChannelMessage): Normalized {
  if (msg.messageType && msg.messageType !== 'message') return { kind: 'skip', reason: `messageType ${msg.messageType}` };
  if (msg.deletedDateTime) return { kind: 'skip', reason: 'deleted' };
  const user = msg.from?.user;
  if (!user?.id || !user.tenantId) return { kind: 'skip', reason: 'not from a user' };

  // メンションの tenantId がないとき（チャットの S0 で 4 分の 1 ほど。0044）は、投稿者のテナントで補う
  const senderTenant = user.tenantId;
  const to = mentionedAddresses(msg, () => senderTenant);
  const threadRoot = msg.replyToId ?? msg.id;
  const subject = (root ?? msg).subject?.trim();
  return {
    kind: 'signal',
    signal: {
      dataSourceId,
      channel: 'teams',
      from: { channel: 'teams', value: teamsAddress(user.tenantId, user.id) },
      to,
      ...(subject ? { subject } : {}),
      body: messageText(msg.body?.content ?? '', msg.body?.contentType),
      anchors: { messageId: msg.id, threadTs: threadRoot },
      sourceRef: `teams:${channelId}/${msg.id}`,
      occurredAt: msg.createdDateTime,
    },
  };
}

/**
 * 個人へのメンションの宛先（重ねない）。チャネル・チーム・チャットの全体・タグへのメンションは個人に落とさない。
 * メンションに tenantId がなければ tenantOf で補う（0044 の決定 4。補えなければ落とす）
 */
export function mentionedAddresses(msg: TeamsMessage, tenantOf: (objectId: string) => string | null | undefined): AddressRef[] {
  const to: AddressRef[] = [];
  for (const m of msg.mentions ?? []) {
    const u = m.mentioned?.user;
    if (!u?.id) continue;
    const tenant = u.tenantId || tenantOf(u.id);
    if (!tenant) continue;
    const value = teamsAddress(tenant, u.id);
    if (!to.some((a) => a.value === value)) to.push({ channel: 'teams', value });
  }
  return to;
}

/** 本文（HTML）を文にする。メンションは「@名前」のまま残す */
export function messageText(content: string, contentType?: string): string {
  if (contentType && contentType.toLowerCase() !== 'html') return content.trim();
  const text = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<at[^>]*>([\s\S]*?)<\/at>/gi, '@$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
