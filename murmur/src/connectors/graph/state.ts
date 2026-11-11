// 取り込みの運用の状態（0024 の決定 2）。台帳（スレッドの事実）ではないのでイベントにせず、D1 のテーブルに置く。
// リプレイ（H1）の対象外。

export type SourceStatus = 'setup' | 'ok' | 'broken' | 'disconnected';

/** フォルダごとの delta の位置。link は次に読む nextLink か deltaLink（どちらもなければ最初から） */
export interface FolderCursor {
  link: string | null;
  /** 取り込んだ最後のメールの受信時刻（deltaLink が無効になったときの取り直しの起点） */
  lastReceivedAt: string | null;
}

/**
 * Jira の取り込みの位置（0034 の決定 3）。syncedUntil までの更新は取り込んだ（次の JQL の起点。重なりを足して取り直す）。
 * Webhook は本人ごとに 1 つの URL に、データソースごとに登録する（S0: REST の Webhook の URL は本人ごとに 1 つ）
 */
export interface JiraCursor {
  syncedUntil: string;
  webhookIds: number[];
  webhookExpiresAt: string | null;
  /** 共有リストの読者を最後にソースから写した時刻（0037） */
  readersSyncedAt?: string;
  /** 登録したときの受け口の URL の SHA-256（URL は秘密を含むので平文は持たない）。今のと違えば登録し直す（0023 の段取り 4）。古い記録にはない */
  webhookUrlHash?: string;
  /**
   * ページの上限で止めた差分の続き。同じ JQL（startedAt と keys で決まる）の検索のページの位置から再開する。
   * 読み終えるまで syncedUntil は進めない
   */
  resume?: { startedAt: string; keys: string[]; batch: number; nextPageToken: string | null };
}

/** Teams のチャネルの取り込みの位置（0036）。syncedUntil までに動いたものは取り込んだ（次の走査は重なりを足して読む） */
export interface TeamsCursor {
  syncedUntil: string;
  /** 共有リストの読者を最後にソースから写した時刻（0037） */
  readersSyncedAt?: string;
}

/**
 * Google Tasks の取り込みの位置（0041）。変更の通知がなく、見回りで updatedMin の差分を読む。
 * updatedMin は読み切った最後の見回りで見えた一番新しい updated（RFC 3339。なければ最初から読む）
 */
export interface GtasksCursor {
  updatedMin: string | null;
  /**
   * ページの上限で止めた読みかけ。同じ updatedMin の一覧の pageToken から続ける。読み切るまで updatedMin は進めない
   * （Google はタスクを更新順に返さないので、途中の updated まで進めると読んでいない分を飛ばす）。maxUpdated は読んだ分の一番新しい updated
   */
  resume?: { pageToken: string; maxUpdated: string | null } | null;
  /** リストの名前を最後に確かめた時刻（名前の変更を拾う。通知がないので間引く） */
  listCheckedAt?: string | null;
}

/**
 * Gmail の取り込みの位置（0041）。変更の通知がなく、見回りで履歴（history.list）を読む。
 * historyId は読み終えた履歴の位置（次の見回りの startHistoryId）。つないだ直後に最初に取る
 */
export interface GmailCursor {
  /** 次の見回りの startHistoryId。つないだ直後（まだ取っていない）は null */
  historyId: string | null;
  /**
   * 位置が切れた（startHistoryId が古すぎて 404）ときの拾い直しの途中。nextHistoryId は拾い直しを始めたときの箱の最新の historyId
   * （読み終えたらこれから続ける）、after は検索の起点（エポック秒）、pageToken は次に読む検索のページ。
   * 拾い直しが終わるまで historyId は進めない（読んでいないメールを飛ばさない）
   */
  recovery?: { nextHistoryId: string; after: number; pageToken: string | null } | null;
}

/** 実行時に作ったデータソースの取り込みの状態。kind がなければ Outlook（Jira より前の行） */
export interface SourceState {
  kind?: 'outlook' | 'jira' | 'teams' | 'todo' | 'gtasks' | 'gmail';
  dataSourceId: string;
  /** 個人の箱の本人（ゲートウェイの User） */
  userId: string;
  gatewayCredentialId: string;
  status: SourceStatus;
  /** broken・disconnected の理由 */
  reason: string | null;
  /** Outlook: フォルダごとの delta の位置。To Do: タスクのリストの ID ごとの delta の位置（lastReceivedAt は最後に取り込んだタスクの更新時刻）。Jira では空 */
  folders: Record<string, FolderCursor>;
  /** Jira: 取り込みの位置と Webhook */
  jira?: JiraCursor;
  /** Teams: 取り込みの位置 */
  teams?: TeamsCursor;
  /** Google Tasks: 取り込みの位置（見回りの最後の読み切りの時刻は lastSyncAt） */
  gtasks?: GtasksCursor;
  /** Gmail: 取り込みの位置（見回りの最後の読み切りの時刻は lastSyncAt） */
  gmail?: GmailCursor;
  connectedAt: string;
  /** 最後に全フォルダの delta を終えた時刻（Google Tasks: 見回りでリストを最後まで読み終えた時刻。間隔の判定に使う） */
  lastSyncAt: string | null;
  /** 最後に broken から試し直した時刻 */
  lastRetryAt: string | null;
}

export interface SubscriptionRecord {
  /** Graph のサブスクリプションの ID */
  id: string;
  dataSourceId: string;
  folder: string;
  /** clientState の SHA-256（平文は持たない） */
  clientStateHash: string;
  expiresAt: string;
  /** 作ったときの通知先。今の通知先と違えば作り直す（デプロイの形を変えて URL が変わったとき。0023 の段取り 4）。古い記録にはない */
  notificationUrl?: string;
}
