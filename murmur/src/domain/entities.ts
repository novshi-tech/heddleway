import { z } from 'zod';

// マスタ（イベントではない）。seed.json と DB のマスタテーブルが同じ形を持つ。
// 1 デプロイ = 1 チームなので、テナントのキーは持たない（0020・0021）。

/**
 * 外のサービスのチャネル。個人のメモ（note）は 0039 でなくした。
 * - teams: Microsoft Teams のチャネル（0036）。アドレスの値は <tenantId>/<Entra のオブジェクト ID>
 * - todo: タスクのサービス（To Do・Google Tasks。0039）。アドレスの値は本人のアカウント
 */
export const Channel = z.enum(['email', 'slack', 'line', 'jira', 'bitbucket', 'teams', 'todo']);
export type Channel = z.infer<typeof Channel>;

/** チャネルと値だけのアドレス（Contact に属さない。イベント・データソースの窓口・資格情報が持つ） */
export const AddressRef = z.object({ channel: Channel, value: z.string() });
export type AddressRef = z.infer<typeof AddressRef>;

/** 資格情報の主体 */
export const Principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  /** このデプロイのチーム（0020・0021）。共有のデータソースはチームの資格情報で取る（0013） */
  z.object({ kind: z.literal('team') }),
]);
export type Principal = z.infer<typeof Principal>;

/** ゲートウェイの User と 1:1。このデプロイ（チーム）の Contact は 1 つまで */
export const User = z.object({ id: z.string(), name: z.string() });
export type User = z.infer<typeof User>;

/**
 * 連絡の相手（0030）。アドレスを束ねたもので、人か会社の窓口かボットかは区別しない。
 * 自分も Contact の 1 つで、User に結ばれている。userId を持たない Contact がゴースト。
 */
export const Contact = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string().optional(),
  /** 外部マスタ（bm-next・board・freee など）へのポインタの束 */
  externalRefs: z.record(z.string(), z.string()).default({}),
});
export type Contact = z.infer<typeof Contact>;

/** まとめて消えた Contact の ID と、まとめ先（0030 の 9）。イベントに残る古い ID をクエリ層が読み替える */
export const ContactAlias = z.object({ id: z.string(), contactId: z.string() });
export type ContactAlias = z.infer<typeof ContactAlias>;

export const Address = z.object({
  id: z.string(),
  channel: Channel,
  value: z.string(),
  contactId: z.string(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
});
export type Address = z.infer<typeof Address>;

export const CredentialRef = z.object({
  id: z.string(),
  principal: Principal,
  /** 資格情報のアカウントのアドレス */
  address: AddressRef,
  /** ゲートウェイ側の資格情報の識別子（プロトでは未使用） */
  gatewayCredentialId: z.string().optional(),
});
export type CredentialRef = z.infer<typeof CredentialRef>;

/**
 * 取り込みの経路（0024）。なければダミーコネクタ（チャネルで選ぶ）。
 * - graph-mail: Outlook のメールボックス。本人の委任（ゲートウェイの OAuth）で読む個人の箱。
 * - jira: Jira のサイトの、本人の JQL の範囲の課題（0034）。
 *   folders は delta とサブスクリプションの単位（Graph のよく知られたフォルダ名）
 */
export const SourceConnector = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('graph-mail'),
    mailbox: z.literal('me'),
    folders: z.array(z.string()).min(1).default(['inbox', 'sentitems']),
  }),
  /**
   * Jira（0034・0037）。プロジェクト単位の共有リスト（projectKey があるもの）。範囲の JQL はプロジェクトから決まる。
   * projectKey のないものは、0037 より前の本人の JQL の範囲の個人リスト（もう作らない。消すまで動く）。
   * cloudId は Atlassian のサイトの ID（API は /ex/jira/<cloudId>/...）、site はサイトの URL（表示用）
   */
  z.object({
    kind: z.literal('jira'),
    cloudId: z.string().min(1),
    site: z.string().min(1),
    jql: z.string().min(1),
    projectKey: z.string().min(1).optional(),
  }),
  /** Teams のチャネル（0036・0037）。共有リスト。読者はチャネルのメンバーから写す */
  z.object({
    kind: z.literal('teams'),
    teamId: z.string().min(1),
    channelId: z.string().min(1),
  }),
  /** Microsoft To Do のタスクのリスト（0039）。本人の委任で読む個人リスト。listName は写しの statusLabel に使う */
  z.object({
    kind: z.literal('graph-todo'),
    listId: z.string().min(1),
    listName: z.string().min(1),
  }),
  /** Google Tasks のタスクのリスト（0041）。見回り（updatedMin）で読む個人リスト。形は To Do と同じ */
  z.object({
    kind: z.literal('google-tasks'),
    listId: z.string().min(1),
    listName: z.string().min(1),
  }),
]);
export type SourceConnector = z.infer<typeof SourceConnector>;

/**
 * データソース（0014）。リスト 1 つに対応する。どれも外のサービス（メールボックス、Slack のチャネルや DM、LINE 公式アカウント、
 * Jira のプロジェクト、タスクのサービスのリスト）で、資格情報で取り込み、selfAddresses（窓口のアドレス）と読者の Contact のアドレスが
 * 「こちら」（0030。クエリ層の sides.ts）。個人のメモ（kind: notes）は 0039 でなくした。kind は 'service' だけが残る
 */
export const DataSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('service'),
    id: z.string(),
    channel: Channel,
    name: z.string(),
    description: z.string().default(''),
    credentialRefId: z.string(),
    /** 窓口のアドレス（共有メールボックス・LINE 公式アカウント・Jira のサイトなど）。個人の箱では空でよい */
    selfAddresses: z.array(AddressRef).default([]),
    /** グループのチャネル。区切りの「同じ相手」がチャネルになる */
    group: z.boolean().default(false),
    /** 取り込みの経路。実行時に作ったデータソースが持つ（0024） */
    connector: SourceConnector.optional(),
    /**
     * 共有リスト（0037）。スペース（Teams・Slack のチャネル、Jira のプロジェクト）に 1 つで、読者はソースから写す。
     * 資格情報はつないだ人の委任（principal は user）。ないものは今までどおり（個人の資格情報なら読者は本人だけ）
     */
    shared: z
      .object({
        /** スペースを表す鍵（例 teams:<team>/<channel>、jira:<cloudId>/<projectKey>）。同じ鍵のデータソースは 1 つ */
        spaceKey: z.string().min(1),
        /** 作った人の User（外せるのは作った人と管理者） */
        createdBy: z.string().min(1),
      })
      .optional(),
  }),
]);
export type DataSource = z.infer<typeof DataSource>;
export type ServiceDataSource = Extract<DataSource, { kind: 'service' }>;

/** データソース 1 つに 1 つ。可視性の単位 */
export const List = z.object({ id: z.string(), dataSourceId: z.string() });
export type List = z.infer<typeof List>;

/** リストの読者。見えるかどうかは User で決める（0030。ゴーストが読者になることはない） */
export const ListMember = z.object({ listId: z.string(), userId: z.string() });
export type ListMember = z.infer<typeof ListMember>;

export const Seed = z.object({
  users: z.array(User),
  contacts: z.array(Contact),
  contactAliases: z.array(ContactAlias).default([]),
  addresses: z.array(Address),
  credentialRefs: z.array(CredentialRef).default([]),
  dataSources: z.array(DataSource).default([]),
  lists: z.array(List).default([]),
  listMembers: z.array(ListMember).default([]),
});
export type Seed = z.infer<typeof Seed>;

export type SeedInput = z.input<typeof Seed>;
