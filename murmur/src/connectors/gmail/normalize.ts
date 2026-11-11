import type { AddressRef } from '../../domain';
import type { Normalized } from '../graph/normalize';
import { stripQuoted } from '../strip-quoted';
import { bodyText } from './body';
import { decodeEncodedWords, messageIdOf, parseAddressList, unfold } from './header';
import type { GmailMessage } from './message';

// Gmail の message → InboundSignal（純関数。0041 の決定 2）。Outlook の normalizeMessage と同じ形の出力。
// 向きはコアが決める。sourceRef は Message-ID（山括弧つき。Outlook の internetMessageId と同じ形）なので、
// 記録した送信の sent_ref とも一致する（H5）。threadId・ラベル（取り込まないものを除く）・星・既読は使わない

/** 取り込まないラベル → スキップの理由 */
const SKIPPED_LABELS: Record<string, string> = { DRAFT: 'draft', SPAM: 'spam', TRASH: 'trash', CHAT: 'chat' };

/** 取り込むのは受信トレイか送信済みのメールだけ（Outlook の inbox・sentitems と同じ） */
const TAKEN_LABELS = ['INBOX', 'SENT'];

/** 取り込む本文の長さの上限（文字）。超えた分は切る */
export const MAX_BODY_CHARS = 100_000;

/** 取り込まないラベルが付いていれば、その理由 */
export function skippedLabel(labelIds: readonly string[] | undefined): string | null {
  for (const l of labelIds ?? []) if (SKIPPED_LABELS[l]) return SKIPPED_LABELS[l]!;
  return null;
}

export function normalizeGmailMessage(dataSourceId: string, msg: GmailMessage): Normalized {
  const label = skippedLabel(msg.labelIds);
  if (label) return { kind: 'skip', reason: label };
  // 履歴のレコードのラベルは届いた時点のもの。取ったメールのラベルで決める（フィルタでアーカイブされたものは INBOX がない）
  if (!(msg.labelIds ?? []).some((l) => TAKEN_LABELS.includes(l))) return { kind: 'skip', reason: 'not in inbox or sent' };
  const headers = msg.payload?.headers ?? [];
  const all = (name: string) => headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => unfold(h.value));
  const first = (name: string) => all(name)[0];

  const messageId = messageIdOf(first('Message-ID'));
  if (!messageId) return { kind: 'skip', reason: 'no Message-ID' };
  const fromValue = parseAddressList(first('From'))[0] ?? parseAddressList(first('Sender'))[0];
  if (!fromValue) return { kind: 'skip', reason: 'no sender' };

  const address = (value: string): AddressRef => ({ channel: 'email', value });
  const to = [...all('To'), ...all('Cc')].flatMap(parseAddressList).map(address);
  const inReplyTo = messageIdOf(first('In-Reply-To'));
  const subject = decodeEncodedWords(first('Subject') ?? '').trim();
  const body = capText(stripQuoted(bodyText(msg.payload)).trim(), MAX_BODY_CHARS);
  const occurredAt = occurred(msg.internalDate);
  return {
    kind: 'signal',
    signal: {
      dataSourceId,
      channel: 'email',
      from: address(fromValue),
      to,
      ...(subject ? { subject } : {}),
      body,
      anchors: { messageId, ...(inReplyTo ? { inReplyTo } : {}) },
      sourceRef: `email:${messageId}`,
      ...(occurredAt ? { occurredAt } : {}),
    },
  };
}

/** internalDate（エポックからのミリ秒の文字列）→ ISO 8601 */
function occurred(internalDate: string | undefined): string | undefined {
  if (!internalDate || !/^\d+$/.test(internalDate)) return undefined;
  const d = new Date(Number(internalDate));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 上限で切る。サロゲートペアの途中では切らない */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
