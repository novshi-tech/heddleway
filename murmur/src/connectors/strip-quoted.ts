// 引用の履歴を落とす（純関数）。Outlook（uniqueBody が取れないとき）と Gmail（uniqueBody にあたるものがない。0041）が共有する。

/** 引用の見出しの次の行（空行を飛ばして）が > で始まるか */
function quotedNext(lines: string[], from: number): boolean {
  for (let j = from; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (t === '') continue;
    return t.startsWith('>');
  }
  return false;
}

/** メールの引用の見出し（誰がいつ書いたか）らしいか: アドレスらしい語（@ か <…>）か、時刻（10:00）がある */
function looksLikeAttribution(text: string): boolean {
  return /@|<[^<>]+>|\d{1,2}:\d{2}/.test(text);
}

/**
 * 引用の履歴を落とす。
 * Outlook の「From: / 差出人:」の見出し、「-----Original Message-----」、「On ... wrote:」「... 様 wrote:」、> の行から先を捨てる。
 * Gmail の見出し: 「On <日時> <名前> <アドレス> wrote:」（長いと次の行に折り返す）と、
 * 日本語の「2026年11月10日(火) 10:00 <名前> <アドレス>:」（次が > の行のときだけ。< で折り返すこともある）。
 * この Gmail 系の見出しは、下が引用（>）の行だけ（または > の行が 1 つもない）のときだけ、そこから先を捨てる。
 * 下に > の行が 1 つもないのに見出しで切るのは、見出しがメールの引用の見出しらしいとき（アドレスか時刻がある）だけ。
 * 「On Monday the client wrote:」「部長が書きました：」のような本文中の文は切らない。
 * 引用の間に答えを書いた返信（インライン返信。日本語のビジネスメールに多い）は、見出しで切らずに > の行だけを落として答えを残す
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // 各行から後ろに、> でない（空でない）行と > の行があるか。見出しごとに後ろを読み直さない（1 回で作る）
  const plainFrom: boolean[] = new Array<boolean>(lines.length + 1).fill(false);
  const quotedFrom: boolean[] = new Array<boolean>(lines.length + 1).fill(false);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    plainFrom[i] = plainFrom[i + 1]! || (t !== '' && !t.startsWith('>'));
    quotedFrom[i] = quotedFrom[i + 1]! || t.startsWith('>');
  }
  /**
   * 見出し（header）の下が引用だけか。下に何もなければ切る。引用の行（>）と答えが混ざるときは切らない。
   * 引用の印がまったくないときは、見出しがメールの引用の見出しらしいときだけ切る
   */
  const cutsAfter = (from: number, header: string) => !plainFrom[from] || (!quotedFrom[from] && looksLikeAttribution(header));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (/^-{2,}\s*(Original Message|元のメッセージ)\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t) && /^(From|差出人):/i.test(lines[i + 1]?.trim() ?? '')) break;
    if (/^(From|差出人):\s/i.test(t) && /^(Sent|送信日時|Date|日付):\s/i.test(lines[i + 1]?.trim() ?? '')) break;
    if ((/^On .+wrote:$/i.test(t) || /^\d{4}[/年].+(wrote|書きました)[:：]$/.test(t)) && cutsAfter(i + 1, t)) break;
    // Gmail は長い見出しを折り返す: 「On Tue, Nov 10, 2026 at 10:00 AM 山田 太郎 <」の次の行が「taro@example.com> wrote:」
    if (/^On\s/i.test(t) && !/wrote:$/i.test(t) && /wrote:$/i.test(lines[i + 1]?.trim() ?? '') && quotedNext(lines, i + 2) && cutsAfter(i + 2, `${t} ${lines[i + 1]!.trim()}`)) break;
    // 日本語の Gmail: 「2026年11月10日(火) 10:00 山田太郎 <taro@example.com>:」。引用の本文（>）が続くときだけ見出しと見る
    if (/^\d{4}年\d{1,2}月\d{1,2}日.*[:：]$/.test(t) && quotedNext(lines, i + 1) && cutsAfter(i + 1, t)) break;
    // 日本語の Gmail も < のところで折り返す: 「2026年11月10日(火) 10:00 山田 太郎 <」の次の行が「taro@example.com>:」
    if (/^\d{4}年\d{1,2}月\d{1,2}日.*<$/.test(t) && /^[^\s<>]*>[:：]$/.test(lines[i + 1]?.trim() ?? '') && quotedNext(lines, i + 2) && cutsAfter(i + 2, `${t} ${lines[i + 1]!.trim()}`)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}
