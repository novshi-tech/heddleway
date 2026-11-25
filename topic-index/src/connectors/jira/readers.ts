import type { SpaceMember } from '../../domain';
import { JiraError, type JiraApi, type JiraBrowser } from './api';

// Jira の共有リストの読者（0037 の決定 2）: プロジェクトを閲覧できるアカウントのうち、人（atlassian）で有効なもの。
// アプリのアカウントは読者にしない。対応（accountId → User）は本人の名乗り（myself）で付いたものだけを使う（ドメインの syncSharedReaders）

export function jiraMembers(browsers: readonly JiraBrowser[]): SpaceMember[] {
  return browsers.filter((b) => b.accountType === 'atlassian' && b.active).map((b) => ({ address: { channel: 'jira', value: b.accountId } }));
}

/** 読者の同期の間隔（見回りのたびには読まない） */
export const READERS_SYNC_MINUTES = 60;

export type JiraReaders = { ok: true; members: SpaceMember[] } | { ok: false; reason: string };

/**
 * プロジェクトの読者を、self（この Jira の接続の本人）の権限で読む。一覧が当てにならなければ ok: false で、読者は変えない:
 * - Jira が断った（403 など。ゲートウェイの同意の問題 GatewayAuthError はそのまま投げる）
 * - 本人が一覧に載っていない（「ユーザーとグループの閲覧」の権限がないと空が返る。本人が閲覧できなくなったかどうかは呼び出し側が確かめる）
 */
export async function readJiraReaders(api: JiraApi, cloudId: string, projectKey: string, selfAccountId: string): Promise<JiraReaders> {
  let browsers: JiraBrowser[];
  try {
    browsers = await api.browsers(cloudId, projectKey);
  } catch (err) {
    if (err instanceof JiraError) return { ok: false, reason: err.message };
    throw err;
  }
  if (!browsers.some((b) => b.accountId === selfAccountId)) return { ok: false, reason: 'self_not_listed' };
  return { ok: true, members: jiraMembers(browsers) };
}
