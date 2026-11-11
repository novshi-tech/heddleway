import type { AddressRef, InboundSignal } from '../../domain';
import { stripQuoted } from '../strip-quoted';
import type { GraphMessage } from './message';

// Graph の message → InboundSignal（純関数）。向きはコアが selfAddressIds で決めるので、ここでは決めない。
// sourceRef は internetMessageId（フォルダをまたいで同じ）。記録した送信の sent_ref（下書きの internetMessageId）とも一致する（H5）。

export type Normalized = { kind: 'signal'; signal: InboundSignal } | { kind: 'skip'; reason: string };

export function normalizeMessage(dataSourceId: string, msg: GraphMessage): Normalized {
  if (msg['@removed'] !== undefined) return { kind: 'skip', reason: 'removed' };
  if (msg.isDraft) return { kind: 'skip', reason: 'draft' };
  const messageId = msg.internetMessageId;
  if (!messageId) return { kind: 'skip', reason: 'no internetMessageId' };
  const from = address(msg.from ?? msg.sender);
  if (!from) return { kind: 'skip', reason: 'no sender' };

  const to = [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])].map(address).filter((a): a is AddressRef => a !== null);
  const inReplyTo = header(msg, 'In-Reply-To');
  const unique = msg.uniqueBody?.content;
  const body = (unique ?? stripQuoted(msg.body?.content ?? '')).trim();
  const occurredAt = msg.receivedDateTime ?? msg.sentDateTime;
  return {
    kind: 'signal',
    signal: {
      dataSourceId,
      channel: 'email',
      from,
      to,
      ...(msg.subject ? { subject: msg.subject } : {}),
      body,
      anchors: { messageId, ...(inReplyTo ? { inReplyTo } : {}) },
      sourceRef: `email:${messageId}`,
      ...(occurredAt ? { occurredAt } : {}),
    },
  };
}

function address(r: GraphMessage['from']): AddressRef | null {
  const value = r?.emailAddress?.address?.trim();
  return value ? { channel: 'email', value } : null;
}

/** In-Reply-To は 1 つの Message-ID（余分な空白や複数を書くメーラーもあるので、最初の <...> だけ取る） */
function header(msg: GraphMessage, name: string): string | undefined {
  const raw = msg.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  if (!raw) return undefined;
  return raw.match(/<[^>]+>/)?.[0] ?? raw.trim();
}
