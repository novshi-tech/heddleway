import { z } from 'zod';

// Google Tasks（Tasks API v1 の task・taskList）と userinfo の部分スキーマ。写しに使う項目だけを読み、ほかは捨てる（0041）。

export const GtasksTask = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  /** needsAction / completed */
  status: z.string().optional(),
  /** RFC 3339（'2026-11-20T00:00:00.000Z'）。Google は期限の日付を UTC の 0 時として持ち、時刻に意味はない */
  due: z.string().nullable().optional(),
  completed: z.string().nullable().optional(),
  /** 最後に変わった時刻（RFC 3339）。差分の cursor と写しの識別子に使う */
  updated: z.string().min(1),
  deleted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** サブタスクの親のタスクの ID。親子は写さない（0041 の決定 3） */
  parent: z.string().nullable().optional(),
  // notes（本文）は写さない。links（Gmail から作ったタスクのメールへのリンクなど）はアンカーにしない（0041 未決 3）
});
export type GtasksTask = z.infer<typeof GtasksTask>;

export const GtasksTaskList = z.object({
  id: z.string().min(1),
  title: z.string(),
  updated: z.string().optional(),
});
export type GtasksTaskList = z.infer<typeof GtasksTaskList>;

/** 名前のないリスト（title が空）に付ける名前。データソースの listName は空にできない */
export const UNNAMED_LIST = '(名前のないリスト)';

/** Murmur 側のリスト名（空や空白だけなら、名前のないリスト用の名前） */
export function listDisplayName(title: string): string {
  return title.trim() || UNNAMED_LIST;
}

/** items は空のとき省かれる。項目は 1 件ずつ検証する（読めない 1 件で全体を落とさない） */
export const GtasksTasksPage = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() });
export type GtasksTasksPage = z.infer<typeof GtasksTasksPage>;

export const GtasksListsPage = z.object({ items: z.array(GtasksTaskList).optional(), nextPageToken: z.string().optional() });

/** userinfo（oauth2/v3/userinfo）。スコープ userinfo.email で email と email_verified が返る */
export const GoogleUserinfo = z.object({
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});
export type GoogleUserinfo = z.infer<typeof GoogleUserinfo>;

/** 本人のアカウントのアドレス。email があり、確認済み（email_verified が true）のときだけ。それ以外は空（つなげない） */
export function verifiedEmail(info: GoogleUserinfo): string {
  const verified = info.email_verified === true || info.email_verified === 'true';
  return verified ? (info.email?.trim() ?? '') : '';
}
