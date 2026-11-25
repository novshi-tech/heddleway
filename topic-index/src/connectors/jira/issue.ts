import { z } from 'zod';

// Jira Cloud の REST（v3）の部分スキーマ。取り込みに使う項目だけを読み、ほかは捨てる（0034）。
// 形は 2026-11-04 の S0 で実物を見て決めた（docs/research/2026-11-04-jira-s0.md）。

const User = z.object({ accountId: z.string(), displayName: z.string().optional(), accountType: z.string().optional() });

/** Atlassian Document Format。本文はテキストとメンションだけ使う */
export type Adf = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Adf[] };
export const Adf: z.ZodType<Adf> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      content: z.array(Adf).optional(),
    })
    .passthrough(),
);

export const JiraIssue = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string().nullable().optional(),
    status: z
      .object({ name: z.string(), statusCategory: z.object({ key: z.string() }).optional() })
      .nullable()
      .optional(),
    assignee: User.nullable().optional(),
    reporter: User.nullable().optional(),
    duedate: z.string().nullable().optional(),
    created: z.string().optional(),
    updated: z.string(),
    description: Adf.nullable().optional(),
  }),
});
export type JiraIssue = z.infer<typeof JiraIssue>;

export const JiraComment = z.object({
  id: z.string(),
  author: User.nullable().optional(),
  body: Adf.nullable().optional(),
  created: z.string(),
  updated: z.string().optional(),
});
export type JiraComment = z.infer<typeof JiraComment>;

export const SearchPage = z.object({
  issues: z.array(JiraIssue),
  nextPageToken: z.string().nullable().optional(),
  isLast: z.boolean().optional(),
});
export type SearchPage = z.infer<typeof SearchPage>;

export const CommentPage = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  comments: z.array(JiraComment),
});
export type CommentPage = z.infer<typeof CommentPage>;

/** 検索で取る項目（写しと起票のシグナルに要るものだけ。コメントは課題ごとに別に取る。検索の応答は 20 件で切れる） */
export const SEARCH_FIELDS = ['summary', 'status', 'assignee', 'reporter', 'duedate', 'created', 'updated', 'description'] as const;
