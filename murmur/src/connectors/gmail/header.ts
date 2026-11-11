// メールのヘッダー値の読み取り（純関数。0041）。アドレスの一覧（RFC 5322）と、符号化された語（RFC 2047）。

/**
 * アドレスの一覧（To・Cc・From の値）からアドレスの部分だけを順に取り出す。
 * `a@b.example`、`Name <a@b.example>`、`"Last, First" <a@b.example>`（引用符の中のカンマ）、カンマ区切りの複数、
 * コメント（括弧）、グループ（`名前: a@b, c@d;`。グループの名前は捨てて中のアドレスを取る）に対応する。読めないものは捨てる
 */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let bare = ''; // 引用符・括弧・山括弧の外の文字
  let angle: string | null = null; // 閉じた最初の山括弧の中
  let collecting: string | null = null; // 山括弧の中を読んでいる途中
  const flush = () => {
    const addr = (angle ?? bare.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/)?.[0] ?? '').trim();
    if (addr.includes('@') && !/\s/.test(addr)) out.push(addr);
    bare = '';
    angle = null;
    collecting = null;
  };
  // 閉じない ( " < が残りの一覧を飲み込まないよう、対応する閉じを先に見つける。閉じがなければ、その 1 文字を捨てて続ける。
  // どれも 1 回で読む（見つからなかった探索を繰り返さない）
  const parenEnd = matchParens(value);
  let noQuoteClose = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (collecting !== null) {
      if (c === '>') {
        angle ??= collecting;
        collecting = null;
        continue;
      }
      // 山括弧の中で別の区切りに当たったら、閉じていない < とみなして中身を山括弧の外の文字に戻す（読めるアドレスは bare から取る）
      if (c !== '<' && c !== '"' && c !== ',' && c !== ';') {
        collecting += c;
        continue;
      }
      bare += collecting;
      collecting = null;
    }
    if (c === '"') {
      let j = i + 1;
      if (!noQuoteClose) {
        while (j < value.length && value[j] !== '"') j += value[j] === '\\' ? 2 : 1;
        if (j >= value.length) noQuoteClose = true;
      }
      if (j < value.length && !noQuoteClose) i = j; // 引用符の中は捨てる
    } else if (c === '(') {
      const end = parenEnd.get(i);
      if (end !== undefined) i = end; // コメントは捨てる
    } else if (c === '<') collecting = '';
    else if (c === ',' || c === ';') flush();
    else if (c === ':') {
      // グループの名前の終わり（山括弧の外のコロン）: ここまでは名前なので捨てる
      bare = '';
    } else bare += c;
  }
  if (collecting !== null) bare += collecting;
  flush();
  return out;
}

/** ( に対応する ) の位置（入れ子・\\ の逃がしを読む）。対応する ) のない ( は含まない */
function matchParens(value: string): Map<number, number> {
  const ends = new Map<number, number>();
  if (!value.includes('(')) return ends;
  const stack: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') i++;
    else if (c === '(') stack.push(i);
    else if (c === ')' && stack.length > 0) ends.set(stack.pop()!, i);
  }
  return ends;
}

/** 折り返されたヘッダー値（改行 + 空白）を 1 行にする */
export function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}

/** 先頭の <...>（Message-ID・In-Reply-To）。山括弧がなく、空白のない 1 語なら山括弧で包む（Outlook の internetMessageId と同じ形にそろえる） */
export function messageIdOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = unfold(raw);
  const bracketed = v.match(/<[^<>\s]+>/)?.[0];
  if (bracketed) return bracketed;
  return v !== '' && !/\s/.test(v) && v.includes('@') ? `<${v}>` : undefined;
}

// ---- RFC 2047 の符号化された語 =?charset?B|Q?text?= ----

const WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** TextDecoder で読む。使えない文字コードなら null（呼び出し側が元のまま残す） */
export function decodeBytes(bytes: Uint8Array, charset: string): string | null {
  try {
    return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    return null;
  }
}

function qBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '_') bytes.push(0x20);
    else if (c === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

function bBytes(text: string): Uint8Array | null {
  try {
    // 使えない文字や、長さが合わない（4 で割って 1 余る）ものは壊れた語。空に読まず、呼び出し側が元のまま残す
    const b64 = text.replace(/\s+/g, '').replace(/=+$/, '');
    if (/[^A-Za-z0-9+/]/.test(b64) || b64.length % 4 === 1) return null;
    const bin = atob(b64);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * ヘッダー値の符号化された語を読む。符号化された語どうしの間の空白は捨てる（RFC 2047）。
 * 同じ文字コードで続く語は、バイト列をつないでから読む（文字の途中で語が切れていても読める）。
 * 文字コードが使えない・読めない語は、元の文のまま残す。符号化された語がなければそのまま返す
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  const matches = [...value.matchAll(WORD)];
  if (matches.length === 0) return value;
  let out = '';
  let pos = 0;
  let i = 0;
  while (i < matches.length) {
    // 空白だけを挟んで続く語を 1 つの塊にする
    let j = i;
    while (j + 1 < matches.length && value.slice(matches[j]!.index + matches[j]![0].length, matches[j + 1]!.index).trim() === '') j++;
    out += value.slice(pos, matches[i]!.index);
    // 塊の中を、同じ文字コードの連なりごとにバイト列をつないで読む。読めなかった連なりは元の文のまま残し、
    // その前後の空白も残す（読めた語どうしの間の空白だけを捨てる）
    let k = i;
    let prevFailed = false;
    while (k <= j) {
      const charset = charsetOf(matches[k]![1]!);
      let end = k;
      const parts: (Uint8Array | null)[] = [];
      while (end <= j && charsetOf(matches[end]![1]!) === charset) {
        const m = matches[end]!;
        parts.push(m[2]!.toUpperCase() === 'B' ? bBytes(m[3]!) : qBytes(m[3]!));
        end++;
      }
      const start = matches[k]!.index;
      const stop = matches[end - 1]!.index + matches[end - 1]![0].length;
      let decoded: string | null = null;
      if (parts.every((p): p is Uint8Array => p !== null)) {
        const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let off = 0;
        for (const p of parts) {
          joined.set(p, off);
          off += p.length;
        }
        decoded = decodeBytes(joined, charset);
      }
      if (k > i && (prevFailed || decoded === null)) out += value.slice(matches[k - 1]!.index + matches[k - 1]![0].length, start);
      out += decoded ?? value.slice(start, stop);
      prevFailed = decoded === null;
      k = end;
    }
    const last = matches[j]!;
    pos = last.index + last[0].length;
    i = j + 1;
  }
  return out + value.slice(pos);
}

/** RFC 2231 の言語の指定（utf-8*ja）を落とす */
function charsetOf(label: string): string {
  return label.split('*')[0]!.toLowerCase();
}
