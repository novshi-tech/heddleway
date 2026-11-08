import {
  assigneeOf,
  attentionOf,
  directionOf,
  getThreadView,
  isAwaiting,
  isTriage,
  lastActivityAt,
  replyStateOf,
  sortLog,
  type Directory,
  type MirrorFields,
  type Projections,
  type Thread,
  type Viewer,
} from '../domain';

// 参照専用の管理画面（ステップ 5）とタイムライン。どれも純関数（マスタ・投影 → HTML 文字列）。
// 運用者向けで、TIMELINE_TOKEN を知っている人には全データソースが見える。スタンドの可視性（H3）とは別の入口

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** 管理画面の中のリンク。トークンをクエリで引き回す */
type Href = (path: string) => string;
export const adminHref =
  (token: string): Href =>
  (path) =>
    `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

function names(dir: Directory, p: Projections) {
  return {
    ds: (id: string) => dir.dataSource(id)?.name ?? id,
    contact: (id: string) => dir.contact(id)?.name ?? id,
    user: (id: string) => dir.seed.users.find((u) => u.id === id)?.name ?? id,
    thread: (id: string) => p.threads[id]?.title ?? id,
  };
}

/** ソースのアカウントを Contact の名前で出す（解決できなければそのまま） */
function holderName(dir: Directory, dataSourceId: string, value: string): string {
  const ds = dir.dataSource(dataSourceId);
  const id = ds?.kind === 'service' ? dir.contactIdOfAddress({ channel: ds.channel, value }) : null;
  return (id ? dir.contact(id)?.name : undefined) ?? value;
}

/** 写しの項目を「名前 = 値」で並べる（0031 の 6） */
function mirrorPairs(dir: Directory, dataSourceId: string, f: MirrorFields): [string, string][] {
  const out: [string, string][] = [];
  if (f.closed !== undefined) out.push(['完了', f.closed ? 'はい' : 'いいえ']);
  if (f.holders !== undefined) out.push(['担当者', f.holders.length ? f.holders.map((h) => holderName(dir, dataSourceId, h)).join(', ') : '(なし)']);
  if (f.title !== undefined) out.push(['件名', f.title]);
  if (f.statusLabel !== undefined) out.push(['ステータス', f.statusLabel ?? '(空)']);
  if (f.due !== undefined) out.push(['期日', f.due ?? '(空)']);
  return out;
}

/** スレッドの写し（一覧・詳細に出す） */
function attrPairs(dir: Directory, t: Thread): [string, string][] {
  const out: [string, string][] = [];
  if (t.source) out.push(...mirrorPairs(dir, t.dataSourceId, { holders: t.source.holders, statusLabel: t.source.statusLabel, due: t.source.due }));
  return out;
}

/** 担当（0038 の決定 1） */
function assigneeLabel(dir: Directory, p: Projections, t: Thread): string {
  const n = names(dir, p);
  const a = assigneeOf(dir, t);
  if (!a) return isTriage(dir, t) ? '仕分け待ち' : 'なし';
  const who = [...a.userIds.map((u) => esc(n.user(u))), ...a.contactIds.map((c) => `${esc(n.contact(c))}（読者でない）`), ...a.addresses.map((r) => `${esc(r.value)}（読者でない）`)];
  return `${who.join(', ')}（${a.by === 'source' ? 'ソースの担当者' : '担当する'}）`;
}

/** 残っている名指し（0038 の決定 2〜4） */
function attentionLabel(dir: Directory, p: Projections, t: Thread): string {
  const n = names(dir, p);
  const a = attentionOf(dir, t);
  const out = a.named.map((x) => (x.userId ? esc(n.user(x.userId)) : `${esc(x.contactId ? n.contact(x.contactId) : x.address.value)}（読者でない）`));
  if (a.list) out.push(`リスト宛て: ${a.list.userIds.map((u) => esc(n.user(u))).join(', ')}`);
  return out.join(', ') || 'なし';
}

function flags(dir: Directory, t: Thread): string {
  const out: string[] = [];
  const reply = replyStateOf(dir, t);
  if (t.dismissed) out.push(`片付け済み（${esc(t.dismissReason)}）`);
  if (t.closedAtSource) out.push('ソースで完了');
  if (reply.overdue) out.push('<b>期限超過</b>');
  else if (reply.replyExpectedBy) out.push(`返事期待 ${esc(reply.replyExpectedBy)}`);
  if (t.activeSinceDismissed) out.push('<b>片付けたあとに動きあり</b>');
  return out.join(' · ');
}

function logEntry(dir: Directory, p: Projections, t: Thread, l: Thread['log'][number], from?: { threadId: string; href?: Href }): string {
  const n = names(dir, p);
  const origin = from ? ` <small>← ${from.href ? `<a href="${esc(from.href(`/admin/threads/${from.threadId}`))}">${esc(n.thread(from.threadId))}</a>` : esc(n.thread(from.threadId))}</small>` : '';
  const head = (kind: string, cls: string) => `<li><time>${esc(l.at)}</time> <span class="k ${esc(cls)}">${kind}</span> `;
  switch (l.kind) {
    case 'dismissed':
      return `${head('片付け', l.kind)}${esc(l.reason ?? '')}</li>`;
    case 'reopened':
      return `${head('開き直し', l.kind)}${esc(l.reason ?? '')}</li>`;
    case 'claimed':
      return `${head('担当', l.kind)}${l.userId ? `→ ${esc(n.user(l.userId))}` : '手放した'} ${esc(l.reason ?? '')}</li>`;
    case 'acknowledged':
      return `${head('名指しを外した', l.kind)}${esc(n.user(l.actorUserId ?? ''))}: ${[...(l.addresses ?? []).map((r) => esc(r.value)), ...(l.list ? ['リスト宛て'] : [])].join(', ')}（${esc(l.untilSignalId)} まで） ${esc(l.reason ?? '')}</li>`;
    case 'linked':
    case 'unlinked':
      return `${head(l.kind === 'linked' ? '結んだ' : '外した', l.kind)}${esc(n.thread(l.otherThreadId!))} [${esc(l.route)}] ${esc(l.reason ?? '')}</li>`;
    case 'mirrored':
      return `${head('写し', l.kind)}${mirrorPairs(dir, t.dataSourceId, l.fields ?? {})
        .map(([k, v]) => `${esc(k)} = ${esc(v)}`)
        .join(' · ')}</li>`;
    case 'overdue':
      return `${head('期限超過', l.kind)}${esc(l.replyExpectedBy)}</li>`;
    case 'note':
      return `${head(l.author?.kind === 'agent' ? `メモ（${esc(l.author.name)}）` : 'メモ', 'note')}${esc(l.body?.slice(0, 140))}${origin}</li>`;
    case 'signal': {
      const s = p.signals[l.signalId!];
      const nr =
        (s?.recorded ? ` · 記録 ${esc(n.user(s.recorded.actorUserId))}${s.recorded.replyExpectedBy ? ` · 返事期待 ${esc(s.recorded.replyExpectedBy)}` : ''}` : '');
      const direction = s ? directionOf(dir, s) : '';
      return `${head(direction === 'inbound' ? '受信' : '送信', direction)}${esc(s?.from.value)}: ${esc(s?.subject ?? '')} — ${esc(s?.body.slice(0, 140))} <small>[${esc(s?.threadedBy)}${nr}]</small>${origin}</li>`;
    }
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#ddd;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--muted:#999;--line:#333;--accent:#7aa2ff}}
body{background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
a{color:var(--accent)} h1{font-size:20px} h2{font-size:16px;margin:0} h3{font-size:14px;margin:16px 0 4px}
small,.comm,.muted,time{color:var(--muted)} nav{margin-bottom:8px}
section{border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
section.dismissed,tr.dismissed{opacity:.6} ol,ul{padding-left:18px} li{margin:4px 0;word-break:break-word}
.k{font-family:ui-monospace,monospace;font-size:12px;color:var(--accent)}
.scroll{overflow-x:auto} table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-weight:600;white-space:nowrap}
</style></head><body>
${body}
</body></html>`;
}

