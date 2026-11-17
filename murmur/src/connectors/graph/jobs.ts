import { z } from 'zod';

// 取り込みのキュー（Cloudflare Queues、同時実行 1）に積む仕事。Outlook と Jira で共有する（setup・maintain・disconnect は両方が受け、自分の経路のデータソースだけ扱う）。ゲートウェイを呼ぶのは全部ここを通すので、
// リフレッシュトークンの入れ替わりも delta の cursor も直列になる（0024 の決定 2）。

export const SyncJob = z.discriminatedUnion('kind', [
  /** Cron: 全データソースのサブスクリプションの手入れと、保険の delta */
  z.object({ kind: z.literal('maintain') }),
  /** つないだ直後・broken からの戻り: サブスクリプションを作り、delta の初回を読み流す */
  z.object({ kind: z.literal('setup'), dataSourceId: z.string() }),
  /**
   * 変更の通知: そのフォルダの delta。Teams のチャット（0044）は、通知の resource から取ったチャットの ID を chatId に持ち、
   * そのチャットだけを読む（なければチャットの一覧を見回る）
   */
  z.object({ kind: z.literal('sync'), dataSourceId: z.string(), folder: z.string(), chatId: z.string().optional() }),
  z.object({ kind: z.literal('lifecycle'), subscriptionId: z.string(), event: z.string() }),
  /** 本人が外した: サブスクリプション（Jira は Webhook）を消す */
  z.object({ kind: z.literal('disconnect'), dataSourceId: z.string() }),
  /** Jira（0034）: 通知か見回り。範囲の差分を JQL で取り直す */
  z.object({ kind: z.literal('jira-sync'), dataSourceId: z.string() }),
]);
export type SyncJob = z.infer<typeof SyncJob>;

export interface SyncQueue {
  send(job: SyncJob): Promise<void>;
}
