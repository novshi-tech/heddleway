import { GatewayAuthError } from '../../src/ports/gateway';
import { JiraError, type JiraApi, type JiraBrowser, type JiraMe, type JiraProject, type JiraSite, type JiraWebhookSpec, type WebhookRegistration } from '../../src/connectors/jira/api';
import { CommentPage, JiraComment, JiraIssue, SearchPage } from '../../src/connectors/jira/issue';

/**
 * Jira の偽物（本人の 3LO の接続）。課題とコメントを持ち、検索は JQL の「updated >= -Nm」だけを読む（範囲の条件は見ない）。
 * Webhook は S0 の実物と同じく、jqlFilter に watcher があれば断り、URL は本人ごとに 1 つ
 */
export class FakeJira implements JiraApi {
  readonly issues = new Map<string, JiraIssue>();
  readonly commentsByKey = new Map<string, JiraComment[]>();
  readonly webhooks = new Map<number, { url: string; spec: JiraWebhookSpec; expiresAt: string }>();
  readonly calls: string[] = [];
  readonly jqls: string[] = [];
  pageSize = 2;
  authBroken = false;
  /** 本人が見えるプロジェクト */
  projectList: JiraProject[] = [{ key: 'SPW', name: 'スポット作業' }];
  /** プロジェクトを閲覧できるアカウント（人とアプリ） */
  browserList: JiraBrowser[] = [
    { accountId: 'acct-bob', accountType: 'atlassian', active: true },
    { accountId: 'acct-app', accountType: 'app', active: true },
  ];
  private webhookSeq = 0;

  constructor(
    readonly now: () => string,
    readonly siteList: JiraSite[] = [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }],
    readonly me: JiraMe = { accountId: 'acct-bob', displayName: 'Bob' },
  ) {}

  put(issue: unknown, comments: unknown[] = []) {
    const i = JiraIssue.parse(issue);
    this.issues.set(i.key, i);
    this.commentsByKey.set(i.key, comments.map((c) => JiraComment.parse(c)));
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.authBroken) throw new GatewayAuthError('credential must be reconnected');
  }

  async sites() {
    this.check('sites');
    return this.siteList;
  }

  async myself(cloudId: string) {
    this.check(`myself ${cloudId}`);
    return this.me;
  }

  async projects(cloudId: string) {
    this.check(`projects ${cloudId}`);
    return this.projectList;
  }

  async browsers(cloudId: string, projectKey: string) {
    this.check(`browsers ${projectKey}`);
    return this.browserList;
  }

  async search(cloudId: string, jql: string, nextPageToken?: string) {
    this.check(`search ${cloudId}`);
    this.jqls.push(jql);
    const m = jql.match(/updated >= -(\d+)m ORDER BY updated ASC$/);
    if (!m) throw new JiraError(400, `unexpected jql: ${jql}`);
    const from = Date.parse(this.now()) - Number(m[1]) * 60_000;
    const hits = [...this.issues.values()]
      .filter((i) => Date.parse(i.fields.updated.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= from)
      .sort((a, b) => a.fields.updated.localeCompare(b.fields.updated));
    const start = nextPageToken ? Number(nextPageToken) : 0;
    const page = hits.slice(start, start + this.pageSize);
    const next = start + this.pageSize < hits.length ? String(start + this.pageSize) : undefined;
    return SearchPage.parse({ issues: page, ...(next ? { nextPageToken: next } : {}), isLast: !next });
  }

  async comments(cloudId: string, key: string, startAt = 0) {
    this.check(`comments ${key}`);
    const all = [...(this.commentsByKey.get(key) ?? [])].sort((a, b) => b.created.localeCompare(a.created));
    return CommentPage.parse({ startAt, maxResults: 2, total: all.length, comments: all.slice(startAt, startAt + 2) });
  }

  async registerWebhooks(cloudId: string, url: string, specs: JiraWebhookSpec[]): Promise<WebhookRegistration[]> {
    this.check('registerWebhooks');
    const other = [...this.webhooks.values()].find((w) => w.url !== url);
    return specs.map((spec) => {
      if (other) return { errors: [`Only a single URL per user is allowed to be registered via REST API. The currently used URL: ${other.url}`] };
      if (/\bwatcher\b/.test(spec.jqlFilter)) return { errors: ['Clause watcher is unsupported'] };
      const id = ++this.webhookSeq;
      this.webhooks.set(id, { url, spec, expiresAt: this.after(30) });
      return { id };
    });
  }

  async refreshWebhooks(cloudId: string, ids: number[]) {
    this.check('refreshWebhooks');
    const live = ids.filter((id) => this.webhooks.has(id));
    if (live.length === 0) return null;
    const expiresAt = this.after(30);
    for (const id of live) this.webhooks.get(id)!.expiresAt = expiresAt;
    return expiresAt;
  }

  async deleteWebhooks(cloudId: string, ids: number[]) {
    this.check('deleteWebhooks');
    for (const id of ids) this.webhooks.delete(id);
  }

  private after(days: number) {
    return new Date(Date.parse(this.now()) + days * 86_400_000).toISOString();
  }
}