/** 運用者の Viewer: 全データソースの読者として見る（管理画面だけで使う） */
function operator(dir: Directory): Viewer {
  const lists = dir.seed.lists;
  return { userId: '', contactId: null, listIds: lists.map((l) => l.id), dataSourceIds: lists.map((l) => l.dataSourceId) };
}

// ---- リスト一覧 ----

export function renderAdminIndex(dir: Directory, p: Projections, href: Href): string {
  const threads = Object.values(p.threads);
  const rows = dir.seed.lists
    .map((l) => {
      const ds = dir.dataSource(l.dataSourceId);
      const ts = threads.filter((t) => t.dataSourceId === l.dataSourceId);
      const triage = ts.filter((t) => isTriage(dir, t)).length;
      return `<tr><td><a href="${esc(href(`/admin/lists/${l.id}`))}">${esc(ds?.name ?? l.dataSourceId)}</a><br><small>${esc(l.id)}</small></td>
<td>${esc(ds?.channel ?? '')}</td>
<td>${dir.readersOfList(l.id).map((u) => esc(names(dir, p).user(u))).join(', ')}</td>
<td>${ts.filter((t) => !t.dismissed).length} / ${ts.length}</td><td>${triage}</td><td>${ts.filter((t) => replyStateOf(dir, t).overdue).length}</td></tr>`;
    })
    .join('\n');
  return page(
    'Murmur 管理',
    `<h1>リスト一覧 <small>seq ${p.lastSeq} · <a href="${esc(href('/timeline.html'))}">タイムライン</a></small></h1>
<div class="scroll"><table><thead><tr><th>データソース</th><th>種類</th><th>読者</th><th>未片付け / 全部</th><th>仕分け待ち</th><th>期限超過</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">リストはない</td></tr>'}</tbody></table></div>`,
  );
}

