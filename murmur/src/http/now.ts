import type { MyTurnReason, ThreadItem } from '../domain';
import type { ListKind } from './my-lists';
import { KIND_LABEL } from './my-lists';

// 本人の「今やること」の画面（0051）。純関数（入力 → HTML の断片）。
// ゲートウェイの画面（/features/murmur）の本文になり、ゲートウェイが自分の枠に入れて出す。
// 参照だけで、操作（担当する・アテンションを外す・片付ける）は置かない。操作はエージェントに頼む

/** 画面に出すリスト（本人がメンバーのものだけ） */
export interface PageList {
  id: string;
  name: string;
  kind: ListKind | null;
  shared: boolean;
  /** Jira のリストならサイトの URL（課題へのリンクに使う） */
  jiraSite: string | null;
}

export type NowThread = ThreadItem & {
  /** 相手の名前（Contact の名前か、解決できなかったアドレス） */
  counterparts: string[];
};

export interface NowInput {
  /** 画面の根の経路（例: /features/murmur）。トピックの詳細は <base>/threads/<id>、リストは <base>/lists */
  base: string;
  /** 本人の呼び方（なければ空） */
  name: string;
  lists: PageList[];
  /** 見えるリストの開いているトピック */
  threads: NowThread[];
  /** いまの時刻（期限切れの判定と「何分前」に使う） */
  now: string;
  timeZone?: string;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const TASK_KINDS: readonly (ListKind | null)[] = ['todo', 'google-tasks'];

export function tabs(base: string, current: 'now' | 'lists'): string {
  const tab = (href: string, label: string, on: boolean) =>
    on ? `<a class="tab" href="${esc(href)}" aria-current="page">${esc(label)}</a>` : `<a class="tab" href="${esc(href)}">${esc(label)}</a>`;
  return `<nav class="tabs">${tab(base, '今やること', current === 'now')}${tab(`${base}/lists`, '参加中のリスト', current === 'lists')}</nav>`;
}

/** 日付（YYYY-MM-DD）をそのタイムゾーンで */
function dayOf(iso: string, timeZone: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone });
}

