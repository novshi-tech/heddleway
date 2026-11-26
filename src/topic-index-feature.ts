import { createTopicIndex, type TopicIndexConfig } from "../topic-index/src/feature";
import { GRAPH_SCOPE } from "../topic-index/src/connectors/graph/scope";
import { JIRA_SCOPE } from "../topic-index/src/connectors/jira/api";
import { GMAIL_SCOPE } from "../topic-index/src/connectors/gmail/scope";
import { GTASKS_SCOPE } from "../topic-index/src/connectors/gtasks/scope";
import { GOOGLE_CHAT_DM_SCOPE, GOOGLE_CHAT_SCOPE } from "../topic-index/src/connectors/google-chat/scope";
import { LINE_SCOPE } from "../topic-index/src/connectors/line/scope";
import { TEAMS_SCOPE } from "../topic-index/src/connectors/teams/scope";
import { TEAMS_CHAT_SCOPE } from "../topic-index/src/connectors/teams-chat/scope";
import type { SyncJob } from "../topic-index/src/connectors/graph/jobs";
import { CALLBACK_PATH } from "../topic-index/src/ports/gateway";
import { publicUrl, splitList } from "./config";
import { featurePort } from "./feature-port";
import { registerFeatures, type Feature } from "./features";

// Part of the Worker's entry: registers the topic index as a feature (docs/adr/0005, the topic index's 0023).
// This file and index.ts are the only ones that import the topic index, and this is the only place
// that hands the topic index anything from the environment: its own bindings and secrets, and the
// gateway's port. Never the gateway's keys.
//
// The topic index is on when the deployment binds MURMUR_DB and either sets ANTHROPIC_API_KEY or sets
// MURMUR_THREADING=source (threading by the sources' own threads, no AI; the topic index's 0050). Its webhooks
// (Graph, Jira) also need MURMUR_WEBHOOK_SECRET.

interface TopicIndexEnv {
  MURMUR_DB?: D1Database;
  MURMUR_QUEUE?: Queue<SyncJob>;
  ANTHROPIC_API_KEY?: string;
  MURMUR_CLAUDE_MODEL?: string;
  // "source": thread by the sources' own threads without AI, so no Anthropic key is needed (the topic index's 0050).
  // Lists that cannot be threaded that way (Teams chats, Google Chat DMs and unthreaded spaces, LINE) are refused. Unset: AI.
  MURMUR_THREADING?: string;
  MURMUR_RECENT_THREAD_LIMIT?: string;
  MURMUR_WEBHOOK_SECRET?: string;
  MURMUR_TIMELINE_TOKEN?: string;
  // Services whose spaces may become shared lists (the topic index's 0037), e.g. "jira,teams". None by default.
  MURMUR_SHARED_SERVICES?: string;
  // Gateway services the topic index reads, by kind.
  MURMUR_GRAPH_SERVICE?: string;
  MURMUR_JIRA_SERVICE?: string;
  MURMUR_GMAIL_SERVICE?: string;
  MURMUR_TASKS_SERVICE?: string;
  MURMUR_CHAT_SERVICE?: string;
  // The front system that keeps the LINE Official Account's messages (the topic index's 0049). Default bm-next.
  MURMUR_BM_NEXT_SERVICE?: string;
  // Patrol interval of the Google Tasks connector, in minutes. Unset or invalid: every tick (the topic index's 0041).
  MURMUR_TASKS_POLL_MINUTES?: string;
}

const NAME = "topic-index";
// Its name until 2026-11 (docs/adr/0009): old plugins, bookmarks, app ports and webhooks registered upstream still use it.
const FORMER_NAMES = ["murmur"];
const DEFAULT_MODEL = "claude-sonnet-5-5";