// ---- リストのスレッド一覧 ----

export function renderAdminList(dir: Directory, p: Projections, listId: string, href: Href): string | null {
  const list = dir.list(listId);
  if (!list) return null;
  const ds = dir.dataSource(list.dataSourceId);
  const n = names(dir, p);
  const rows = Object.values(p.threads)
    .filter((t) => t.dataSourceId === list.dataSourceId)
    .map((t) => ({ t, at: lastActivityAt(operator(dir), p, t) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.t.id < b.t.id ? -1 : 1))
    .map(({ t }) => t)
    .map(
      (t) => `<tr class="${t.dismissed ? 'dismissed' : ''}"><td><a href="${esc(href(`/admin/threads/${t.id}`))}">${esc(t.title)}</a><br><small>${esc(t.id)} · ${t.signalIds.length} 件</small></td>
<td>担当: ${assigneeLabel(dir, p, t)}<br><small>名指し: ${attentionLabel(dir, p, t)}</small></td>
<td>${t.links.map((l) => `<a href="${esc(href(`/admin/threads/${l.threadId}`))}">${esc(n.thread(l.threadId))}</a> <small>[${esc(l.route)}] ${esc(n.ds(p.threads[l.threadId]?.dataSourceId ?? ''))}</small>`).join('<br>')}</td>
<td>${attrPairs(dir, t).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('<br>')}</td>
<td>${flags(dir, t)}</td><td><time>${esc(lastActivityAt(operator(dir), p, t))}</time></td></tr>`,
    )
    .join('\n');
  return page(
    `${ds?.name ?? listId} — Murmur 管理`,
    `<nav><a href="${esc(href('/admin'))}">リスト一覧</a></nav>
<h1>${esc(ds?.name ?? list.dataSourceId)} <small>${esc(list.id)} · ${esc(ds?.channel ?? '')}</small></h1>
<p class="muted">${esc(ds?.description ?? '')} 読者: ${dir.readersOfList(list.id).map((u) => esc(n.user(u))).join(', ')}</p>
<div class="scroll"><table><thead><tr><th>スレッド</th><th>誰の番</th><th>結び</th><th>属性</th><th>状態</th><th>更新</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">スレッドはまだない</td></tr>'}</tbody></table></div>`,
  );
}

// ---- スレッドの詳細 ----

export function renderAdminThread(dir: Directory, p: Projections, threadId: string, href: Href): string | null {
  const view = getThreadView(dir, operator(dir), p, threadId);
  if (!view) return null;
  const t = p.threads[threadId]!;
  const n = names(dir, p);
  const list = dir.listOfDataSource(t.dataSourceId);
  const threadLink = (id: string) => `<a href="${esc(href(`/admin/threads/${id}`))}">${esc(n.thread(id))}</a>`;
  const links = view.linked
    .map((l) => `<li>${threadLink(l.threadId)} <small>[${esc(l.route)}] ${esc(n.ds(l.dataSourceId ?? ''))} · ${esc(l.linkedAt)} · ${esc(n.user(l.actorUserId))}${l.dismissed ? ' · 片付け済み' : ''}</small></li>`)
    .join('');
  const candidates = view.thread.linkCandidates
    .map((c) => `<li>${threadLink(c.threadId)} <small>${esc(n.ds(c.dataSourceId))} · 一致: ${c.keys.map(esc).join(', ')}</small></li>`)
    .join('');
  const attrs = attrPairs(dir, t)
    .map(([k, v]) => `<li>${esc(k)} = ${esc(v)}</li>`)
    .join('');
  // getThreadView の timeline と同じ並び（このスレッドのログ + 結んだ先のシグナルとメモ）を、ログのまま描く
  const entries = [...t.log.map((l) => ({ ...l, threadId: t.id }))];
  for (const l of t.links) {
    for (const e of p.threads[l.threadId]?.log ?? []) if (e.kind === 'signal' || e.kind === 'note') entries.push({ ...e, threadId: l.threadId });
  }
  const timeline = sortLog(entries)
    .map((e) => logEntry(dir, p, t, e, e.threadId === t.id ? undefined : { threadId: e.threadId, href }))
    .join('');
  return page(
    `${t.title} — Murmur 管理`,
    `<nav><a href="${esc(href('/admin'))}">リスト一覧</a>${list ? ` › <a href="${esc(href(`/admin/lists/${list.id}`))}">${esc(n.ds(t.dataSourceId))}</a>` : ''}</nav>
<h1>${esc(t.title)} <small>${esc(t.id)}</small></h1>
<p class="comm">担当: ${assigneeLabel(dir, p, t)} · 名指し: ${attentionLabel(dir, p, t)}${isAwaiting(dir, t) ? ' · 相手待ち' : ''}${flags(dir, t) ? ` · ${flags(dir, t)}` : ''}</p>
<h3>結び</h3>${links ? `<ul>${links}</ul>` : '<p class="muted">なし</p>'}
<h3>結び候補</h3>${candidates ? `<ul>${candidates}</ul>` : '<p class="muted">なし</p>'}
${attrs ? `<h3>属性</h3><ul>${attrs}</ul>` : ''}
<h3>タイムライン <small>（結んだ先のシグナルも）</small></h3><ol>${timeline}</ol>`,
  );
}

// ---- 全スレッドのタイムライン（timeline.html） ----

export function renderTimeline(dir: Directory, p: Projections): string {
  const n = names(dir, p);
  const threads = Object.values(p.threads).sort((a, b) =>
    a.dataSourceId !== b.dataSourceId ? (a.dataSourceId < b.dataSourceId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
  const sections = threads
    .map(
      (t) => `<section class="thread${t.dismissed ? ' dismissed' : ''}">
  <h2>${esc(t.title)} <small>${esc(t.id)} · ${esc(n.ds(t.dataSourceId))}${t.dismissed ? ` · 片付け済み（${esc(t.dismissReason)}）` : ''}</small></h2>
  <p class="comm">担当: ${assigneeLabel(dir, p, t)} · 名指し: ${attentionLabel(dir, p, t)}${replyStateOf(dir, t).replyExpectedBy ? ` · 返事期待 ${esc(replyStateOf(dir, t).replyExpectedBy)}` : ''}${replyStateOf(dir, t).overdue ? ' · <b>期限超過</b>' : ''}${t.activeSinceDismissed ? ' · <b>片付けたあとに動きあり</b>' : ''}${t.links.length ? ` · 結び: ${t.links.map((l) => esc(n.thread(l.threadId))).join(', ')}` : ''}</p>
  <ol>${t.log.map((l) => logEntry(dir, p, t, l)).join('')}</ol>
</section>`,
    )
    .join('\n');
  return page('Murmur Timeline', `<h1>タイムライン <small>seq ${p.lastSeq}</small></h1>\n${sections || '<p>スレッドはまだない</p>'}`);
}
