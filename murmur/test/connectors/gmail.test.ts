import { describe, expect, it } from 'vitest';
import { GatewayGmailApi, GmailError } from '../../src/connectors/gmail/api';
import { GoogleApiNotEnabled } from '../../src/connectors/google-error';
import { bodyText, charsetOf, decodeBase64Url, htmlToText, MAX_BODY_INPUT, partText } from '../../src/connectors/gmail/body';
import { decodeEncodedWords, messageIdOf, parseAddressList } from '../../src/connectors/gmail/header';
import { gmailMe } from '../../src/connectors/gmail/identity';
import { GmailMessage, type HistoryRecord } from '../../src/connectors/gmail/message';
import { MAX_BODY_CHARS, normalizeGmailMessage } from '../../src/connectors/gmail/normalize';
import { appendRecoveryIds, MAX_FETCH_PER_RUN, MAX_RECOVERY_IDS, nextFailure, planHistory, planPoll, planRecoveryChunk, recoveryAfter, RECOVERY_OVERLAP_MINUTES } from '../../src/connectors/gmail/plan';
import { GMAIL_SCOPE } from '../../src/connectors/gmail/scope';
import { normalizeMessage } from '../../src/connectors/graph/normalize';
import { GraphMessage } from '../../src/connectors/graph/message';
import type { SourceState } from '../../src/connectors/graph/state';
import { stripQuoted } from '../../src/connectors/strip-quoted';
import { GatewayAuthError, inScope, type UpstreamCall } from '../../src/ports/gateway';
import { b64url, gmailMessage, part } from '../helpers/fake-gmail';
import { mail } from '../helpers/fake-graph';

// Gmail の個人の箱の取り込み（0041）。純関数の部分。同期は gmail-sync.test.ts

const parse = (m: unknown) => GmailMessage.parse(m);
const signalOf = (m: unknown) => {
  const n = normalizeGmailMessage('ds_x', parse(m));
  if (n.kind !== 'signal') throw new Error(`skipped: ${n.reason}`);
  return n.signal;
};
const bytes = (...b: number[]) => Uint8Array.from(b);

describe('H5 Gmail のアドレスの一覧（RFC 5322）', () => {
  it('アドレスだけ・名前つき・引用符の中のカンマ・複数', () => {
    expect(parseAddressList('a@b.example')).toEqual(['a@b.example']);
    expect(parseAddressList('Name <a@b.example>')).toEqual(['a@b.example']);
    expect(parseAddressList('"Last, First" <a@b.example>')).toEqual(['a@b.example']);
    expect(parseAddressList('"Last, First" <a@b.example>, Other <c@d.example>,e@f.example')).toEqual(['a@b.example', 'c@d.example', 'e@f.example']);
    expect(parseAddressList('山田 太郎 <taro@example.co.jp>')).toEqual(['taro@example.co.jp']);
    expect(parseAddressList('=?UTF-8?B?55Sw5LitIOWkqumDjg==?= <tanaka@example.co.jp>')).toEqual(['tanaka@example.co.jp']);
  });

  it('引用符の中の < や @ に惑わされない。エスケープ・コメント・山括弧のあとの余りも読み飛ばす', () => {
    expect(parseAddressList('"a@fake.example <x>" <real@b.example>')).toEqual(['real@b.example']);
    expect(parseAddressList('"Say \\"hi\\", ok" <a@b.example>')).toEqual(['a@b.example']);
    expect(parseAddressList('a@b.example (Taro, the boss)')).toEqual(['a@b.example']);
    expect(parseAddressList('Taro <a@b.example> (comment, with comma), c@d.example')).toEqual(['a@b.example', 'c@d.example']);
  });

  it('グループは名前を捨てて中のアドレスを取る。空のグループ・読めないものは何も出さない', () => {
    expect(parseAddressList('Team: a@b.example, Dave <c@d.example>;')).toEqual(['a@b.example', 'c@d.example']);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('Team: ; z@y.example')).toEqual(['z@y.example']);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('not an address, <>, "x"')).toEqual([]);
  });

  it('Message-ID・In-Reply-To は先頭の <...>。山括弧のない 1 語は包む。折り返しと余分な空白は無視', () => {
    expect(messageIdOf('<a1@mail.example>')).toBe('<a1@mail.example>');
    expect(messageIdOf('  <a1@mail.example> <a0@mail.example> ')).toBe('<a1@mail.example>');
    expect(messageIdOf('\r\n <a1@mail.example>')).toBe('<a1@mail.example>');
    expect(messageIdOf('a1@mail.example')).toBe('<a1@mail.example>');
    expect(messageIdOf('なにか')).toBeUndefined();
    expect(messageIdOf('')).toBeUndefined();
    expect(messageIdOf(undefined)).toBeUndefined();
  });
});

