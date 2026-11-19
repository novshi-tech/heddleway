import type { ListView, MyTurnReason } from '../domain';
import type { ConnectionView } from '../app/connections';

// 本人の「参加中のリスト」の画面（0048）。純関数（入力 → HTML の断片）。
// ゲートウェイの画面（/features/murmur）の本文になり、ゲートウェイが自分の枠に入れて出す。
// 見せるのは本人がメンバーのリストだけで、ほかの共有リストは名前も出さない（あることが分かってしまうため）

export type ListKind = ConnectionView['kind'];

export interface MyListsInput {
  /** ゲートウェイの User ID（entra_… / google_…）。リストを増やす案内を IdP で分ける */
  userId: string;
  /** 本人の呼び方（なければ空） */
  name: string;
  /** 本人がメンバーのリスト（list_lists）と、共有リストか */
  lists: (ListView & { shared: boolean })[];
  /** 取り込みの状態（GET /connections）。外部コネクタがなければ空 */
  connections: ConnectionView[];
  /** 見えるリストの開いているトピック（件数だけ使う） */
  threads: { dataSourceId: string; myTurn: MyTurnReason[]; triage: boolean }[];
  /** 共有リストを許すサービス（デプロイの設定 MURMUR_SHARED_SERVICES） */
  sharedServices: readonly string[];
  /** 時刻を出すタイムゾーン（既定 Asia/Tokyo） */
  timeZone?: string;
}

export const KIND_LABEL: Record<ListKind, string> = {
  outlook: 'Outlook のメール',
  'shared-mailbox': '共有メールボックス',
  gmail: 'Gmail',
  jira: 'Jira のプロジェクト',
  teams: 'Teams のチャネル',
  'teams-chat': 'Teams のチャット',
  'google-chat': 'Google Chat のスペース',
  'google-chat-dm': 'Google Chat のチャット',
  todo: 'To Do のタスク',
  'google-tasks': 'Google Tasks のタスク',
};

/** 個人リストにできるもの（IdP ごと）と、エージェントへの頼み方 */
const PERSONAL: Record<'entra' | 'google', { kind: ListKind; ask: string }[]> = {
  entra: [
    { kind: 'outlook', ask: 'トピック索引に Outlook をつないで' },
    { kind: 'todo', ask: 'トピック索引に To Do をつないで' },
    { kind: 'teams-chat', ask: 'トピック索引に Teams のチャットをつないで' },
  ],
  google: [
    { kind: 'gmail', ask: 'トピック索引に Gmail をつないで' },
    { kind: 'google-tasks', ask: 'トピック索引に Google Tasks をつないで' },
    { kind: 'google-chat-dm', ask: 'トピック索引に Google Chat のチャットをつないで' },
  ],
};

/** 共有リストの入り方（MURMUR_SHARED_SERVICES の名前ごと）。どのスペースがあるかは書かない */
const SHARED_GUIDE: { service: string; idp?: 'entra' | 'google'; title: string; text: string; ask: string }[] = [
  {
    service: 'teams',
    idp: 'entra',
    title: 'Teams のチャネル',
    text: 'チャネルのメンバーなら、ほかの人がつないだチャネルには自動で入ります(1 時間ごとに反映)。まだ誰もつないでいないチャネルは、エージェントに頼んでつなぎます。',
    ask: 'トピック索引に Teams の〇〇チャネルをつないで',
  },
  {
    service: 'google-chat',
    idp: 'google',
    title: 'Google Chat のスペース',
    text: 'スペースのメンバーなら、ほかの人がつないだスペースには自動で入ります(1 時間ごとに反映)。まだ誰もつないでいないスペースは、エージェントに頼んでつなぎます。',
    ask: 'トピック索引に Google Chat の〇〇スペースをつないで',
  },
  {
    service: 'jira',
    title: 'Jira のプロジェクト',
    text: 'ほかの人がつないだプロジェクトでも、自分の Jira をゲートウェイにつないでから、自分でつなぐとメンバーになります。',
    ask: 'トピック索引に Jira の〇〇プロジェクトをつないで',
  },
  {
    service: 'shared-mailbox',
    idp: 'entra',
    title: '共有メールボックス',
    text: '箱を読める人(Exchange でフルアクセスのある人)が、それぞれ自分でつなぐとメンバーになります。',
    ask: 'トピック索引に共有メールボックス 〇〇@… をつないで',
  },
];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function idpOf(userId: string): 'entra' | 'google' | null {
  if (userId.startsWith('entra_')) return 'entra';
  if (userId.startsWith('google_')) return 'google';
  return null;
}

/** リストの種類。取り込みの状態があればそれ、なければデータソースの経路から */
export function kindOf(list: ListView, connection: ConnectionView | undefined): ListKind | null {
  if (connection) return connection.kind;
  const o = list.dataSource.origin;
  if (!o) return null;
  switch (o.kind) {
    case 'graph-mail':
      return o.mailbox === 'me' ? 'outlook' : 'shared-mailbox';
    case 'graph-todo':
      return 'todo';
    default:
      return o.kind;
  }
}

