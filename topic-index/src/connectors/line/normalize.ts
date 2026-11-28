import { lineOfficialAccount, type AddressRef, type InboundSignal } from '../../domain';
import type { LineEvent } from './api';

// 受け口の LINE のイベント → InboundSignal（純関数。0049 の決定 5）。
// - 相手のアドレスは LINE の userId（グループ・トークルームでは送り主の userId）。窓口は公式アカウント（oa:<組織 ID>）
// - 会話のアンカー（0044）: conversationId は 1 対 1 なら相手の userId、グループ・トークルームなら groupId / roomId
// - 1 対 1 の受信は窓口宛て（リスト宛ての名指し。0038）。グループの受信は文脈だけ（受け口がメンションを持たないので、
//   全部を名指しにすると人どうしの会話でリストが埋まる）。送信（Outbound）は窓口から相手（グループならグループ）宛て
// - messageId は LINE のメッセージ ID（受信）と送ったメッセージの ID（送信）で、record_sent の sent_ref と同じ（H5）

export type Normalized = { kind: 'signal'; signal: InboundSignal } | { kind: 'skip'; reason: string };

export interface LineContext {
  dataSourceId: string;
  /** 受け口の組織の ID */
  organizationId: string;
}

/** テキスト以外のメッセージの本文の印（中身は受け口から読む） */
const MARKERS: Record<string, string> = {
  image: '[画像]',
  video: '[動画]',
  audio: '[音声]',
  file: '[ファイル]',
  location: '[位置情報]',
  sticker: '[スタンプ]',
};

export function normalizeLineEvent(ctx: LineContext, e: LineEvent): Normalized {
  if (e.type !== 'message' && e.type !== 'postback') return { kind: 'skip', reason: `event ${e.type}` };
  const oa = lineOfficialAccount(ctx.organizationId);
  const group = e.groupId ?? null;
  const conversation = group ?? e.lineUserId ?? null;
  if (!conversation) return { kind: 'skip', reason: 'no counterpart' };

  let from: AddressRef;
  let fromName: string | undefined;
  let to: AddressRef[];
  if (e.direction === 'OUTBOUND') {
    from = oa;
    to = [address(conversation)];
  } else {
    // グループで userId が取れないメッセージ（友だちでない人）は、送り主が決まらないので取り込まない
    if (!e.lineUserId) return { kind: 'skip', reason: 'unknown sender' };
    from = address(e.lineUserId);
    fromName = e.displayName?.trim() || undefined;
    to = group ? [] : [oa];
  }

  const body = bodyOf(e);
  if (!body) return { kind: 'skip', reason: 'empty' };
  return {
    kind: 'signal',
    signal: {
      dataSourceId: ctx.dataSourceId,
      channel: 'line',
      from,
      ...(fromName ? { fromName } : {}),
      to,
      body,
      anchors: {
        ...(e.messageId ? { messageId: e.messageId } : {}),
        ...(e.quotedMessageId ? { quotedMessageId: e.quotedMessageId } : {}),
        conversationId: conversation,
        conversationGroup: group !== null,
      },
      sourceRef: `line:${e.id}`,
      occurredAt: e.occurredAt,
    },
  };
}

function bodyOf(e: LineEvent): string {
  if (e.type === 'postback') return `[ボタン] ${e.postbackData ?? ''}`.trim();
  const type = e.messageType ?? 'text';
  if (type === 'text') return (e.text ?? '').trim();
  if (type === 'file' && e.fileName) return `${MARKERS.file} ${e.fileName}`;
  return MARKERS[type] ?? `[${type}]`;
}

function address(value: string): AddressRef {
  return { channel: 'line', value };
}
