import { createMurmur, type MurmurConfig } from "../murmur/src/feature";
import { GRAPH_SCOPE } from "../murmur/src/connectors/graph/scope";
import { JIRA_SCOPE } from "../murmur/src/connectors/jira/api";
import { GMAIL_SCOPE } from "../murmur/src/connectors/gmail/scope";
import { GTASKS_SCOPE } from "../murmur/src/connectors/gtasks/scope";
import { TEAMS_SCOPE } from "../murmur/src/connectors/teams/scope";
import type { SyncJob } from "../murmur/src/connectors/graph/jobs";
import { CALLBACK_PATH } from "../murmur/src/ports/gateway";
import { publicUrl, splitList } from "./config";
import { featurePort } from "./feature-port";
import { registerFeatures, type Feature } from "./features";

// Part of the Worker's entry: registers Murmur as a feature (docs/adr/0005, Murmur's 0023).
// This file and index.ts are the only ones that import Murmur, and this is the only place
// that hands Murmur anything from the environment: its own bindings and secrets, and the
// gateway's port. Never the gateway's keys.
//
// Murmur is on when the deployment binds MURMUR_DB and sets ANTHROPIC_API_KEY. Its webhooks
// (Graph, Jira) also need MURMUR_WEBHOOK_SECRET.

interface MurmurEnv {
  MURMUR_DB?: D1Database;
  MURMUR_QUEUE?: Queue<SyncJob>;
  ANTHROPIC_API_KEY?: string;
  MURMUR_CLAUDE_MODEL?: string;
  MURMUR_RECENT_THREAD_LIMIT?: string;
  MURMUR_WEBHOOK_SECRET?: string;
  MURMUR_TIMELINE_TOKEN?: string;
  // Services whose spaces may become shared lists (Murmur's 0037), e.g. "jira,teams". None by default.
  MURMUR_SHARED_SERVICES?: string;
  // Gateway services Murmur reads, by kind.
  MURMUR_GRAPH_SERVICE?: string;
  MURMUR_JIRA_SERVICE?: string;
  MURMUR_GMAIL_SERVICE?: string;
  MURMUR_TASKS_SERVICE?: string;
  // Patrol interval of the Google Tasks connector, in minutes. Unset or invalid: every tick (Murmur's 0041).
  MURMUR_TASKS_POLL_MINUTES?: string;
}

const NAME = "murmur";
const DEFAULT_MODEL = "claude-sonnet-5-5";

/** 見回りの間隔（分）。正の整数だけ受け、空・0・負・小数・数字以外は undefined（見回りのたび） */
export function parsePollMinutes(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function murmurFeature(env: Env): Feature | null {
  const m = env as unknown as MurmurEnv;
  if (!m.MURMUR_DB || !m.ANTHROPIC_API_KEY) return null;
  const port = featurePort(env, {
    feature: NAME,
    kinds: {
      graph: { service: m.MURMUR_GRAPH_SERVICE || "graph", scope: GRAPH_SCOPE },
      jira: { service: m.MURMUR_JIRA_SERVICE || "jira", scope: JIRA_SCOPE },
      // Teams channels are read with the same Microsoft Graph credential, through a narrower scope.
      teams: { service: m.MURMUR_GRAPH_SERVICE || "graph", scope: TEAMS_SCOPE },
      gmail: { service: m.MURMUR_GMAIL_SERVICE || "gmail", scope: GMAIL_SCOPE },
      gtasks: { service: m.MURMUR_TASKS_SERVICE || "tasks", scope: GTASKS_SCOPE },
    },
  });
  const config: MurmurConfig = {
    db: m.MURMUR_DB,
    anthropicApiKey: m.ANTHROPIC_API_KEY,
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
  const murmur = createMurmur(config, port.authenticate);
  return {
    name: NAME,
    displayName: "トピック索引",
    consentText:
      "トピック索引は、あなたがつないだメール(Outlook・Gmail)・To Do・Google Tasks のタスク・Teams のチャネル・Jira を読み取り、やりとりをトピックにまとめて、誰の番かを記録します。エージェント(Claude など)が「いまやるべきこと」に答えるときに使います。読むのは、あなたがエージェントに頼んでつないだものだけで、送信や書き込みはしません。",
    consentCallbackPath: CALLBACK_PATH,
    fetch: (request, ctx) => murmur.fetch(request, ctx),
    scheduled: (_controller, ctx) => murmur.scheduled(ctx),
    queue: (batch, ctx) => murmur.queue(batch, ctx),
  };
}

registerFeatures((env) => {
  const murmur = murmurFeature(env);
  return murmur ? [murmur] : [];
});