function statusBadge(c: ConnectionView | undefined): string {
  if (!c) return '';
  switch (c.status) {
    case 'ok':
      return '<span class="badge">取り込み中</span>';
    case 'setup':
      return '<span class="badge">準備中</span>';
    case 'broken':
      return '<span class="badge broken">止まっています</span>';
    case 'disconnected':
      return '<span class="badge">外しています</span>';
  }
}

function formatTime(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ja-JP', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const MEMBER_NAMES_SHOWN = 8;

function members(list: ListView): string {
  const names = list.readers.map((r) => r.name || '(呼び方なし)');
  const shown = names.slice(0, MEMBER_NAMES_SHOWN).join('、');
  const more = names.length > MEMBER_NAMES_SHOWN ? ` ほか ${names.length - MEMBER_NAMES_SHOWN} 人` : '';
  return `メンバー ${names.length} 人: ${esc(shown)}${more}`;
}

function row(list: ListView & { shared: boolean }, c: ConnectionView | undefined, counts: { mine: number; triage: number }, timeZone: string): string {
  const kind = kindOf(list, c);
  const synced = formatTime(c?.last_sync_at, timeZone);
  const sub = [kind ? KIND_LABEL[kind] : null, synced ? `最後の取り込み ${synced}` : null].filter((s): s is string => s !== null).map(esc);
  const tally = [`担当・アテンション ${counts.mine} 件`, ...(list.shared ? [`割当待ち ${counts.triage} 件`] : [])].join(' · ');
  const trouble =
    c?.status === 'broken'
      ? `<p class="row-sub">${esc(c.reason ?? '取り込めていません')}。ゲートウェイで接続をつなぎ直してから、エージェントにもう一度つなぐよう頼んでください。</p>`
      : c?.status === 'disconnected'
        ? `<p class="row-sub">${esc(c.reason ?? '外しています')}。これまでのトピックは読めますが、新しいやりとりは入りません。</p>`
        : '';
  return `<li>
<div class="row-main"><p class="row-title">${esc(list.dataSource.name)}</p><p class="row-sub">${sub.join(' · ')}</p><p class="row-sub">${esc(tally)}</p>${list.shared ? `<p class="row-sub">${members(list)}</p>` : ''}${trouble}</div>
<div class="row-actions">${statusBadge(c)}</div>
</li>`;
}

function hintRow(title: string, text: string, ask: string): string {
  return `<li>
<div class="row-main"><p class="row-title">${esc(title)}</p>${text ? `<p class="row-sub">${esc(text)}</p>` : ''}<p class="row-sub">エージェント(Claude など)に「${esc(ask)}」と頼みます。</p></div>
</li>`;
}

export function renderMyLists(input: MyListsInput): string {
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  const byDs = new Map(input.connections.map((c) => [c.data_source, c]));
  const counts = new Map<string, { mine: number; triage: number }>();
  for (const t of input.threads) {
    const n = counts.get(t.dataSourceId) ?? { mine: 0, triage: 0 };
    if (t.myTurn.length > 0) n.mine++;
    if (t.triage) n.triage++;
    counts.set(t.dataSourceId, n);
  }
  const rowOf = (l: ListView & { shared: boolean }) => row(l, byDs.get(l.dataSource.id), counts.get(l.dataSource.id) ?? { mine: 0, triage: 0 }, timeZone);
  const personal = input.lists.filter((l) => !l.shared);
  const shared = input.lists.filter((l) => l.shared);

  const idp = idpOf(input.userId);
  const have = new Set(personal.map((l) => kindOf(l, byDs.get(l.dataSource.id))));
  const missing = idp ? PERSONAL[idp].filter((p) => !have.has(p.kind)) : [];
  const guides = SHARED_GUIDE.filter((g) => input.sharedServices.includes(g.service) && (!g.idp || !idp || g.idp === idp));

  const section = (title: string, lists: (ListView & { shared: boolean })[], empty: string) =>
    `<h2>${esc(title)}</h2>\n${lists.length > 0 ? `<ul class="list">${lists.map(rowOf).join('\n')}</ul>` : `<p class="empty">${esc(empty)}</p>`}`;

  return [
    '<h1>参加中のリスト</h1>',
    '<p>トピック索引で、あなたがメンバーになっているリストです。エージェント(Claude など)に「今日やることは?」と聞くと、ここにあるリストのトピックから答えます。</p>',
    input.name
      ? `<p class="hint">トピック索引での呼び方: ${esc(input.name)}</p>`
      : '<p class="notice" role="status">呼び方がまだ決まっていません。エージェントに「トピック索引での私の呼び方を〇〇にして」と頼んでください。</p>',
    section('個人のリスト', personal, 'まだありません。下の「リストを増やすには」から始めてください。'),
    section('共有のリスト', shared, 'まだどの共有リストのメンバーにもなっていません。'),
    missing.length + guides.length > 0
      ? `<h2>リストを増やすには</h2>\n<ul class="list">${[
          ...missing.map((p) => hintRow(KIND_LABEL[p.kind], '', p.ask)),
          ...guides.map((g) => hintRow(g.title, g.text, g.ask)),
        ].join('\n')}</ul>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
