import type { MyTurnReason, ThreadItem } from '../domain';
import type { ListKind } from './my-lists';
import { KIND_LABEL } from './my-lists';

// 本人の「今やること」の画面（0051）。純関数（入力 → HTML の断片）。
// ゲートウェイの画面（/features/topic-index）の本文になり、ゲートウェイが自分の枠に入れて出す。
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

/** 一覧の行。相手の名前は一覧に出さず、詳細だけに出す（0052） */
export type NowThread = ThreadItem;

export interface NowInput {
  /** 画面の根の経路（例: /features/topic-index）。トピックの詳細は <base>/threads/<id>、リストは <base>/lists */
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

/** 今やること・参加中のリストのタブ。タブが見出しを兼ねる（見出しは読み上げ用にだけ置く）。note はタブの右に添える一言 */
export function tabs(base: string, current: 'now' | 'lists', note?: string): string {
  const tab = (href: string, label: string, on: boolean) =>
    on ? `<a class="tab" href="${esc(href)}" aria-current="page">${esc(label)}</a>` : `<a class="tab" href="${esc(href)}">${esc(label)}</a>`;
  const heading = current === 'now' ? '今やること' : '参加中のリスト';
  return `<nav class="tabs">${tab(base, '今やること', current === 'now')}${tab(`${base}/lists`, '参加中のリスト', current === 'lists')}${note ? `<span class="tabs-note">${esc(note)}</span>` : ''}</nav>\n<h1 class="sr-only">${heading}</h1>`;
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

/** 1 行。行全体がトピックの詳細へのリンク。件名は 2 行まで、補足（いつ・どのリスト・状態）は 1 行で、はみ出したら省く（0051・0052） */
function row(input: Pick<NowInput, 'base' | 'now'>, t: NowThread, list: PageList | undefined, badges: string[], timeZone: string): string {
  const when = formatWhen(t.lastActivityAt, input.now, timeZone);
  const status = t.source?.statusLabel && !TASK_KINDS.includes(list?.kind ?? null) ? t.source.statusLabel : null;
  const meta = [when, list?.name ?? null, status].filter((s): s is string => !!s).map(esc).join(' · ');
  const tags = [dueBadge(t, input.now, timeZone), ...badges].filter(Boolean).join('');
  return `<li><a class="item" href="${esc(`${input.base}/threads/${encodeURIComponent(t.id)}`)}"><span class="item-title">${esc(t.title)}</span>${tags ? `<span class="item-tags">${tags}</span>` : ''}<span class="item-meta">${meta}</span></a></li>`;
}

/** ファーストビューに出す「自分の担当」の数（0052） */
export const TOP = 5;

/** 期限の近いものを先に（期限のないものは後ろで、最後の動きの新しい順） */
function byDue(a: NowThread, b: NowThread): number {
  const da = a.replyExpectedBy ?? a.source?.due ?? null;
  const db = b.replyExpectedBy ?? b.source?.due ?? null;
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return -1;
  if (!da && db) return 1;
  return byActivity(a, b);
}

function byActivity(a: NowThread, b: NowThread): number {
  return a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0;
}

/**
 * 区分け（0052）。1 つのトピックは最初に当てはまった区分にだけ出す。
 * 自分の担当（担当と、個人リストのタスク）は 1 つにまとめて期限順。アテンションは本人宛てを先に
 */
export function sortNow(input: Pick<NowInput, 'lists' | 'threads'>) {
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const take = (pred: (t: NowThread) => boolean) =>
    input.threads.filter((t) => {
      if (seen.has(t.id) || !pred(t)) return false;
      seen.add(t.id);
      return true;
    });
  const mine = take((t) => {
    if (t.myTurn.includes('assignee')) return true;
    const l = listOf.get(t.dataSourceId);
    return !!l && !l.shared && TASK_KINDS.includes(l.kind);
  }).sort(byDue);
  const named = take((t) => t.myTurn.includes('named')).sort(byActivity);
  const list = take((t) => t.myTurn.includes('list')).sort(byActivity);
  const awaiting = take((t) => t.awaiting).sort((a, b) => (a.overdue === b.overdue ? byDue(a, b) : a.overdue ? -1 : 1));
  const triage = take((t) => t.triage).sort(byActivity);
  return { mine, attention: [...named, ...list], awaiting, triage };
}

type DueState = 'overdue' | 'today' | null;

/** 期限が過ぎたか今日までか（タスクの期限か、送ったときに決めた返事の期限） */
export function dueState(t: NowThread, now: string, timeZone: string): DueState {
  if (t.replyExpectedBy) {
    if (t.overdue) return 'overdue';
    return dayOf(t.replyExpectedBy, timeZone) === dayOf(now, timeZone) ? 'today' : null;
  }
  const due = t.source?.due;
  if (!due) return null;
  const day = dayOf(due, timeZone);
  const today = dayOf(now, timeZone);
  if (!day || !today) return null;
  return day < today ? 'overdue' : day === today ? 'today' : null;
}

/** アテンションのリストごとのまとまり。新しく動いたリストが上 */
export interface AttentionGroup {
  list: PageList | undefined;
  listId: string;
  threads: NowThread[];
  named: number;
}

export function attentionGroups(input: Pick<NowInput, 'lists'>, attention: NowThread[]): AttentionGroup[] {
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  const groups = new Map<string, AttentionGroup>();
  for (const t of attention) {
    const g = groups.get(t.dataSourceId) ?? { list: listOf.get(t.dataSourceId), listId: t.dataSourceId, threads: [], named: 0 };
    g.threads.push(t);
    if (t.myTurn.includes('named')) g.named += 1;
    groups.set(t.dataSourceId, g);
  }
  const latest = (g: AttentionGroup) => g.threads.reduce((m, t) => (t.lastActivityAt > m ? t.lastActivityAt : m), '');
  return [...groups.values()].sort((a, b) => (latest(a) < latest(b) ? 1 : latest(a) > latest(b) ? -1 : 0));
}

const EMPTY_LISTS =
  '<p class="empty">まだどのリストのメンバーにもなっていません。エージェント(Claude など)に「トピック索引に Outlook をつないで」のように頼むと、ここに出るようになります。</p>';

/** 一覧の区分（0052）。ファーストビューから開く先 */
export type NowSection = 'mine' | 'attention' | 'awaiting' | 'triage';

const SECTION: Record<NowSection, { title: string; note: string; empty: string }> = {
  mine: { title: '自分の担当', note: '担当と、To Do・Google Tasks のタスク。期限の近い順', empty: '担当・タスクはありません。' },
  attention: { title: 'アテンション', note: '見てほしいと届いたもの。リストごと', empty: '残っているアテンションはありません。' },
  awaiting: { title: '返事待ち', note: '送って返事がまだのもの', empty: '返事待ちはありません。' },
  triage: { title: '割当待ち', note: '共有のリストで担当が決まっていないもの', empty: '割当待ちはありません。' },
};

const namedBadge = (t: NowThread) => (t.myTurn.includes('named') ? [`<span class="badge">${REASON_LABEL.named}</span>`] : []);

/**
 * 「今やること」のファーストビュー（0052）。スマホの 1 画面に収める:
 * 期限切れ・今日までの数、自分の担当（期限順の上位 5 件）、アテンション（リストごとの件数）、返事待ち・割当待ち（件数だけ）。
 * 中身はそれぞれの区分の画面（renderSection）で見る
 */
export function renderNow(input: NowInput): string {
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  if (input.lists.length === 0) {
    const parts = [tabs(input.base, 'now')];
    parts.push(EMPTY_LISTS);
    return `<div class="now">${parts.join('\n')}</div>`;
  }
  const s = sortNow(input);
  const states = s.mine.map((t) => dueState(t, input.now, timeZone));
  const overdue = states.filter((x) => x === 'overdue').length;
  const today = states.filter((x) => x === 'today').length;
  const at = new Date(input.now).toLocaleTimeString('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit' });
  const link = (path: string) => esc(`${input.base}/${path}`);
  const more = (path: string, n: number) => `<a class="more" href="${link(path)}">${n} 件すべて見る</a>`;

  const parts = [tabs(input.base, 'now', `${at} 時点`)];
  if (overdue + today > 0) {
    const bits = [overdue > 0 ? `期限切れ <b>${overdue}</b>` : '', today > 0 ? `今日まで <b>${today}</b>` : ''].filter(Boolean).join(' · ');
    parts.push(`<a class="alert${overdue > 0 ? ' broken' : ''}" href="${link('mine')}">${bits}</a>`);
  }

  const head = (title: string, n: number) => `<div class="block-head"><h2>${esc(title)}</h2><span class="count">${n}</span></div>`;
  parts.push(
    `<section class="block" id="mine">${head(SECTION.mine.title, s.mine.length)}${
      s.mine.length > 0
        ? `<ul class="items">${s.mine
            .slice(0, TOP)
            .map((t) => row(input, t, listOf.get(t.dataSourceId), [], timeZone))
            .join('\n')}</ul>${s.mine.length > TOP ? more('mine', s.mine.length) : ''}`
        : `<p class="sec-empty">${SECTION.mine.empty}</p>`
    }</section>`,
  );

  const groups = attentionGroups(input, s.attention);
  parts.push(
    `<section class="block" id="attention">${head(SECTION.attention.title, s.attention.length)}${
      groups.length > 0
        ? `<ul class="items">${groups
            .map(
              (g) =>
                `<li><a class="item group" href="${link(`attention/${encodeURIComponent(g.listId)}`)}"><span class="item-title">${esc(g.list?.name ?? g.listId)}</span><span class="item-tags">${
                  g.named > 0 ? `<span class="badge">あなた宛て ${g.named}</span>` : ''
                }<span class="count">${g.threads.length}</span></span></a></li>`,
            )
            .join('\n')}</ul>`
        : `<p class="sec-empty">${SECTION.attention.empty}</p>`
    }</section>`,
  );

  const awaitingOverdue = s.awaiting.filter((t) => t.overdue).length;
  const line = (path: string, label: string, n: number, extra = '') => `<a href="${link(path)}">${esc(label)} <b>${n}</b>${extra}</a>`;
  parts.push(
    `<nav class="now-more">${line('awaiting', '返事待ち', s.awaiting.length, awaitingOverdue > 0 ? ` <span class="badge broken">期限切れ ${awaitingOverdue}</span>` : '')}${
      s.triage.length > 0 ? line('triage', '割当待ち', s.triage.length) : ''
    }</nav>`,
    '<p class="hint">担当する・目を通した(アテンションを外す)などは、エージェント(Claude など)に頼みます。</p>',
  );
  return `<div class="now">${parts.join('\n')}</div>`;
}

/** 区分の画面（0052）。attention は listId でリストを 1 つに絞れる（なければリストごとに見出しを付けて全部）。知らないリストは null */
export function renderSection(input: NowInput, section: NowSection, listId?: string): { title: string; body: string } | null {
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  const listOf = new Map(input.lists.map((l) => [l.id, l]));
  const s = sortNow(input);
  const def = SECTION[section];
  const back = `<a class="back" href="${esc(input.base)}">← 今やること</a>`;
  const items = (ts: NowThread[], badges: (t: NowThread) => string[]) =>
    `<ul class="items">${ts.map((t) => row(input, t, listOf.get(t.dataSourceId), badges(t), timeZone)).join('\n')}</ul>`;
  const page = (title: string, n: number, note: string, inner: string) => ({
    title,
    body: `<div class="now">${back}\n<div class="now-head"><h1>${esc(title)}</h1><span class="count">${n}</span></div>\n<p class="now-sub">${esc(note)}</p>\n${inner}</div>`,
  });
  if (input.lists.length === 0) return page(def.title, 0, def.note, EMPTY_LISTS);

  if (section === 'attention') {
    const groups = attentionGroups(input, s.attention);
    if (listId !== undefined) {
      const list = listOf.get(listId);
      if (!list) return null;
      const g = groups.find((x) => x.listId === listId);
      const ts = g?.threads ?? [];
      return page(list.name, ts.length, 'アテンション · あなた宛てが先、新しい順', ts.length > 0 ? items(ts, namedBadge) : `<p class="sec-empty">${def.empty}</p>`);
    }
    const inner =
      groups.length > 0
        ? groups.map((g) => `<h2 class="group-head">${esc(g.list?.name ?? g.listId)} <span class="count">${g.threads.length}</span></h2>\n${items(g.threads, namedBadge)}`).join('\n')
        : `<p class="sec-empty">${def.empty}</p>`;
    return page(def.title, s.attention.length, def.note, inner);
  }
  const ts = s[section];
  return page(def.title, ts.length, def.note, ts.length > 0 ? items(ts, () => []) : `<p class="sec-empty">${def.empty}</p>`);
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
  /** 元のアプリで開くリンク（Jira 以外。LINE なら受け口の会話の画面。0054・0055） */
  sourceLink?: { href: string; label: string } | null;
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
  const jira = input.list?.kind === 'jira' ? jiraUrl(input.list, t.source?.key) : null;
  const link = jira ? { href: jira, label: `Jira で ${t.source?.key ?? ''} を開く` } : (input.sourceLink ?? null);
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

  const parts = [
    `<a class="back" href="${esc(input.base)}">← 今やること</a>`,
    `<h1>${esc(t.title)}</h1>`,
    badges.length > 0 ? `<p class="badges">${badges.join(' ')}</p>` : '',
    `<ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
    link ? `<p><a class="button quiet" href="${esc(link.href)}" rel="noopener noreferrer" target="_blank">${esc(link.label)}</a></p>` : '',
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
  return `<div class="topic">${parts}</div>`;
}
