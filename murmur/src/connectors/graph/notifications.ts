import { z } from 'zod';
import type { SyncJob } from './jobs';
import type { SubscriptionRecord } from './state';

// Graph の通知とライフサイクルの通知の照合。通知の中身（メールの id）は使わず、どのフォルダに変化があったかだけを取る（正は delta）。
// Teams のチャット（0044）は、本人の全チャットの購読 1 つに通知が集まるので、resource からどのチャットかだけを取る（読むのはチャットの一覧）。

const Notification = z.object({
  subscriptionId: z.string(),
  clientState: z.string().nullable().optional(),
  lifecycleEvent: z.string().optional(),
  resource: z.string().optional(),
});

/** 通知の resource（`chats('<チャットの ID>')/messages('<メッセージの ID>')`。S0）からチャットの ID を取る。チャットでなければ null */
export function chatIdOfResource(resource: string | undefined): string | null {
  const m = /^\/?chats\('([^']+)'\)/.exec(resource ?? '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export const NotificationBody = z.object({ value: z.array(z.record(z.string(), z.unknown())) });

export interface NotificationDeps {
  subscription(id: string): Promise<SubscriptionRecord | null>;
  hash(clientState: string): Promise<string>;
}

/**
 * 照合できた通知だけを仕事にする。知らないサブスクリプション（同意の取り消しのあとに残ったものなど）や
 * clientState の合わないものは捨てる。同じフォルダへの通知はまとめる
 */
export async function jobsFromNotifications(body: unknown, deps: NotificationDeps): Promise<{ jobs: SyncJob[]; rejected: number }> {
  const parsed = NotificationBody.safeParse(body);
  if (!parsed.success) return { jobs: [], rejected: 0 };
  const jobs: SyncJob[] = [];
  let rejected = 0;
  for (const raw of parsed.data.value) {
    const n = Notification.safeParse(raw);
    if (!n.success) {
      rejected++;
      continue;
    }
    const sub = await deps.subscription(n.data.subscriptionId);
    if (!sub || !n.data.clientState || (await deps.hash(n.data.clientState)) !== sub.clientStateHash) {
      rejected++;
      continue;
    }
    const job: SyncJob = n.data.lifecycleEvent
      ? { kind: 'lifecycle', subscriptionId: sub.id, event: n.data.lifecycleEvent }
      : (() => {
          const chatId = chatIdOfResource(n.data.resource);
          return chatId ? { kind: 'sync' as const, dataSourceId: sub.dataSourceId, folder: sub.folder, chatId } : { kind: 'sync' as const, dataSourceId: sub.dataSourceId, folder: sub.folder };
        })();
    if (!jobs.some((j) => JSON.stringify(j) === JSON.stringify(job))) jobs.push(job);
  }
  return { jobs, rejected };
}
