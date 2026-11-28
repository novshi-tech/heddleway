import { teamsAddress, type AddressRef, type InboundSignal } from '../../domain';
import type { TeamsChatRecord } from '../graph/state';
import type { TeamsMessage } from '../teams/message';
import { mentionedAddresses, messageText } from '../teams/normalize';

// Teams のチャットのメッセージ → InboundSignal（純関数。0044）。
// - 区切りの木はない。会話（チャットの ID）とその種類をアンカーに入れ、区切りの候補を同じチャットに限る（決定 2）
// - 引用の返信（messageReference）の id を quotedMessageId に。転送（forwardedMessageReference）はアンカーにしない
// - 宛先: 1 対 1 は相手（受信なら本人、送信なら相手）。グループは個人へのメンションだけ（決定 3）
// - 編集・削除・リアクション・システムのメッセージ・アプリの投稿は取り込まない（シグナルは追記だけ）

export type Normalized = { kind: 'signal'; signal: InboundSignal } | { kind: 'skip'; reason: string };

export interface ChatContext {
  dataSourceId: string;
  chatId: string;
  record: TeamsChatRecord;
  /** 本人の Entra のテナントとオブジェクト ID */
  self: { tenantId: string; objectId: string };
}

export function normalizeChatMessage(ctx: ChatContext, msg: TeamsMessage): Normalized {
  const { record, self } = ctx;
  if (record.kind === 'skip') return { kind: 'skip', reason: 'chat not ingested' };
  if (msg.messageType && msg.messageType !== 'message') return { kind: 'skip', reason: `messageType ${msg.messageType}` };
  if (msg.deletedDateTime) return { kind: 'skip', reason: 'deleted' };
  const user = msg.from?.user;
  if (!user?.id) return { kind: 'skip', reason: 'not from a user' };

  // tenantId がないときは、メンバーの一覧、チャットのテナントの順に補う（S0）
  const tenantOf = (objectId: string) => record.members.find((m) => m.objectId === objectId)?.tenantId ?? record.tenantId;
  const fromTenant = user.tenantId || tenantOf(user.id);
  if (!fromTenant) return { kind: 'skip', reason: 'unknown tenant' };
  const fromSelf = user.id === self.objectId;

  let to: AddressRef[];
  if (record.kind === 'direct') {
    to = fromSelf
      ? record.members
          .filter((m) => m.objectId !== self.objectId)
          .flatMap((m) => {
            const t = m.tenantId ?? record.tenantId;
            return t ? [{ channel: 'teams' as const, value: teamsAddress(t, m.objectId) }] : [];
          })
      : [{ channel: 'teams', value: teamsAddress(self.tenantId, self.objectId) }];
  } else {
    to = mentionedAddresses(msg, tenantOf);
  }
  const quoted = (msg.attachments ?? []).find((a) => a.contentType === 'messageReference' && a.id)?.id ?? undefined;
  const subject = msg.subject?.trim();
  return {
    kind: 'signal',
    signal: {
      dataSourceId: ctx.dataSourceId,
      channel: 'teams',
      from: { channel: 'teams', value: teamsAddress(fromTenant, user.id) },
      ...(user.displayName?.trim() ? { fromName: user.displayName.trim() } : {}),
      to,
      ...(subject ? { subject } : {}),
      body: messageText(msg.body?.content ?? '', msg.body?.contentType),
      anchors: {
        messageId: msg.id,
        ...(quoted ? { quotedMessageId: quoted } : {}),
        conversationId: ctx.chatId,
        conversationGroup: record.kind === 'group',
      },
      sourceRef: `teams-chat:${ctx.chatId}/${msg.id}`,
      occurredAt: msg.createdDateTime,
    },
  };
}