describe('H5 Gmail のヘッダーの符号化された語（RFC 2047）', () => {
  const sample = '見積の依頼';
  const utf8b = btoa(String.fromCharCode(...new TextEncoder().encode(sample)));

  it('UTF-8 の B と Q を読む。符号化のない値はそのまま', () => {
    expect(decodeEncodedWords(`=?UTF-8?B?${utf8b}?=`)).toBe(sample);
    expect(decodeEncodedWords('=?UTF-8?Q?=E8=A6=8B=E7=A9=8D=E3=81=AE=E4=BE=9D=E9=A0=BC?=')).toBe(sample);
    expect(decodeEncodedWords('=?utf-8?q?Re:_=E8=A6=8B=E7=A9=8D?=')).toBe('Re: 見積');
    expect(decodeEncodedWords('Re: 普通の件名 = ? ok')).toBe('Re: 普通の件名 = ? ok');
    expect(decodeEncodedWords('')).toBe('');
  });

  it('語の間の空白は捨て、語の外の文字は残す。文字の途中で切れた語も、つないでから読む', () => {
    expect(decodeEncodedWords('Re: =?UTF-8?Q?=E8=A6=8B?= =?UTF-8?Q?=E7=A9=8D?= 御中')).toBe('Re: 見積 御中');
    expect(decodeEncodedWords('=?UTF-8?Q?=E8=A6?=\r\n =?UTF-8?Q?=8B?=')).toBe('見');
    expect(decodeEncodedWords('=?UTF-8?B?55Sw?= and =?UTF-8?B?5Lit?=')).toBe('田 and 中');
  });

  it('日本語の古い文字コード（ISO-2022-JP・Shift_JIS）を読む。RFC 2231 の言語指定つきも', () => {
    // ISO-2022-JP の「こん」
    const jis = btoa(String.fromCharCode(0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x1b, 0x28, 0x42));
    expect(decodeEncodedWords(`=?ISO-2022-JP?B?${jis}?=`)).toBe('こん');
    expect(decodeEncodedWords('=?Shift_JIS?Q?=82=B1=82=F1?=')).toBe('こん');
    expect(decodeEncodedWords(`=?UTF-8*ja?B?${utf8b}?=`)).toBe(sample);
  });

  it('使えない文字コード・読めない B は、その語を元のまま残す（ほかの語は読む）', () => {
    expect(decodeEncodedWords('=?x-no-such-charset?B?5Lit?=')).toBe('=?x-no-such-charset?B?5Lit?=');
    expect(decodeEncodedWords('Re: =?x-no-such-charset?Q?abc?= =?UTF-8?B?5Lit?=')).toBe('Re: =?x-no-such-charset?Q?abc?= 中');
  });
});