export function formatWhen(iso: string | null | undefined, now: string, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const minutes = Math.floor((new Date(now).getTime() - d.getTime()) / 60000);
  if (minutes >= 0 && minutes < 60) return minutes < 1 ? 'たった今' : `${minutes} 分前`;
  const today = dayOf(now, timeZone);
  const time = d.toLocaleTimeString('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit' });
  if (dayOf(iso, timeZone) === today) return `今日 ${time}`;
  return d.toLocaleString('ja-JP', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string, timeZone: string): string {
  const day = dayOf(iso, timeZone);
  if (!day) return iso;
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 期限のバッジ。タスクの期限（日付）と、送ったときに決めた返事の期限（時刻） */
function dueBadge(t: NowThread, now: string, timeZone: string): string {
  if (t.overdue && t.replyExpectedBy) return `<span class="badge broken">返事の期限切れ ${esc(formatDay(t.replyExpectedBy, timeZone))}</span>`;
  if (t.replyExpectedBy) return `<span class="badge">返事の期限 ${esc(formatDay(t.replyExpectedBy, timeZone))}</span>`;
  const due = t.source?.due;
  if (!due) return '';
  const day = dayOf(due, timeZone);
  const today = dayOf(now, timeZone);
  if (day && today && day < today) return `<span class="badge broken">期限切れ ${esc(formatDay(due, timeZone))}</span>`;
  if (day && today && day === today) return `<span class="badge warn">今日まで</span>`;
  return `<span class="badge">期限 ${esc(formatDay(due, timeZone))}</span>`;
}

const REASON_LABEL: Record<MyTurnReason, string> = { assignee: '担当', named: 'あなた宛て', list: 'リスト宛て' };

export function jiraUrl(list: PageList | undefined, key: string | null | undefined): string | null {
  if (!list?.jiraSite || !key) return null;
  return `${list.jiraSite.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
}

function row(input: NowInput, t: NowThread, list: PageList | undefined, badges: string[], timeZone: string): string {
  const when = formatWhen(t.lastActivityAt, input.now, timeZone);
  const where = [list?.name ?? null, t.source?.statusLabel && !TASK_KINDS.includes(list?.kind ?? null) ? t.source.statusLabel : null];
  const who = t.counterparts.length > 0 ? `相手: ${t.counterparts.slice(0, 2).join('、')}${t.counterparts.length > 2 ? ` ほか ${t.counterparts.length - 2}` : ''}` : null;
  const sub = [...where, who, when ? `最後の動き ${when}` : null].filter((s): s is string => !!s).map(esc).join(' · ');
  return `<li>
<div class="row-main"><a class="row-title" href="${esc(`${input.base}/threads/${encodeURIComponent(t.id)}`)}">${esc(t.title)}</a><p class="row-sub">${sub}</p></div>
<div class="row-actions">${[dueBadge(t, input.now, timeZone), ...badges].filter(Boolean).join('')}</div>
</li>`;
}

/** 期限の近いものを先に（期限のないものは後ろで、最後の動きの新しい順） */
function byDue(a: NowThread, b: NowThread): number {
  const da = a.replyExpectedBy ?? a.source?.due ?? null;
  const db = b.replyExpectedBy ?? b.source?.due ?? null;
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return -1;
  if (!da && db) return 1;
  return a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0;
}

/** 区分け。1 つのトピックは最初に当てはまった区分にだけ出す */
export function sortNow(input: Pick<NowInput, 'lists' | 'threads'>) {
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const take = (pred: (t: NowThread) => boolean) =>
    input.threads.filter((t) => {
      if (seen.has(t.id) || !pred(t)) return false;
      seen.add(t.id);
      return true;
    });
  const assigned = take((t) => t.myTurn.includes('assignee')).sort(byDue);
  const tasks = take((t) => {
    const l = listOf.get(t.dataSourceId);
    return !!l && !l.shared && TASK_KINDS.includes(l.kind);
  }).sort(byDue);
  const named = take((t) => t.myTurn.includes('named'));
  const list = take((t) => t.myTurn.includes('list'));
  const awaiting = take((t) => t.awaiting).sort((a, b) => (a.overdue === b.overdue ? byDue(a, b) : a.overdue ? -1 : 1));
  const triage = take((t) => t.triage);
  return { assigned, tasks, attention: [...named, ...list], awaiting, triage };
}

export function renderNow(input: NowInput): string {
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  const s = sortNow(input);
  const rows = (ts: NowThread[], badges: (t: NowThread) => string[] = () => []) =>
    `<ul class="list">${ts.map((t) => row(input, t, listOf.get(t.dataSourceId), badges(t), timeZone)).join('\n')}</ul>`;
  const reasonBadges = (t: NowThread) => t.myTurn.filter((r) => r !== 'assignee').map((r) => `<span class="badge">${REASON_LABEL[r]}</span>`);
  const section = (title: string, hint: string, ts: NowThread[], empty: string, badges?: (t: NowThread) => string[]) =>
    `<h2>${esc(title)} <span class="count">${ts.length}</span></h2>\n<p class="hint">${esc(hint)}</p>\n${ts.length > 0 ? rows(ts, badges) : `<p class="empty">${esc(empty)}</p>`}`;

  const hasTasks = input.lists.some((l) => !l.shared && TASK_KINDS.includes(l.kind));
  const parts = [
    tabs(input.base, 'now'),
    '<h1>今やること</h1>',
    `<p>トピック索引から、${input.name ? `${esc(input.name)}さんの` : 'あなたの'}担当とアテンションを集めた一覧です。開いたときの内容なので、新しく届いたものは再読み込みで出ます。</p>`,
  ];
  if (input.lists.length === 0) {
    parts.push(
      '<p class="empty">まだどのリストのメンバーにもなっていません。エージェント(Claude など)に「トピック索引に Outlook をつないで」のように頼むと、ここに出るようになります。</p>',
    );
    return parts.join('\n');
  }
  parts.push(
    `<p class="summary">${[
      `担当 ${s.assigned.length}`,
      ...(hasTasks ? [`タスク ${s.tasks.length}`] : []),
      `アテンション ${s.attention.length}`,
      `返事待ち ${s.awaiting.length}`,
    ]
      .map(esc)
      .join(' · ')}</p>`,
    section('自分の担当', '自分が担当のトピック(Jira の担当課題や、担当すると決めたもの)。', s.assigned, '担当のトピックはありません。'),
  );
  if (hasTasks) parts.push(section('自分のタスク', 'To Do・Google Tasks の、まだ終わっていないタスク。', s.tasks, '終わっていないタスクはありません。'));
  parts.push(
    section(
      'アテンション',
      '少なくとも見てほしいと届いたもの。対応が要るか、目を通すだけでよいかは読んで決めます。目を通したら、エージェントに「目を通した」と伝えると外れます。',
      s.attention,
      '残っているアテンションはありません。',
      reasonBadges,
    ),
    section('返事待ち', 'こちらから送って、相手の返事がまだのもの。', s.awaiting, '返事待ちはありません。'),
  );
  if (s.triage.length > 0) {
    parts.push(
      `<details class="more"><summary>割当待ち <span class="count">${s.triage.length}</span>(共有のリストで、まだ担当が決まっていないもの)</summary>\n${rows(s.triage)}\n<p class="hint">自分がやるものは、エージェントに「この件は私が担当する」と伝えると担当になります。</p></details>`,
    );
  }
  return parts.join('\n');
}

/** トピックの詳細の 1 行（タイムライン） */
export interface PageEntry {
  at: string;
  kind: string;
  /** 結んだ先のトピックのものなら、その件名 */
  fromLinked: string | null;
  signal?: { direction: 'inbound' | 'outbound'; from: string; to: string[]; subject?: string; body: string; attachments: number };
  note?: { body: string; author: string };
  /** 操作（担当・アテンションを外した・片付け・再開・件名の変更・状態の写し・期限切れ・関連づけ）の一言 */
  text?: string;
}

export interface ThreadPageInput {
  base: string;
  thread: ThreadItem;
  list: PageList | undefined;
  assigneeNames: string[];
  counterparts: string[];
  linked: { id: string; title: string; listName: string; myTurn: MyTurnReason[]; dismissed: boolean }[];
  entries: PageEntry[];
  now: string;
  timeZone?: string;
}

const BODY_SHOWN = 600;

function body(text: string): string {
  const t = text.trim();
  if (t.length <= BODY_SHOWN) return `<div class="entry-body">${esc(t)}</div>`;
  return `<div class="entry-body">${esc(t.slice(0, BODY_SHOWN))}…</div><details class="entry-more"><summary>続きを読む</summary><div class="entry-body">${esc(t)}</div></details>`;
}

export function renderThread(input: ThreadPageInput): string {
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  const t = input.thread;
  const link = input.list?.kind === 'jira' ? jiraUrl(input.list, t.source?.key) : null;
  const facts: string[] = [];
  if (input.list) facts.push(`リスト: ${input.list.name}${input.list.kind ? `(${KIND_LABEL[input.list.kind]})` : ''}`);
  if (input.assigneeNames.length > 0) facts.push(`担当: ${input.assigneeNames.join('、')}`);
  else if (t.triage) facts.push('担当: まだ決まっていません(割当待ち)');
  if (t.source?.statusLabel) facts.push(`${TASK_KINDS.includes(input.list?.kind ?? null) ? 'リストの名前' : '状態'}: ${t.source.statusLabel}`);
  if (t.source?.due) facts.push(`期限: ${formatDay(t.source.due, timeZone)}`);
  if (t.replyExpectedBy) facts.push(`返事の期限: ${formatWhen(t.replyExpectedBy, input.now, timeZone)}${t.overdue ? '(過ぎています)' : ''}`);
  if (input.counterparts.length > 0) facts.push(`相手: ${input.counterparts.join('、')}`);
  const state = t.dismissed ? '片付け済み' : t.closedAtSource ? 'ソースで完了' : null;
  const badges = [
    ...t.myTurn.map((r) => `<span class="badge">${REASON_LABEL[r]}</span>`),
    ...(t.awaiting ? ['<span class="badge">返事待ち</span>'] : []),
    ...(state ? [`<span class="badge">${state}</span>`] : []),
  ];

  const entry = (e: PageEntry) => {
    const when = esc(formatWhen(e.at, input.now, timeZone) ?? e.at);
    const linked = e.fromLinked ? `<span class="badge">関連: ${esc(e.fromLinked)}</span>` : '';
    if (e.signal) {
      const s = e.signal;
      const dir = s.direction === 'outbound' ? '送信' : '受信';
      const to = s.to.length > 0 ? ` → ${s.to.slice(0, 3).join('、')}${s.to.length > 3 ? ` ほか ${s.to.length - 3}` : ''}` : '';
      const files = s.attachments > 0 ? ` · 添付 ${s.attachments}` : '';
      return `<li class="entry ${s.direction}"><p class="entry-meta"><span class="badge">${dir}</span> ${esc(s.from)}${esc(to)} · ${when}${esc(files)} ${linked}</p>${s.subject ? `<p class="entry-subject">${esc(s.subject)}</p>` : ''}${body(s.body)}</li>`;
    }
    if (e.note) return `<li class="entry note"><p class="entry-meta"><span class="badge">メモ</span> ${esc(e.note.author)} · ${when} ${linked}</p>${body(e.note.body)}</li>`;
    return `<li class="entry op"><p class="entry-meta">${esc(e.text ?? e.kind)} · ${when}</p></li>`;
  };

  return [
    `<a class="back" href="${esc(input.base)}">← 今やること</a>`,
    `<h1>${esc(t.title)}</h1>`,
    badges.length > 0 ? `<p class="badges">${badges.join(' ')}</p>` : '',
    `<ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
    link ? `<p><a class="button quiet" href="${esc(link)}" rel="noopener noreferrer" target="_blank">Jira で ${esc(t.source?.key)} を開く</a></p>` : '',
    input.linked.length > 0
      ? `<h2>関連づけたトピック</h2>\n<ul class="list">${input.linked
          .map(
            (l) =>
              `<li><div class="row-main"><a class="row-title" href="${esc(`${input.base}/threads/${encodeURIComponent(l.id)}`)}">${esc(l.title)}</a><p class="row-sub">${esc(l.listName)}${l.dismissed ? ' · 片付け済み' : ''}</p></div><div class="row-actions">${l.myTurn.map((r) => `<span class="badge">${REASON_LABEL[r]}</span>`).join('')}</div></li>`,
          )
          .join('\n')}</ul>`
      : '',
    '<h2>経過</h2>',
    input.entries.length > 0 ? `<ol class="timeline">${[...input.entries].reverse().map(entry).join('\n')}</ol>` : '<p class="empty">まだ何もありません。</p>',
    '<p class="hint">新しいものが上です。返信・担当・アテンションを外すなどの操作は、エージェント(Claude など)に頼んでください。</p>',
  ]
    .filter(Boolean)
    .join('\n');
}
