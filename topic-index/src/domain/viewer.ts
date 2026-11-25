import type { Directory } from './directory';

/**
 * Viewer = User → 読者になっているリスト（0030。Contact を通らない）。
 * スタンドはユーザーと同一権限で働くので、ゲートウェイから伝搬された User からそのまま導出する。
 * contactId は本人の Contact（担当と名指しの判定と送り主に使う。なければ null）。
 */
export interface Viewer {
  userId: string;
  contactId: string | null;
  /** 読者になっているリストと、そのデータソース */
  listIds: string[];
  dataSourceIds: string[];
}

export function deriveViewer(dir: Directory, userId: string): Viewer {
  const contact = dir.contactOfUser(userId);
  const lists = dir
    .listIdsOfUser(userId)
    .map((id) => dir.list(id))
    .filter((l) => l !== undefined);
  return { userId, contactId: contact?.id ?? null, listIds: lists.map((l) => l.id), dataSourceIds: lists.map((l) => l.dataSourceId) };
}

export function canReadDataSource(viewer: Viewer, dataSourceId: string): boolean {
  return viewer.dataSourceIds.includes(dataSourceId);
}