describe('H5 Gmail のヘッダーの壊れた入力', () => {
  it('壊れた base64 の語（使えない文字・長さが合わない）は、空に読まず元のまま残す。ほかの語は読む', () => {
    expect(decodeEncodedWords('=?UTF-8?B?!!!?=')).toBe('=?UTF-8?B?!!!?=');
    expect(decodeEncodedWords('=?UTF-8?B?5?=')).toBe('=?UTF-8?B?5?=');
    expect(decodeEncodedWords('Re: =?UTF-8?B?!!!?= と =?UTF-8?B?5LuK5pel?=')).toBe('Re: =?UTF-8?B?!!!?= と 今日');
    // 空の語は空のまま（壊れてはいない）
    expect(decodeEncodedWords('a=?UTF-8?B??=b')).toBe('ab');
  });

  it('閉じていない < や " が、残りの一覧を飲み込まない（読める分は取る。投げない・止まらない）', () => {
    expect(parseAddressList('Taro <taro@ex.com, b@c.com')).toEqual(['taro@ex.com', 'b@c.com']);
    expect(parseAddressList('"Taro <taro@ex.com>, b@c.com')).toEqual(['taro@ex.com', 'b@c.com']);
    expect(parseAddressList('Taro (memo, b@c.com')).toEqual(['b@c.com']);
    // 閉じていても今までどおり
    expect(parseAddressList('"Last, First" <a@b.example>, c@d.example')).toEqual(['a@b.example', 'c@d.example']);
    // 長い・壊れた入力でも長さに比例する
    const started = Date.now();
    expect(parseAddressList('<'.repeat(200_000))).toEqual([]);
    expect(parseAddressList('"<'.repeat(100_000) + 'x@y.example')).toEqual(['x@y.example']);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('H5 Gmail の本文（MIME・base64url・文字コード）', () => {
  it('base64url をパディングなしでも・あっても・改行まじりでも読む。日本語（UTF-8）を壊さない', () => {
    const text = 'ご確認ください。見積は ¥1,000 です 🙂';
    const data = b64url(text);
    expect(data).not.toContain('=');
    expect(new TextDecoder().decode(decodeBase64Url(data))).toBe(text);
    expect(new TextDecoder().decode(decodeBase64Url(`${data}==`))).toBe(text);
    expect(new TextDecoder().decode(decodeBase64Url(`${data.slice(0, 8)}\r\n${data.slice(8)}`))).toBe(text);
    expect(decodeBase64Url('***')).toEqual(new Uint8Array());
    // + と / の位置（- と _ に置き換わる文字）を通す
    const raw = bytes(0xfb, 0xff, 0xfe, 0xfa);
    expect(decodeBase64Url(b64url(raw))).toEqual(raw);
  });

  it('text/plain を優先する（text/html が先にあっても）', () => {
    const payload = part('multipart/alternative', null, { parts: [part('text/html', '<p>HTML 版</p>'), part('text/plain', 'テキスト版')] });
    expect(bodyText(payload)).toBe('テキスト版');
  });

  it('HTML だけなら、script・style を落とし、改行とエンティティを読んでテキストにする', () => {
    const html = '<html><head><title>題</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>お世話になっております。</p><div>1行目<br>2行目</div><p>A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x3042; &nbsp;f</p><ul><li>一</li><li>二</li></ul></body></html>';
    expect(bodyText(part('text/html', html))).toBe('お世話になっております。\n1行目\n2行目\nA & B <c> "d" \'e\' あ f\n一\n二');
    expect(htmlToText('&amp;lt; &unknown; &#0; &#xD800;')).toBe('&lt; &unknown; &#0; &#xD800;');
  });

  it('<title> の文字は落とす。属性値の引用符の中の > でタグを終わらせず、断片を本文に漏らさない', () => {
    expect(htmlToText('<html><head><title>題</title></head><body><title>これも</title>本文</body></html>')).toBe('本文');
    expect(htmlToText('<a title="x>y">t</a>')).toBe('t');
    expect(htmlToText("<a title='x>y' href=\"u>v\">t</a>後")).toBe('t後');
    // 引用符が閉じていなければ、最初の > で終わる
    expect(htmlToText('<a title="x>y</a>後')).toBe('y後');
    // タグでない < は文字として残す
    expect(htmlToText('a < b and 3<4 <3 &lt; c')).toBe('a < b and 3<4 <3 < c');
    // doctype・処理命令・コメント
    expect(htmlToText('<!DOCTYPE html><?xml version="1.0"?><!-- c -->本文<!-- 閉じない')).toBe('本文');
  });

  it('同じ階層に text/plain が並んでいたら、順に改行でつなぐ（Apple Mail はインライン画像の前後で分ける）。入れ子の先頭の text/plain だけのときは今までどおり', () => {
    const split = part('multipart/mixed', null, {
      parts: [part('text/plain', '前半'), part('image/jpeg', null, { filename: 'a.jpg' }), part('text/plain', '後半')],
    });
    expect(bodyText(split)).toBe('前半\n後半');
    // 添付（ファイル名あり）の text/plain は混ぜない
    expect(bodyText(part('multipart/mixed', null, { parts: [part('text/plain', '本文'), part('text/plain', 'メモ', { filename: 'm.txt' }), part('text/plain', '続き')] }))).toBe('本文\n続き');
    expect(bodyText(part('multipart/mixed', null, { parts: [part('multipart/alternative', null, { parts: [part('text/plain', '入れ子')] }), part('text/plain', '後ろ')] }))).toBe('入れ子');
  });

  describe('1 通で見回りが止まらない（変換の前に切り、1 回で読む）', () => {
    const fast = (name: string, input: string, check: (out: string) => void) => {
      const started = performance.now();
      const out = htmlToText(input);
      const ms = performance.now() - started;
      console.info(`htmlToText ${name}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(1000);
      check(out);
    };

    it('閉じていないコメント・script・< を並べた入力（400 KB・350 KB・50 KB）も 1 秒以内。閉じていないものは終わりまで捨てる', () => {
      fast('<!-- x100000', '<!--'.repeat(100_000), (out) => expect(out).toBe(''));
      fast('<script x50000', '<script'.repeat(50_000), (out) => expect(out).toBe(''));
      fast('< x50000', '<'.repeat(50_000), (out) => expect(out).toBe('<'.repeat(50_000)));
      // ほかの形でも同じ
      fast('<style x', '本文<style>'.repeat(50_000), (out) => expect(out).toBe('本文'));
      fast('<a x=" x', '<a x="'.repeat(60_000), (out) => expect(out).toBe(''));
      fast('<b> unclosed x', '<b '.repeat(80_000), (out) => expect(out).toBe(''));
      fast('<head x', '<head>'.repeat(50_000) + '本文', (out) => expect(out).toBe(''));
      fast('<p>x', '<p>あ</p>'.repeat(25_000), (out) => expect(out.split('\n')).toHaveLength(25_000));
    });

    it('本文の部分は先頭の MAX_BODY_INPUT（256 KB）までしか読まない（plain も HTML も。切るだけで飛ばさない）', () => {
      const big = 'a'.repeat(MAX_BODY_INPUT + 5000);
      expect(partText(part('text/plain', big))).toHaveLength(MAX_BODY_INPUT);
      expect(bodyText(part('text/plain', big))).toHaveLength(MAX_BODY_INPUT);
      expect(bodyText(part('text/html', `<p>${big}</p>`)).startsWith('aaaa')).toBe(true);
      expect(bodyText(part('text/html', `<p>${big}</p>`))).toHaveLength(MAX_BODY_INPUT - 3);
      // 並んだ plain の合計も切る
      const two = part('multipart/mixed', null, { parts: [part('text/plain', big), part('text/plain', big)] });
      expect(bodyText(two)).toHaveLength(MAX_BODY_INPUT);
      // 取り込むのは先頭。HTML の変換も、切った先頭だけ
      expect(htmlToText('先頭' + 'x'.repeat(MAX_BODY_INPUT) + '<script>')).toHaveLength(MAX_BODY_INPUT);
    });
  });

  it('multipart/mixed の中の multipart/alternative と添付: 入れ子の text/plain を取り、添付（ファイル名あり）は本文にしない', () => {
    const payload = part('multipart/mixed', null, {
      parts: [
        part('text/plain', '添付のメモ', { filename: 'memo.txt' }),
        part('multipart/alternative', null, { parts: [part('text/plain', '本文です'), part('text/html', '<b>本文です</b>')] }),
        part('application/pdf', null, { filename: 'a.pdf' }),
      ],
    });
    expect(bodyText(payload)).toBe('本文です');
    // 添付しかなければ本文は空。添付の転送メール（message/rfc822）の中は本文にしない
    expect(bodyText(part('multipart/mixed', null, { parts: [part('text/plain', 'x', { filename: 'a.txt' })] }))).toBe('');
    expect(bodyText(part('multipart/mixed', null, { parts: [part('message/rfc822', null, { parts: [part('text/plain', '転送された本文')] })] }))).toBe('');
    expect(bodyText(undefined)).toBe('');
  });

  it('html だけが添付でなく本文にあり、plain が添付のときは html を使う', () => {
    const payload = part('multipart/mixed', null, { parts: [part('text/plain', '添付', { filename: 'a.txt' }), part('text/html', '<p>こちら</p>')] });
    expect(bodyText(payload)).toBe('こちら');
  });

  it('Content-Type の charset で読む（Shift_JIS・ISO-2022-JP・UTF-8）。使えない・ないときは UTF-8', () => {
    // 「こんにちは」
    const sjis = bytes(0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd);
    expect(bodyText(part('text/plain', null, { charset: 'Shift_JIS', bytes: sjis }))).toBe('こんにちは');
    const jis = bytes(0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x1b, 0x28, 0x42);
    expect(bodyText(part('text/plain', null, { charset: 'iso-2022-jp', bytes: jis }))).toBe('こん');
    expect(bodyText(part('text/plain', 'こんにちは', { charset: 'x-no-such-charset' }))).toBe('こんにちは');
    expect(bodyText(part('text/plain', 'こんにちは'))).toBe('こんにちは');
    expect(charsetOf({ headers: [{ name: 'content-type', value: 'text/plain; format=flowed; charset="UTF-8"' }] })).toBe('UTF-8');
    expect(charsetOf({ headers: [] })).toBeUndefined();
  });
});

describe('H5 引用の履歴の除去（Outlook と共有）', () => {
  it('Outlook の見出し・> の行は今までどおり落とす', () => {
    expect(stripQuoted('了解です\nOn Mon, Oct 27, 2026 at 9:00 Carol wrote:\n> 前')).toBe('了解です');
    expect(stripQuoted('a\n> 引用\nb')).toBe('a\nb');
    expect(stripQuoted('ありがとうございます。\n\n________________________________\n差出人: 鈴木\n送信日時: 2026年10月29日\n件名: 見積\n\n前')).toBe('ありがとうございます。\n');
  });

  it('Gmail の英語の見出し（折り返しも）と、日本語の見出しを、引用の行と一緒に落とす', () => {
    expect(stripQuoted('承知しました。\r\n\r\nOn Tue, Nov 10, 2026 at 10:00 AM Taro Yamada <taro@example.com> wrote:\r\n\r\n> 見積をお願いします')).toBe('承知しました。\n');
    expect(stripQuoted('承知しました。\n\nOn Tue, Nov 10, 2026 at 10:00 AM 山田 太郎 <\ntaro@example.com> wrote:\n\n> 見積をお願いします')).toBe('承知しました。\n');
    expect(stripQuoted('承知しました。\n\n2026年11月10日(火) 10:00 山田太郎 <taro@example.com>:\n\n> 見積をお願いします\n> お願いします')).toBe('承知しました。\n');
    expect(stripQuoted('承知しました。\n2026年11月10日(火) 10:00 山田太郎 <taro@example.com>:\n> 見積')).toBe('承知しました。');
  });

  it('引用の間に答えを書いた返信（インライン返信）は、見出しで切らない。> の行だけ落とす', () => {
    const inline = stripQuoted('ご質問への回答です。\n\n2026年11月10日のお問い合わせ:\n> 納期はいつですか\n12月1日です。\n> 価格は?\n10万円です。');
    expect(inline).toContain('ご質問への回答です。');
    expect(inline).toContain('12月1日です。');
    expect(inline).toContain('10万円です。');
    expect(inline).not.toContain('>');
    expect(inline).not.toContain('納期はいつですか');
    // 英語の折り返した見出しの形でも、あとの答えは残す
    expect(stripQuoted('Hi,\nOn Monday we will meet; as Bob\nwrote:\n> agenda\nSee you.')).toContain('See you.');
    // 1 行の On ... wrote: でも、> の間の答えは残す
    const english = stripQuoted('Hi\nOn Tue, Nov 10, 2026 at 10:00 AM Taro <taro@example.com> wrote:\n> Q1?\nA1.\n> Q2?\nA2.');
    expect(english).toContain('A1.');
    expect(english).toContain('A2.');
    expect(english).not.toContain('Q1');
    // 日本語の日時の見出しの 1 行（書きました）も同じ
    expect(stripQuoted('了解。\n2026/11/10 10:00 山田が書きました:\n> 質問\n回答です')).toContain('回答です');
  });

  it('日本語の Gmail の見出しが < のところで折り返されても、下に引用だけが続くなら切る。答えが混ざるなら切らない', () => {
    expect(stripQuoted('承知しました。\n\n2026年11月10日(火) 10:00 山田 太郎 <\ntaro@example.com>:\n\n> 見積をお願いします\n> お願いします')).toBe('承知しました。\n');
    const mixed = stripQuoted('承知しました。\n2026年11月10日(火) 10:00 山田 太郎 <\ntaro@example.com>:\n> 見積は?\n10万円です。');
    expect(mixed).toContain('10万円です。');
    expect(mixed).not.toContain('見積は?');
  });

  it('下に引用だけが続く普通の Gmail の返信は、今までどおり見出しから切る（空行・最後の空行まで）', () => {
    expect(stripQuoted('承知しました。\n\nOn Tue, Nov 10, 2026 at 10:00 AM Taro <taro@example.com> wrote:\n\n> a\n>\n> b\n\n')).toBe('承知しました。\n');
    expect(stripQuoted('承知しました。\n\n2026年11月10日のお問い合わせ:\n> a\n\n> b')).toBe('承知しました。\n');
    expect(stripQuoted('了解\nOn Tue Taro wrote:\n前の本文（> なしの引用）\nもう 1 行')).toBe('了解');
  });

  it('引用の行が続かない日付の行は本文として残す（誤って切らない）', () => {
    expect(stripQuoted('締め切りです。\n2026年11月10日(火) 10:00 までに <お願いします>:\n以上')).toBe('締め切りです。\n2026年11月10日(火) 10:00 までに <お願いします>:\n以上');
    expect(stripQuoted('On the other hand, wrote: nothing\n続き')).toBe('On the other hand, wrote: nothing\n続き');
  });
});

describe('H5 Gmail の message の正規化', () => {
  it('sourceRef とアンカーは Message-ID（山括弧つき）、In-Reply-To は最初の <...>、宛先は To と Cc、日時は internalDate', () => {
    const s = signalOf(
      gmailMessage({
        from: 'Carol <carol@example.com>',
        to: 'bob@gws.example, "Dave, D." <dave@example.com>',
        cc: 'Eve <eve@example.com>',
        subject: '見積のお願い',
        body: 'お願いします',
        at: '2026-11-10T01:00:00.000Z',
        mid: '<c1@example.com>',
        inReplyTo: ' <b0@gws.example> <older@x>',
      }),
    );
    expect(s).toEqual({
      dataSourceId: 'ds_x',
      channel: 'email',
      from: { channel: 'email', value: 'carol@example.com' },
      to: [{ channel: 'email', value: 'bob@gws.example' }, { channel: 'email', value: 'dave@example.com' }, { channel: 'email', value: 'eve@example.com' }],
      subject: '見積のお願い',
      body: 'お願いします',
      anchors: { messageId: '<c1@example.com>', inReplyTo: '<b0@gws.example>' },
      sourceRef: 'email:<c1@example.com>',
      occurredAt: '2026-11-10T01:00:00.000Z',
    });
  });

  it('ヘッダー名の大文字小文字（Message-Id）を問わず、件名の符号化された語を読み、折り返しを 1 行にする', () => {
    const m = gmailMessage({ from: 'a@b.example', at: '2026-11-10T01:00:00.000Z', mid: null, subject: '=?UTF-8?B?5LuK5pel?=' });
    m.payload.headers.push({ name: 'Message-Id', value: '<lower@mail.example>' }, { name: 'IN-REPLY-TO', value: '\r\n <r@mail.example>' });
    const s = signalOf(m);
    expect(s).toMatchObject({ subject: '今日', sourceRef: 'email:<lower@mail.example>', anchors: { messageId: '<lower@mail.example>', inReplyTo: '<r@mail.example>' } });
  });

  it('H5 同じメッセージを Outlook が見ても Gmail が見ても、sourceRef・アンカー・宛先・本文・件名が同じ（記録した送信や別経路の写しと 1 つになる）', () => {
    const at = '2026-11-10T01:00:00.000Z';
    const g = signalOf(gmailMessage({ from: 'carol@example.com', to: 'bob@gws.example', cc: 'dave@example.com', subject: '見積', body: '本文です', at, mid: '<same@example.com>', inReplyTo: '<b0@gws.example>' }));
    const o = normalizeMessage('ds_x', GraphMessage.parse({
      ...mail({ from: 'carol@example.com', to: ['bob@gws.example'], subject: '見積', body: '本文です', at, mid: '<same@example.com>' }),
      ccRecipients: [{ emailAddress: { address: 'dave@example.com' } }],
      internetMessageHeaders: [{ name: 'In-Reply-To', value: '<b0@gws.example>' }],
    }));
    if (o.kind !== 'signal') throw new Error('outlook skipped');
    expect({ ...g, occurredAt: undefined }).toEqual({ ...o.signal, occurredAt: undefined });
  });

  it('引用の履歴を落とす（plain も html も）。Gmail 流の見出しで切る', () => {
    const plain = signalOf(gmailMessage({ from: 'a@b.example', at: '2026-11-10T01:00:00.000Z', body: '承知しました。\r\n\r\nOn Mon, Nov 9, 2026 at 9:00 AM Carol <carol@example.com> wrote:\r\n> 前の本文\r\n> 続き' }));
    expect(plain.body).toBe('承知しました。');
    const html = signalOf(gmailMessage({ from: 'a@b.example', at: '2026-11-10T01:00:00.000Z', html: '<div>承知しました。</div><br><div class="gmail_quote"><div>On Mon, Nov 9, 2026 at 9:00 AM Carol &lt;<a href="mailto:c@x">carol@example.com</a>&gt; wrote:<br></div><blockquote>前の本文</blockquote></div>' }));
    expect(html.body).toBe('承知しました。');
  });

  it('スキップ: 下書き・迷惑メール・ゴミ箱・チャット（理由つき）。Message-ID がない・送信者が読めない', () => {
    const at = '2026-11-10T01:00:00.000Z';
    const skip = (m: unknown) => normalizeGmailMessage('d', parse(m));
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['DRAFT'] }))).toEqual({ kind: 'skip', reason: 'draft' });
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['INBOX', 'SPAM'] }))).toEqual({ kind: 'skip', reason: 'spam' });
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['TRASH'] }))).toEqual({ kind: 'skip', reason: 'trash' });
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['CHAT'] }))).toEqual({ kind: 'skip', reason: 'chat' });
    expect(skip(gmailMessage({ from: 'a@b.example', at, mid: null }))).toEqual({ kind: 'skip', reason: 'no Message-ID' });
    expect(skip(gmailMessage({ from: 'undisclosed-recipients:;', at }))).toEqual({ kind: 'skip', reason: 'no sender' });
    expect(skip(gmailMessage({ from: '(誰か)', at }))).toEqual({ kind: 'skip', reason: 'no sender' });
    // 星・重要・既読のラベルや threadId は使わない（取り込む）
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['INBOX', 'STARRED', 'IMPORTANT', 'UNREAD', 'SENT'] })).kind).toBe('signal');
  });

  it('受信トレイか送信済みにあるメールだけ取る（Outlook の inbox・sentitems と同じ）。フィルタでアーカイブされたもの（INBOX がない）は理由つきで飛ばす', () => {
    const at = '2026-11-10T01:00:00.000Z';
    const skip = (m: unknown) => normalizeGmailMessage('d', parse(m));
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['CATEGORY_UPDATES', 'UNREAD'] }))).toEqual({ kind: 'skip', reason: 'not in inbox or sent' });
    expect(skip({ ...gmailMessage({ from: 'a@b.example', at }), labelIds: undefined })).toEqual({ kind: 'skip', reason: 'not in inbox or sent' });
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['SENT'] })).kind).toBe('signal');
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['INBOX', 'CATEGORY_PROMOTIONS', 'IMPORTANT'] })).kind).toBe('signal');
    // 取らないラベルが先（下書きは SENT でなくても理由は draft）
    expect(skip(gmailMessage({ from: 'a@b.example', at, labels: ['DRAFT', 'SENT'] }))).toEqual({ kind: 'skip', reason: 'draft' });
  });

  it('本文は MAX_BODY_CHARS（10 万文字）で切る（サロゲートペアの途中では切らない）', () => {
    const at = '2026-11-10T01:00:00.000Z';
    expect(signalOf(gmailMessage({ from: 'a@b.example', at, body: 'a'.repeat(MAX_BODY_CHARS + 10) })).body).toHaveLength(MAX_BODY_CHARS);
    expect(signalOf(gmailMessage({ from: 'a@b.example', at, body: '短い' })).body).toBe('短い');
    const emoji = signalOf(gmailMessage({ from: 'a@b.example', at, body: 'a'.repeat(MAX_BODY_CHARS - 1) + '🙂🙂' })).body;
    expect(emoji).toHaveLength(MAX_BODY_CHARS - 1);
  });

  it('From がなければ Sender を使う。本文も件名もないメールは空の本文で取り込む', () => {
    const m = gmailMessage({ from: 'x@y.example', at: '2026-11-10T01:00:00.000Z', html: '' });
    m.payload.headers = m.payload.headers.filter((h) => h.name !== 'From' && h.name !== 'Subject').concat({ name: 'Sender', value: 'sender@y.example' });
    expect(signalOf(m)).toMatchObject({ from: { value: 'sender@y.example' }, body: '' });
    expect(signalOf(m)).not.toHaveProperty('subject');
  });

  it('internalDate が読めなければ occurredAt は付けない', () => {
    const m = gmailMessage({ from: 'a@b.example', at: '2026-11-10T01:00:00.000Z' });
    expect(signalOf({ ...m, internalDate: 'xx' })).not.toHaveProperty('occurredAt');
    expect(signalOf({ ...m, internalDate: undefined })).not.toHaveProperty('occurredAt');
  });
});

describe('H5 つないだメールボックスの本人（profile と sendAs）', () => {
  it('本人のアドレスは主のアドレス（profile）だけ。sendAs の別名（確認済みでも、グループや外部の共有のアドレスでも）は入れない。表示名は主の sendAs から', () => {
    const me = gmailMe({ emailAddress: 'bob@gws.example' }, [
      { sendAsEmail: 'Bob@gws.example', displayName: 'Bob Tanaka', isPrimary: true },
      { sendAsEmail: 'sales@gws.example', verificationStatus: 'accepted' },
      { sendAsEmail: 'pending@gws.example', verificationStatus: 'pending' },
      { sendAsEmail: 'other@elsewhere.example' },
    ]);
    expect(me).toEqual({ addresses: ['bob@gws.example'], displayName: 'Bob Tanaka' });
  });

  it('sendAs がなくても profile のアドレスは使える。表示名がなければ空', () => {
    expect(gmailMe({ emailAddress: ' bob@gws.example ' }, [])).toEqual({ addresses: ['bob@gws.example'], displayName: '' });
    expect(gmailMe({ emailAddress: 'bob@gws.example' }, [{ sendAsEmail: 'bob@gws.example', isPrimary: true, displayName: '  ' }]).displayName).toBe('');
    expect(gmailMe({ emailAddress: 'not-an-address' }, []).addresses).toEqual([]);
  });
});

describe('H5 履歴の計画（純関数。cursor は未処理の履歴を飛ばして進めない）', () => {
  const rec = (id: number, ...added: (string | [string, string[]])[]): HistoryRecord => ({
    id: String(id),
    messagesAdded: added.map((a) => ({ message: { id: typeof a === 'string' ? a : a[0], labelIds: typeof a === 'string' ? ['INBOX'] : a[1] } })),
  });
  const page = (records: HistoryRecord[], historyId: string, nextPageToken?: string) => ({ ...(records.length > 0 ? { history: records } : {}), historyId, ...(nextPageToken ? { nextPageToken } : {}) });

  it('全部処理したら、最後のページの historyId（箱の最新）まで進める。複数ページでも同じ', () => {
    const pages = [page([rec(11, 'a'), rec(12, 'b')], '20', 'next'), page([rec(13, 'c')], '20')];
    expect(planHistory({ cursor: '10', pages, exhausted: true })).toMatchObject({ fetch: ['a', 'b', 'c'], nextCursor: '20', complete: true });
  });

  it('履歴が空（history なし）でも、historyId まで進める（cursor が古くなって切れるのを避ける）', () => {
    expect(planHistory({ cursor: '10', pages: [page([], '15')], exhausted: true })).toMatchObject({ fetch: [], nextCursor: '15', complete: true });
    // メッセージを足さないレコード（messagesAdded なし）だけでも同じ
    expect(planHistory({ cursor: '10', pages: [page([{ id: '11' }], '15')], exhausted: true })).toMatchObject({ fetch: [], nextCursor: '15', complete: true });
  });

  it('上限に達したら、最後に処理し終えたレコードの id で止める（そのレコードの分は全部入る・次のレコードは入らない）', () => {
    const pages = [page([rec(11, 'a', 'b'), rec(12, 'c'), rec(13, 'd', 'e'), rec(14, 'f')], '99')];
    expect(planHistory({ cursor: '10', pages, exhausted: true, maxFetch: 3 })).toMatchObject({ fetch: ['a', 'b', 'c'], nextCursor: '12', complete: false });
    expect(planHistory({ cursor: '10', pages, exhausted: true, maxFetch: 5 })).toMatchObject({ fetch: ['a', 'b', 'c', 'd', 'e'], nextCursor: '13', complete: false });
    expect(planHistory({ cursor: '10', pages, exhausted: true, maxFetch: 6 })).toMatchObject({ fetch: ['a', 'b', 'c', 'd', 'e', 'f'], nextCursor: '99', complete: true });
  });

  it('先頭のレコード 1 つが上限より多くても、そのレコードは取って進む（進まなくなるのを避ける）', () => {
    const pages = [page([rec(11, 'a', 'b', 'c'), rec(12, 'd')], '99')];
    expect(planHistory({ cursor: '10', pages, exhausted: true, maxFetch: 2 })).toMatchObject({ fetch: ['a', 'b', 'c'], nextCursor: '11', complete: false });
  });

  it('続きのページがあるのに打ち切ったら、historyId ではなく最後のレコードの id まで（historyId は箱の最新なので、飛ばしてしまう）', () => {
    const pages = [page([rec(11, 'a'), rec(12, 'b')], '99', 'more')];
    expect(planHistory({ cursor: '10', pages, exhausted: false })).toMatchObject({ fetch: ['a', 'b'], nextCursor: '12', complete: false });
  });

  it('同じメッセージは 1 回（レコードをまたいでも）。取り込まないラベル（DRAFT・SPAM・TRASH・CHAT）は取らない', () => {
    const pages = [
      page([rec(11, 'a', 'a', ['d', ['DRAFT']]), rec(12, 'a', ['s', ['INBOX', 'SPAM']]), rec(13, ['t', ['TRASH']], ['c', ['CHAT']], 'b')], '20'),
    ];
    expect(planHistory({ cursor: '10', pages, exhausted: true })).toMatchObject({ fetch: ['a', 'b'], nextCursor: '20', complete: true });
    // 最初に見たときに下書きでも、あとのレコードで下書きでなくなっていれば取る
    expect(planHistory({ cursor: '10', pages: [page([rec(11, ['x', ['DRAFT']]), rec(12, ['x', ['SENT']])], '20')], exhausted: true }).fetch).toEqual(['x']);
  });

  it('上限は取るものの数で数える（落としたものは数えない）', () => {
    const records = [rec(11, ['d', ['DRAFT']]), rec(12, 'a'), rec(13, ['s', ['SPAM']]), rec(14, 'b')];
    expect(planHistory({ cursor: '10', pages: [page(records, '99')], exhausted: true, maxFetch: 1 })).toMatchObject({ fetch: ['a'], nextCursor: '13', complete: false });
  });

  it('cursor と同じ id のレコードは処理済みとして飛ばす（startHistoryId を含めて返す場合でも、同じレコードで止まり続けない）', () => {
    const pages = [page([rec(10, 'a', 'b', 'c'), rec(11, 'd')], '99')];
    expect(planHistory({ cursor: '10', pages, exhausted: true, maxFetch: 1 })).toMatchObject({ fetch: ['d'], nextCursor: '99', complete: true });
  });

  it('レコードごとの取る ID も返す（取るものがないレコードも入る。重複・落としたものは入らない）。取り込みの途中で位置を書くための切れ目', () => {
    const pages = [page([rec(11, 'a', 'b'), { id: '12' }, rec(13, 'a', ['d', ['DRAFT']], 'c')], '20')];
    expect(planHistory({ cursor: '10', pages, exhausted: true }).records).toEqual([
      { id: '11', ids: ['a', 'b'] },
      { id: '12', ids: [] },
      { id: '13', ids: ['c'] },
    ]);
  });

  it('1 回の見回りの上限は 50 通', () => {
    expect(MAX_FETCH_PER_RUN).toBe(50);
  });
});

describe('H5 拾い直しと失敗の計画（純関数）', () => {
  it('拾い直しの取り込みは古い方（検索の ID 配列の末尾）から。残りは新しい順のまま', () => {
    expect(planRecoveryChunk(['n3', 'n2', 'n1', 'o2', 'o1'], 2)).toEqual({ chunk: ['o1', 'o2'], remaining: ['n3', 'n2', 'n1'] });
    expect(planRecoveryChunk(['a', 'b'], 5)).toEqual({ chunk: ['b', 'a'], remaining: [] });
    expect(planRecoveryChunk([], 5)).toEqual({ chunk: [], remaining: [] });
  });

  it('集める ID は重ねない。上限を超えたら新しい方（先に来た方）だけ残して truncated', () => {
    expect(appendRecoveryIds(['a', 'b'], ['b', 'c'])).toEqual({ ids: ['a', 'b', 'c'], truncated: false });
    expect(appendRecoveryIds(['a', 'b'], ['c', 'd'], 3)).toEqual({ ids: ['a', 'b', 'c'], truncated: true });
    expect(MAX_RECOVERY_IDS).toBe(2000);
  });

  it('失敗の回数: 同じ ID が続けば加算、違う ID なら 1 から。3 回目で飛ばす', () => {
    expect(nextFailure(null, 'x')).toEqual({ count: 1, skip: false });
    expect(nextFailure({ id: 'x', count: 1 }, 'x')).toEqual({ count: 2, skip: false });
    expect(nextFailure({ id: 'x', count: 2 }, 'x')).toEqual({ count: 3, skip: true });
    expect(nextFailure({ id: 'x', count: 2 }, 'y')).toEqual({ count: 1, skip: false });
  });
});

describe('H5 Gmail の見回りの計画', () => {
  const T0 = '2026-11-11T10:00:00.000Z';
  const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
  const source = (over: Partial<SourceState>): SourceState => ({ kind: 'gmail', dataSourceId: 'ds', userId: 'u', gatewayCredentialId: 'g', status: 'ok', reason: null, folders: {}, connectedAt: T0, lastSyncAt: T0, lastRetryAt: null, ...over });

  it('外したものは何もしない。broken は 1 時間おきに試し直す。setup のままなら setup。ok は見回りのたびに読む（間隔の設定はない）', () => {
    expect(planPoll(source({ status: 'disconnected' }), at(60))).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: null }), at(5))).toEqual({ kind: 'retry' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: T0 }), at(30))).toEqual({ kind: 'idle' });
    expect(planPoll(source({ status: 'broken', lastRetryAt: T0 }), at(60))).toEqual({ kind: 'retry' });
    expect(planPoll(source({ status: 'setup' }), at(5))).toEqual({ kind: 'setup' });
    expect(planPoll(source({}), at(5))).toEqual({ kind: 'poll' });
    expect(planPoll(source({ lastSyncAt: at(4) }), at(5))).toEqual({ kind: 'poll' });
  });

  it('拾い直しの検索の起点は、最後に読めた時刻の 10 分前（エポック秒）。なければつないだ時刻から', () => {
    expect(RECOVERY_OVERLAP_MINUTES).toBe(10);
    expect(recoveryAfter('2026-11-11T10:00:00.900Z', '2026-11-01T00:00:00.000Z')).toBe(Date.parse('2026-11-11T09:50:00.000Z') / 1000);
    expect(recoveryAfter(null, '2026-11-01T00:30:00.000Z')).toBe(Date.parse('2026-11-01T00:20:00.000Z') / 1000);
    expect(recoveryAfter('壊れた時刻', '2026-11-01T00:30:00.000Z')).toBe(Date.parse('2026-11-01T00:20:00.000Z') / 1000);
  });
});

describe('H5 Gmail の読み取りの口', () => {
  const calls: string[] = [];
  const reply = (status: number, body: unknown): UpstreamCall => async (method, path) => {
    calls.push(`${method} ${path}`);
    // 本物の口と同じく、読める口の外は送る前に断る
    if (!inScope(GMAIL_SCOPE, method, path)) throw new Error(`out of scope: ${method} ${path}`);
    return new Response(JSON.stringify(body), { status });
  };

  it('呼ぶ口は全部読める口の中（GET だけ）。メッセージは format=full、履歴は messageAdded', async () => {
    calls.length = 0;
    const ok: UpstreamCall = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (!inScope(GMAIL_SCOPE, method, path)) throw new Error(`out of scope: ${method} ${path}`);
      const body = path.includes('/profile') ? { emailAddress: 'bob@gws.example', historyId: '5' } : path.includes('/history') ? { historyId: '9' } : path.includes('/sendAs') ? {} : path.includes('/messages?') ? {} : { id: 'x' };
      return new Response(JSON.stringify(body));
    };
    const api = new GatewayGmailApi(ok);
    expect(await api.profile()).toEqual({ emailAddress: 'bob@gws.example', historyId: '5' });
    expect(await api.sendAs()).toEqual([]);
    expect(await api.history('5', 'tok')).toEqual({ historyId: '9' });
    expect(await api.message('18c0')).toEqual({ id: 'x' });
    expect(await api.list(1700000000, 'p2')).toEqual({ ids: [] });
    expect(calls).toEqual([
      'GET /gmail/v1/users/me/profile',
      'GET /gmail/v1/users/me/settings/sendAs',
      'GET /gmail/v1/users/me/history?startHistoryId=5&historyTypes=messageAdded&maxResults=500&pageToken=tok',
      'GET /gmail/v1/users/me/messages/18c0?format=full',
      'GET /gmail/v1/users/me/messages?q=after%3A1700000000&maxResults=100&pageToken=p2',
    ]);
  });

  it('404: メッセージは消えた（null）、履歴は位置が切れた（GmailError 404）', async () => {
    const notFound = reply(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
    expect(await new GatewayGmailApi(notFound).message('gone')).toBeNull();
    await expect(new GatewayGmailApi(notFound).history('1')).rejects.toMatchObject({ name: 'GmailError', status: 404 });
  });

  it('同意・資格情報の問題（401・上限でない 403・ゲートウェイの 403）は GatewayAuthError、上限（429・クォータの 403）は GmailError（試し直す側）', async () => {
    await expect(new GatewayGmailApi(reply(401, { error: { code: 401, status: 'UNAUTHENTICATED' } })).profile()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(new GatewayGmailApi(reply(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Insufficient Permission' } })).profile()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(new GatewayGmailApi(reply(403, { error: 'credential must be reconnected' })).profile()).rejects.toBeInstanceOf(GatewayAuthError);
    for (const body of [
      { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } },
      { error: { code: 403, message: 'Quota exceeded for quota metric', errors: [{ reason: 'userRateLimitExceeded' }] } },
      { error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] } },
      { error: { code: 403, status: 'RESOURCE_EXHAUSTED' } },
    ]) await expect(new GatewayGmailApi(reply(403, body)).history('1')).rejects.toBeInstanceOf(GmailError);
    await expect(new GatewayGmailApi(reply(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })).history('1')).rejects.toMatchObject({ status: 429 });
    await expect(new GatewayGmailApi(reply(500, { error: { code: 500, status: 'INTERNAL' } })).history('1')).rejects.toMatchObject({ status: 500 });
  });

  it('分類は構造化されたエラーで行う: quotaExceeded も試し直す側。API が有効でない 403（accessNotConfigured・SERVICE_DISABLED）は同意の問題にせず GoogleApiNotEnabled。文面だけでは分類しない', async () => {
    const e403 = (body: object) => reply(403, { error: { code: 403, message: 'm', ...body } });
    await expect(new GatewayGmailApi(e403({ errors: [{ reason: 'quotaExceeded' }] })).history('1')).rejects.toBeInstanceOf(GmailError);
    const disabled = [
      { status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }] },
      { status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] },
      { status: 'SERVICE_DISABLED' },
    ];
    for (const body of disabled) {
      await expect(new GatewayGmailApi(e403(body)).profile(), JSON.stringify(body)).rejects.toBeInstanceOf(GoogleApiNotEnabled);
      await expect(new GatewayGmailApi(e403(body)).profile()).rejects.not.toBeInstanceOf(GatewayAuthError);
    }
    await expect(new GatewayGmailApi(e403(disabled[0]!)).profile()).rejects.toThrow(/Gmail API がゲートウェイの Google Cloud プロジェクトで有効になっていない/);
    await expect(new GatewayGmailApi(e403({ status: 'PERMISSION_DENIED', message: 'Rate limit quota exceeded' })).profile()).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(new GatewayGmailApi(e403({ status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] })).profile()).rejects.toBeInstanceOf(GatewayAuthError);
  });
});
