import type { OAuth2Auth, ServiceConfig, Services } from "./config";

// Services every deployment can offer. SERVICES adds to these and overrides one by
// using its name. An OAuth service is offered only once its client's
// OAUTH_<CLIENT>_CLIENT_ID / _CLIENT_SECRET are set (see README).

function google(display_name: string, base_url: string, scope: string): ServiceConfig {
  const auth: OAuth2Auth = {
    type: "oauth2",
    client: "google",
    authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scope,
    // A refresh token is issued only with offline access, and again only with consent.
    authorize_params: { access_type: "offline", prompt: "consent" },
  };
  return { display_name, provider: "Google", base_url, auth };
}

const GRAPH_SCOPE = [
  "offline_access",
  "User.Read",
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Chat.ReadWrite",
  "ChannelMessage.Send",
  "ChannelMessage.Read.All",
  // Members of a channel: Murmur's Teams shared lists copy their readers from it (Murmur's 0036・0037).
  "ChannelMember.Read.All",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  // To Do: Murmur reads a task list as a personal list, and the stand creates and updates tasks (Murmur's 0039).
  "Tasks.ReadWrite",
].join(" ");

// User token scopes: reading conversations and people, searching, and writing as the user.
const SLACK_USER_SCOPE = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
  "users:read.email",
  "team:read",
  "search:read",
  "files:read",
  "reactions:read",
  "reactions:write",
  "chat:write",
].join(",");

const JIRA_SCOPE = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "manage:jira-webhook",
  "read:me",
  "offline_access",
].join(" ");

// Granular scopes only: the v2 API takes only these, and the v1 endpoints still used (CQL search,
// attachment upload and download) accept them too. Classic scopes (e.g. readonly:content.attachment:confluence)
// are not listed on the app's Granular scopes tab, and Atlassian refuses the authorization for them.
const CONFLUENCE_SCOPE = [
  "read:space:confluence",
  "read:page:confluence",
  "write:page:confluence",
  "read:hierarchical-content:confluence",
  "read:comment:confluence",
  "write:comment:confluence",
  "read:attachment:confluence",
  "write:attachment:confluence",
  "read:label:confluence",
  "write:label:confluence",
  "read:content-details:confluence",
  "read:me",
  "offline_access",
].join(" ");

// X API v2 as the connected user: reading and posting, likes, bookmarks, reading follows, reading
// and managing lists, and
// uploading media for a post. offline.access is what makes X issue a refresh token. Direct
// messages are left out; a deployment that needs them overrides `x` in SERVICES with dm.read / dm.write.
const X_SCOPE = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "follows.read",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "list.read",
  "list.write",
  "media.write",
  "offline.access",
].join(" ");

