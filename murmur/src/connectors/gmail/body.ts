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

/** 本文の部分から読む大きさの上限（バイト・文字）。超えた分は切る（飛ばさない）。1 通の巨大なメールで見回りを止めない */
export const MAX_BODY_INPUT = 256 * 1024;

/** 部分の本文を文字にする。文字コードは Content-Type の charset（TextDecoder。使えなければ UTF-8）。読むのは先頭の MAX_BODY_INPUT まで */
export function partText(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = decodeBase64Url(data).subarray(0, MAX_BODY_INPUT);
  const charset = charsetOf(part);
  return ((charset ? decodeBytes(bytes, charset) : null) ?? new TextDecoder('utf-8').decode(bytes)).slice(0, MAX_BODY_INPUT);
}

/**
 * 本文として読む部分（添付のファイル名がなく、本文のデータがある）を深さ優先で探す。message/* の中（添付の転送メール）には入らない。
 * 同じ階層に並んだ部分（Apple Mail は text/plain をインライン画像の前後で分ける）は、最初に見つかったものが本文の部分なら
 * 同じ階層のものを順に全部返す。最初に見つかったのが入れ子の中なら、その中のものだけ（先頭の入れ子を本文とする）
 */
function find(part: GmailPart, mime: string): GmailPart[] {
  const type = (part.mimeType ?? '').toLowerCase();
  if (type === mime) return !part.filename && part.body?.data ? [part] : [];
  if (type.startsWith('message/')) return [];
  const siblings: GmailPart[] = [];
  for (const child of part.parts ?? []) {
    if ((child.mimeType ?? '').toLowerCase() === mime) {
      if (!child.filename && child.body?.data) siblings.push(child);
      continue;
    }
    if (siblings.length > 0) continue;
    const hit = find(child, mime);
    if (hit.length > 0) return hit;
  }
  return siblings;
}