/** 見回りの間隔（分）。正の整数だけ受け、空・0・負・小数・数字以外は undefined（見回りのたび） */
export function parsePollMinutes(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function topicIndexFeature(env: Env): Feature | null {
  const m = env as unknown as TopicIndexEnv;
  const threading = m.MURMUR_THREADING?.trim() === "source" ? "source" : "ai";
  if (!m.MURMUR_DB || (threading === "ai" && !m.ANTHROPIC_API_KEY)) return null;
  const port = featurePort(env, {
    feature: NAME,
    formerNames: FORMER_NAMES,
    kinds: {
      graph: { service: m.MURMUR_GRAPH_SERVICE || "graph", scope: GRAPH_SCOPE },
      jira: { service: m.MURMUR_JIRA_SERVICE || "jira", scope: JIRA_SCOPE },
      // Teams channels are read with the same Microsoft Graph credential, through a narrower scope.
      teams: { service: m.MURMUR_GRAPH_SERVICE || "graph", scope: TEAMS_SCOPE },
      // The user's own Teams chats (the topic index's 0044): the same credential, through its own narrow scope.
      "teams-chat": { service: m.MURMUR_GRAPH_SERVICE || "graph", scope: TEAMS_CHAT_SCOPE },
      gmail: { service: m.MURMUR_GMAIL_SERVICE || "gmail", scope: GMAIL_SCOPE },
      gtasks: { service: m.MURMUR_TASKS_SERVICE || "tasks", scope: GTASKS_SCOPE },
      // Google Chat (the topic index's 0045): spaces as shared lists and the user's DMs as a personal list, one credential, two scopes.
      "google-chat": { service: m.MURMUR_CHAT_SERVICE || "chat", scope: GOOGLE_CHAT_SCOPE },
      "google-chat-dm": { service: m.MURMUR_CHAT_SERVICE || "chat", scope: GOOGLE_CHAT_DM_SCOPE },
      // LINE Official Account (the topic index's 0049): read from the front system that keeps it, through GET-only GraphQL.
      line: { service: m.MURMUR_BM_NEXT_SERVICE || "bm-next", scope: LINE_SCOPE },
    },
  });
  const config: TopicIndexConfig = {
    db: m.MURMUR_DB,
    threading,
    anthropicApiKey: threading === "ai" ? m.ANTHROPIC_API_KEY : undefined,
    claudeModel: m.MURMUR_CLAUDE_MODEL || DEFAULT_MODEL,
    recentThreadLimit: m.MURMUR_RECENT_THREAD_LIMIT ? Number(m.MURMUR_RECENT_THREAD_LIMIT) : undefined,
    webhookSecret: m.MURMUR_WEBHOOK_SECRET,
    timelineToken: m.MURMUR_TIMELINE_TOKEN,
    queue: m.MURMUR_QUEUE,
    sharedServices: splitList(m.MURMUR_SHARED_SERVICES),
    tasksPollMinutes: parsePollMinutes(m.MURMUR_TASKS_POLL_MINUTES),
    connectors: m.MURMUR_WEBHOOK_SECRET
      ? { publicUrl: `${publicUrl(env)}/${NAME}`, gateway: port, webhookKey: m.MURMUR_WEBHOOK_SECRET }
      : undefined,
  };
  const topicIndex = createTopicIndex(config, port.authenticate);
  return {
    name: NAME,
    formerNames: FORMER_NAMES,
    displayName: "トピック索引",
    consentText:
      "トピック索引は、あなたがつないだメール(Outlook・Gmail)・To Do・Google Tasks のタスク・Teams のチャネルとチャット・Google Chat のスペースとチャット・Jira・LINE 公式アカウント(業務システムが受けたもの)を読み取り、やりとりをトピックにまとめて、誰が担当か・誰に見てほしいと届いたかを記録します。エージェント(Claude など)が「いまやるべきこと」に答えるときに使います。読むのは、あなたがエージェントに頼んでつないだものだけで、送信や書き込みはしません。",
    consentCallbackPath: CALLBACK_PATH,
    userPage: {
      linkText: "今やること・参加中のリストを見る",
      render: (userId, page, ctx) => topicIndex.userPage(userId, page, ctx),
      isHome: (userId) => topicIndex.isHome(userId),
    },
    fetch: (request, ctx) => topicIndex.fetch(request, ctx),
    scheduled: (_controller, ctx) => topicIndex.scheduled(ctx),
    queue: (batch, ctx) => topicIndex.queue(batch, ctx),
  };
}

registerFeatures((env) => {
  const topicIndex = topicIndexFeature(env);
  return topicIndex ? [topicIndex] : [];
});