export function catalog(env: Env): Services {
  const services: Services = {
    freee: {
      provider: "freee",
      base_url: "https://api.freee.co.jp",
      auth: {
        type: "oauth2",
        client: "freee",
        authorization_url: "https://accounts.secure.freee.co.jp/public_api/authorize",
        token_url: "https://accounts.secure.freee.co.jp/public_api/token",
      },
    },
    gmail: google("Gmail", "https://gmail.googleapis.com", "https://www.googleapis.com/auth/gmail.modify"),
    drive: google("Google Drive", "https://www.googleapis.com", "https://www.googleapis.com/auth/drive"),
    calendar: google(
      "Google Calendar",
      "https://www.googleapis.com",
      "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy",
    ),
    docs: google("Google Docs", "https://docs.googleapis.com", "https://www.googleapis.com/auth/documents"),
    analytics: google("Google Analytics (Data API)", "https://analyticsdata.googleapis.com", "https://www.googleapis.com/auth/analytics.readonly"),
    "analytics-admin": google(
      "Google Analytics (Admin API)",
      "https://analyticsadmin.googleapis.com",
      "https://www.googleapis.com/auth/analytics.readonly",
    ),
    // Read and write: Murmur reads a task list as a personal list, and the stand creates and completes tasks (Murmur's 0041).
    tasks: google("Google Tasks", "https://tasks.googleapis.com", "https://www.googleapis.com/auth/tasks"),
    // A user token: Slack puts it under `authed_user` and takes its scopes as `user_scope`.
    // It does not expire unless the app turns on token rotation.
    slack: {
      display_name: "Slack",
      provider: "Slack",
      base_url: "https://slack.com/api",
      auth: {
        type: "oauth2",
        client: "slack",
        authorization_url: "https://slack.com/oauth/v2/authorize",
        token_url: "https://slack.com/api/oauth.v2.access",
        scope: SLACK_USER_SCOPE,
        scope_param: "user_scope",
        token_key: "authed_user",
        refresh_scope: false,
      },
    },
    // Atlassian Cloud OAuth 2.0 (3LO). Calls go to /ex/jira/<cloudid>/...; the cloud ID comes
    // from /oauth/token/accessible-resources. Refresh tokens rotate.
    jira: {
      display_name: "Jira",
      provider: "Atlassian",
      base_url: "https://api.atlassian.com",
      auth: {
        type: "oauth2",
        client: "atlassian",
        authorization_url: "https://auth.atlassian.com/authorize",
        token_url: "https://auth.atlassian.com/oauth/token",
        scope: JIRA_SCOPE,
        authorize_params: { audience: "api.atlassian.com", prompt: "consent" },
        refresh_scope: false,
      },
    },
    // The same Atlassian app as Jira, connected separately. Calls go to /ex/confluence/<cloudid>/wiki/...
    confluence: {
      display_name: "Confluence",
      provider: "Atlassian",
      base_url: "https://api.atlassian.com",
      auth: {
        type: "oauth2",
        client: "atlassian",
        authorization_url: "https://auth.atlassian.com/authorize",
        token_url: "https://auth.atlassian.com/oauth/token",
        scope: CONFLUENCE_SCOPE,
        authorize_params: { audience: "api.atlassian.com", prompt: "consent" },
        refresh_scope: false,
      },
    },
    board: {
      display_name: "board",
      base_url: "https://api.the-board.jp",
      auth: {
        type: "headers",
        headers: [
          { name: "x-api-key", label: "board の API キー" },
          { name: "authorization", label: "board の API トークン", prefix: "Bearer " },
        ],
      },
    },
    gbizinfo: {
      display_name: "gBizINFO",
      base_url: "https://api.info.gbiz.go.jp",
      auth: { type: "headers", headers: [{ name: "X-hojinInfo-api-token", label: "gBizINFO の API トークン" }] },
    },
    // OAuth 2.0 with PKCE. X takes a confidential client's ID and secret only as Basic at the token
    // endpoint. Access tokens last two hours; refresh tokens rotate on each use.
    x: {
      display_name: "X",
      provider: "X",
      base_url: "https://api.x.com",
      auth: {
        type: "oauth2",
        client: "x",
        authorization_url: "https://x.com/i/oauth2/authorize",
        token_url: "https://api.x.com/2/oauth2/token",
        scope: X_SCOPE,
        client_auth: "basic",
        refresh_scope: false,
      },
    },
    serper: {
      display_name: "Serper",
      base_url: "https://google.serper.dev",
      auth: { type: "headers", headers: [{ name: "X-API-KEY", label: "Serper の API キー" }] },
    },
  };
  // Graph's sign-in URLs name the Entra tenant, so it is offered only once that is set.
  const tenant: string | undefined = env.MICROSOFT_TENANT_ID;
  if (tenant) {
    services.graph = {
      display_name: "Microsoft Graph",
      provider: "Microsoft",
      base_url: "https://graph.microsoft.com",
      auth: {
        type: "oauth2",
        client: "microsoft",
        authorization_url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
        token_url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        scope: GRAPH_SCOPE,
      },
    };
  }
  return services;
}