/** 本文のテキスト。text/plain を優先し、なければ text/html をテキストにする。どちらもなければ空。読むのは先頭の MAX_BODY_INPUT まで */
export function bodyText(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain = find(payload, 'text/plain');
  if (plain.length > 0) return plain.map(partText).join('\n').slice(0, MAX_BODY_INPUT);
  const html = find(payload, 'text/html');
  return html.length > 0 ? htmlToText(partText(html[0]!)) : '';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', ndash: '–', mdash: '—', copy: '©', yen: '¥' };

function entity(whole: string, body: string): string {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[body.toLowerCase()] ?? whole;
}

/** 中身を読まずに捨てるタグ（閉じるタグまでを落とす） */
const DROPPED_BLOCKS = new Set(['script', 'style', 'head', 'title']);
/** 終わりに改行を置くタグ */
const BLOCK_ENDS = new Set(['p', 'div', 'li', 'tr', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article', 'header', 'footer']);

/** blockquote の始まりと終わりの目印（入力から取り除いてから読む）。htmlToText の中だけで使う */
const QUOTE_OPEN = '\u0001';
const QUOTE_CLOSE = '\u0002';
/** 引用の印（> ）を付ける深さの上限。入れ子が深くても行の長さを抑える */
const MAX_QUOTE_PREFIX_DEPTH = 8;

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

/**
 * HTML を 1 回だけ前から読んで、テキストと改行にする（長さに比例する。閉じないコメント・タグが並んでも読み直さない）。
 * 閉じるものが見つからないコメント・script・style・head・title・タグは、終わりまで捨てる。タグの形でない < は文字として残す
 */
function scanHtml(html: string): string {
  const n = html.length;
  // 長さを変えない小文字（閉じるタグの探索用。toLowerCase は文字によって長さが変わるので使わない）
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const out: string[] = [];
  // 引用符が閉じないと分かったら、以後は探さない（探して見つからなかった走査を繰り返さない）
  const noClose = { '"': false, "'": false };
  /** タグの終わり（> の位置）。属性値の引用符の中の > は飛ばす。閉じない引用符は文字として読む。なければ -1 */
  const tagEnd = (from: number): number => {
    for (let k = from; k < n; k++) {
      const c = html[k]!;
      if (c === '>') return k;
      if ((c === '"' || c === "'") && !noClose[c]) {
        let p = k - 1;
        while (p >= from && (html[p] === ' ' || html[p] === '\t' || html[p] === '\n' || html[p] === '\r')) p--;
        if (p >= from && html[p] === '=') {
          const close = html.indexOf(c, k + 1);
          if (close < 0) noClose[c] = true;
          else k = close;
        }
      }
    }
    return -1;
  };
  let i = 0;
  let textFrom = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const next = html.charCodeAt(lt + 1);
    const closing = next === 47; // /
    const startsTag = isLetter(next) || (closing && isLetter(html.charCodeAt(lt + 2))) || next === 33 || next === 63; // 名前・/名前・!・?
    if (!startsTag) {
      i = lt + 1;
      continue;
    }
    out.push(html.slice(textFrom, lt));
    if (next === 33 && lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return out.join('');
      i = textFrom = end + 3;
      continue;
    }
    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    if (next !== 33 && next !== 63) while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = lower.slice(nameStart, nameEnd);
    const end = next === 33 || next === 63 ? html.indexOf('>', lt + 2) : tagEnd(nameEnd);
    if (end < 0) return out.join('');
    i = textFrom = end + 1;
    if (!closing && DROPPED_BLOCKS.has(name)) {
      // 閉じるタグ（</name の次が名前の文字でないもの）まで捨てる。なければ終わりまで
      let from = i;
      for (;;) {
        const close = lower.indexOf(`</${name}`, from);
        if (close < 0) return out.join('');
        if (!isNameChar(lower.charCodeAt(close + name.length + 2))) {
          const gt = html.indexOf('>', close);
          if (gt < 0) return out.join('');
          i = textFrom = gt + 1;
          break;
        }
        from = close + 1;
      }
    } else if (name === 'blockquote') {
      // 引用の中の行に印を付けるための目印（htmlToText が行ごとの深さを読んで取り除く）。引用は行を改めて始め、閉じたら改める
      if (closing) out.push(QUOTE_CLOSE, '\n');
      else {
        let k = out.length - 1;
        while (k >= 0 && out[k] === '') k--;
        const prev = k >= 0 ? out[k] : undefined;
        if (prev !== undefined && !prev.endsWith('\n')) out.push('\n');
        out.push(QUOTE_OPEN);
      }
    } else if ((!closing && (name === 'br' || name === 'hr')) || (closing && BLOCK_ENDS.has(name))) out.push('\n');
    else if (closing && (name === 'td' || name === 'th')) out.push(' ');
  }
  out.push(html.slice(textFrom));
  return out.join('');
}

/**
 * HTML をテキストにする。script・style・head・title・コメントを落とし、<br> とブロックの終わりを改行にして、タグを外し、
 * よく使う文字参照を読む（1 回で読むので &amp;lt; は &lt; のまま残る）。読むのは先頭の MAX_BODY_INPUT まで。
 * <blockquote> の中の行は、深さの分だけ行頭に「> 」を付ける（テキストのメールの引用と同じ形にして、stripQuoted の規則に乗せる）
 */
export function htmlToText(html: string): string {
  const text = scanHtml(html.slice(0, MAX_BODY_INPUT).replace(/[\u0001\u0002]/g, '')).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, entity);
  let depth = 0;
  return text
    .split('\n')
    .map((raw): string | null => {
      // 行の最初の文字の深さが、その行の引用の深さ（目印は取り除き、行の途中の目印は次の行の深さに効く）
      let lead = depth;
      let line = raw;
      if (raw.includes(QUOTE_OPEN) || raw.includes(QUOTE_CLOSE)) {
        let seen = false;
        let clean = '';
        for (const ch of raw) {
          if (ch === QUOTE_OPEN) depth++;
          else if (ch === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
          else {
            if (!seen) lead = depth;
            seen = true;
            clean += ch;
          }
        }
        // 目印だけの行（引用の始まり・終わりに置いた改行）は行として残さない
        if (!seen) return null;
        line = clean;
      }
      const t = line.replace(/[ \t ]+/g, ' ').trim();
      return t === '' ? '' : `${'> '.repeat(Math.min(lead, MAX_QUOTE_PREFIX_DEPTH))}${t}`;
    })
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
