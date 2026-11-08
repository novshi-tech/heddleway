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

/** 実行時に作ったデータソースの取り込みの状態。kind がなければ Outlook（Jira より前の行） */
export interface SourceState {
  kind?: 'outlook' | 'jira' | 'teams' | 'todo';
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
  connectedAt: string;
  /** 最後に全フォルダの delta を終えた時刻 */
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
