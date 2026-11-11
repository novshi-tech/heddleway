import { decodeBytes } from './header';
import type { GmailPart } from './message';

// Gmail の本文の取り出し（純関数。0041）。MIME の部分をたどり、base64url を読み、HTML だけのメールはテキストにする。
// 引用の履歴は呼び出し側（normalize.ts）が stripQuoted で落とす

/** base64url（パディングなし・あり、改行まじりでも）をバイト列にする。読めなければ空 */
export function decodeBase64Url(data: string): Uint8Array {
  try {
    const std = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/** Content-Type ヘッダーの charset */
export function charsetOf(part: GmailPart): string | undefined {
  const ct = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value;
  return ct?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1];
}

/** 部分の本文を文字にする。文字コードは Content-Type の charset（TextDecoder。使えなければ UTF-8） */
export function partText(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = decodeBase64Url(data);
  const charset = charsetOf(part);
  return (charset ? decodeBytes(bytes, charset) : null) ?? new TextDecoder('utf-8').decode(bytes);
}

/** 本文として読む部分（添付のファイル名がなく、本文のデータがある）を深さ優先で探す。message/* の中（添付の転送メール）には入らない */
function find(part: GmailPart, mime: string): GmailPart | undefined {
  const type = (part.mimeType ?? '').toLowerCase();
  if (type === mime) return !part.filename && part.body?.data ? part : undefined;
  if (type.startsWith('message/')) return undefined;
  for (const child of part.parts ?? []) {
    const hit = find(child, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** 本文のテキスト。text/plain を優先し、なければ text/html をテキストにする。どちらもなければ空 */
export function bodyText(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain = find(payload, 'text/plain');
  if (plain) return partText(plain);
  const html = find(payload, 'text/html');
  return html ? htmlToText(partText(html)) : '';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', ndash: '–', mdash: '—', copy: '©', yen: '¥' };

function entity(whole: string, body: string): string {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[body.toLowerCase()] ?? whole;
}

/**
 * HTML をテキストにする。script・style・head・コメントを落とし、<br> とブロックの終わりを改行にして、タグを外し、
 * よく使う文字参照を読む（1 回で読むので &amp;lt; は &lt; のまま残る）
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|table|ul|ol|h[1-6]|blockquote|pre|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, entity);
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
