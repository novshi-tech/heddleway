import type { AddressRef, InboundItem, InboundMirror, InboundSignal, MirrorFields } from '../../domain';
import type { Adf, JiraComment, JiraIssue } from './issue';

// Jira の課題とコメント → InboundItem（純関数。0034 の決定 4）。
// - 課題の今の状態は、0031 の決まった形の写し（変わっていない項目は planMirror が捨てる）
// - 起票とコメントはシグナル。状態の変更はシグナルにしない（担当は担当者の写しで決まる）
// - アドレスは jira チャネルの accountId。向きはコアがアドレスで決めるので、ここでは決めない
// - messageId は、スタンドが記録した起票（sent_ref = 課題キー）とコメント（<課題キー>#c<ID>）と同じ形（H5）

/** 時刻を UTC の ISO にそろえる（Jira は +0900 のようなオフセット付きで返す） */
export function toUtc(at: string): string {
  // Jira のオフセットはコロンなし（+0900）。Date が読める形に直す
  const fixed = at.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(fixed);
  if (Number.isNaN(ms)) throw new Error(`not a timestamp: ${at}`);
  return new Date(ms).toISOString();
}

/** 課題の今の状態 → 写し */
export function mirrorOf(dataSourceId: string, issue: JiraIssue): InboundMirror {
  const f = issue.fields;
  const fields: MirrorFields = {
    closed: f.status?.statusCategory?.key === 'done',
    holders: f.assignee ? [f.assignee.accountId] : [],
    statusLabel: f.status?.name ?? null,
    due: f.duedate ?? null,
  };
  if (f.summary) fields.title = f.summary;
  return { kind: 'mirror', dataSourceId, channel: 'jira', threadKey: issue.key, fields, sourceRef: `jira:${issue.key}@${toUtc(f.updated)}` };
}

/** 起票 → シグナル。宛先は担当者（起票した本人は除く） */
export function createdSignal(dataSourceId: string, issue: JiraIssue): InboundSignal | null {
  const f = issue.fields;
  if (!f.reporter || !f.created) return null;
  const from = account(f.reporter.accountId);
  const to = f.assignee && f.assignee.accountId !== f.reporter.accountId ? [account(f.assignee.accountId)] : [];
  const body = adfText(f.description).trim();
  return {
    dataSourceId,
    channel: 'jira',
    from,
    to,
    subject: `[${issue.key}] ${f.summary ?? ''}`.trim(),
    body,
    anchors: { messageId: issue.key, threadKey: issue.key, ...refs(body, issue.key) },
    sourceRef: `jira:${issue.key}`,
    occurredAt: toUtc(f.created),
  };
}

/** コメント → シグナル。宛先はメンションした人だけ（書いた本人は除く）。メンションがなければ宛先なし（0038 の未決 3） */
export function commentSignal(dataSourceId: string, issue: JiraIssue, comment: JiraComment): InboundSignal | null {
  if (!comment.author) return null;
  const author = comment.author.accountId;
  const to = mentions(comment.body).filter((id) => id !== author);
  const body = adfText(comment.body).trim();
  const ref = `${issue.key}#c${comment.id}`;
  return {
    dataSourceId,
    channel: 'jira',
    from: account(author),
    ...(comment.author.displayName?.trim() ? { fromName: comment.author.displayName.trim() } : {}),
    to: to.map(account),
    subject: `[${issue.key}] ${issue.fields.summary ?? ''}`.trim(),
    body,
    anchors: { messageId: ref, threadKey: issue.key, ...refs(body, issue.key) },
    sourceRef: `jira:${ref}`,
    occurredAt: toUtc(comment.created),
  };
}

/**
 * 更新された課題 1 件 → 取り込む順の InboundItem。写しが先、シグナルが後（写しが先でもスレッドはできる。0031 の 8）。
 * since より前の起票・コメントは取らない（つなぐ前の過去は取らない。重なりの分は sourceRef の重複排除で落ちる）
 */
export function itemsOfIssue(dataSourceId: string, issue: JiraIssue, comments: readonly JiraComment[], since: string): InboundItem[] {
  const items: InboundItem[] = [mirrorOf(dataSourceId, issue)];
  if (issue.fields.created && toUtc(issue.fields.created) >= since) {
    const s = createdSignal(dataSourceId, issue);
    if (s) items.push(s);
  }
  const fresh = comments.filter((c) => toUtc(c.created) >= since).sort((a, b) => toUtc(a.created).localeCompare(toUtc(b.created)) || Number(a.id) - Number(b.id));
  for (const c of fresh) {
    const s = commentSignal(dataSourceId, issue, c);
    if (s) items.push(s);
  }
  return items;
}

function account(accountId: string): AddressRef {
  return { channel: 'jira', value: accountId };
}

/** ADF の本文をテキストに（段落は改行、メンションは @名前、リンクやカードは URL） */
export function adfText(doc: Adf | null | undefined): string {
  if (!doc) return '';
  const out: string[] = [];
  const walk = (n: Adf) => {
    switch (n.type) {
      case 'text':
        out.push(n.text ?? '');
        return;
      case 'hardBreak':
        out.push('\n');
        return;
      case 'mention':
        out.push(String(n.attrs?.text ?? `@${String(n.attrs?.id ?? '')}`));
        return;
      case 'inlineCard':
      case 'blockCard':
        out.push(String(n.attrs?.url ?? ''));
        return;
      case 'emoji':
        out.push(String(n.attrs?.text ?? n.attrs?.shortName ?? ''));
        return;
    }
    for (const c of n.content ?? []) walk(c);
    if (n.type && BLOCKS.has(n.type)) out.push('\n');
  };
  walk(doc);
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule', 'tableRow', 'panel']);

/** ADF のメンションの accountId（重複なし、出てきた順） */
export function mentions(doc: Adf | null | undefined): string[] {
  const ids: string[] = [];
  const walk = (n: Adf) => {
    if (n.type === 'mention' && typeof n.attrs?.id === 'string' && !ids.includes(n.attrs.id)) ids.push(n.attrs.id);
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return ids;
}

/** 本文で触れている課題キー（自分は除く）と PR（結び候補。区切りには使わない） */
function refs(text: string, self: string): { jiraKeys?: string[]; prRefs?: string[] } {
  const keys = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1]!))].filter((k) => k !== self);
  const prs = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?(?:github\.com\/([\w.-]+\/[\w.-]+)\/pull|bitbucket\.org\/([\w.-]+\/[\w.-]+)\/pull-requests)\/(\d+)/g)) {
    prs.add(`${m[1] ?? m[2]}#${m[3]}`);
  }
  return { ...(keys.length ? { jiraKeys: keys } : {}), ...(prs.size ? { prRefs: [...prs] } : {}) };
}
