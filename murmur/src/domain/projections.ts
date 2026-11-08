import type { AddressRef, Anchors, Author, FileRef, LinkRoute, MirrorFields, ThreadedBy } from './events';
import type { Channel } from './entities';

/** スレッドのログの位置（時刻・seq の順。sortLog と同じ） */
export interface LogPos {
  signalId: string;
  at: string;
  seq: number;
}

/**
 * アドレスへの名指し（0038 の決定 2）。アドレスごとに、最後に名指しされたシグナルと、外した位置を持つ。
 * fold はアドレスだけで畳む（マスタを読まない）。リスト宛て（窓口のアドレス）かどうか・読者かどうかはクエリ層が決める
 */
export interface Naming {
  address: AddressRef;
  /** 最後に名指ししたシグナル */
  last: LogPos;
  /** 名指しした送り主（最後のシグナルの） */
  from: AddressRef;
  /** 外した位置（いちばん後ろ）と外した User。last がこれより後ろなら、名指しが残っている */
  ackedThrough: (LogPos & { userId: string }) | null;
}

/** 名指しの状態（0038）。スレッドのログだけから決まる */
export interface AttentionState {
  /** アドレスごとの名指し（アドレスの順） */
  named: Naming[];
  /** 宛先のないシグナル（グループのチャネルではリスト宛て。クエリ層が決める） */
  broadcasts: (LogPos & { from: AddressRef })[];
  /** リスト宛ての名指しを外した位置（User ごと） */
  listAcks: Record<string, LogPos>;
}

/** 通信状態。綴じたシグナルのアドレス・担当する操作・名指しを外す操作・片付けだけから導出される（comm.ts） */
export interface CommState {
  attention: AttentionState;
  dismissed: boolean;
  dismissedAt: string | null;
  dismissReason: string | null;
  /** 片付けたあとにシグナルが来た（Murmur は自動で開き直さない。事実だけ返す） */
  activeSinceDismissed: boolean;
  /** 担当する操作（ThreadClaimed）の担当。手放せば null。状態を持つソースでは使わない（0038 の決定 1） */
  ownerUserId: string | null;
  /** 返事期待（記録した送信だけが持つ）。続いているかは、その送信の宛先の名指しからクエリ層が決める（turn.ts の replyStateOf。0038） */
  replyExpectedBy: string | null;
  replyExpectedSignalId: string | null;
  /** 返事期待の期限を過ぎた（ReplyOverdue がいまの返事期待を指している）。返事期待が続いているかはクエリ層が決める */
  overdue: boolean;
  /** ソースの側で完了している（写しの closed）。片付けと同じく、どの見え方にも数えない */
  closedAtSource: boolean;
  /** ソースの側で完了した時刻（完了の写しを受けた時刻）。開いていれば null */
  closedAtSourceAt: string | null;
}

/** signal = データソースのシグナル、note = メモ（ThreadNoted。名指しを作らない。0039）、mirrored = 状態の写し、acknowledged = 名指しを外した */
export type ThreadLogKind =
  | 'signal'
  | 'note'
  | 'dismissed'
  | 'reopened'
  | 'claimed'
  | 'linked'
  | 'unlinked'
  | 'mirrored'
  | 'overdue'
  | 'acknowledged';

/** スレッドに綴じたもの（シグナルと、人とスタンドの操作。メモも操作の 1 つ）。通信状態の導出とタイムラインの入力 */
export interface ThreadLogEntry {
  seq: number;
  at: string;
  kind: ThreadLogKind;
  signalId?: string;
  /** signal: 送り主と宛先 */
  from?: AddressRef;
  to?: AddressRef[];
  /** signal（送信の記録）: 返事期待の期限 */
  replyExpectedBy?: string | null;
  reason?: string;
  /** 操作した User（シグナル以外） */
  actorUserId?: string;
  /** claimed: 持ち主（null は手放した） */
  userId?: string | null;
  /** linked / unlinked: 相手のスレッドと経路 */
  otherThreadId?: string;
  route?: LinkRoute;
  /** note: メモの ID・本文・書き手（0039 の決定 2） */
  noteId?: string;
  body?: string;
  author?: Author;
  /** mirrored: 変わった写しの項目 */
  fields?: MirrorFields;
  /** acknowledged: 外したアドレス・リスト宛てか・どのシグナルまでか */
  addresses?: AddressRef[];
  list?: boolean;
  untilSignalId?: string;
  /** acknowledged: 外した位置（外したときのシグナルの時刻と seq。あとでシグナルを移し替えても位置は変わらない） */
  untilAt?: string;
  untilSeq?: number;
}

/** 写しのうち、スレッドの他の項目に入らないもの（0031 の 6） */
export interface SourceState {
  /** ソースの担当（アカウントのアドレスの値。0031 の 6。状態を持つソースの担当。0038 の決定 1） */
  holders: string[];
  statusLabel: string | null;
  due: string | null;
}

/** 他のスレッドへの辺（無向）。両端のスレッドに同じものが載る */
export interface ThreadLink {
  threadId: string;
  route: LinkRoute;
  linkedAt: string;
  actorUserId: string;
}

/** エンティティはスレッドの 1 種類（0014）。データソースの写し */
export interface Thread extends CommState {
  id: string;
  dataSourceId: string;
  title: string;
  /** 時刻順（データソースのシグナルだけ。メモは log に載る） */
  signalIds: string[];
  log: ThreadLogEntry[];
  /** 結んだスレッド（threadId 順） */
  links: ThreadLink[];
  /** ソースの状態の写し（ThreadMirrored）。写しを受けたことがなければ null。完了は closedAtSource、件名は title に入る */
  source: SourceState | null;
  /** 写しのソースの区切り（課題キー）。写しでできたスレッドを課題キーで引くため */
  sourceKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignalRecord {
  signalId: string;
  dataSourceId: string;
  channel: Channel;
  from: AddressRef;
  to: AddressRef[];
  subject?: string;
  body: string;
  anchors: Anchors;
  attachments: FileRef[];
  sourceRef: string;
  at: string;
  seq: number;
  /** 送信の記録（OutboundRecorded）。観測だけのシグナルは null */
  recorded: { actorUserId: string; at: string; replyExpectedBy: string | null; sourceThreadId: string | null } | null;
  /** 最新の SignalThreaded で置かれたスレッド */
  threadId: string | null;
  threadedBy: ThreadedBy | null;
}

export interface Projections {
  lastSeq: number;
  threads: Record<string, Thread>;
  signals: Record<string, SignalRecord>;
  /** 重複排除とアンカー解決の索引。キーは `<dataSourceId>|<値>` */
  index: {
    sourceRefs: Record<string, string>;
    messageIds: Record<string, string>;
  };
}

/** fold で base から変わったもの。スレッドとシグナルは消えないので、保存は変わった行の upsert で足りる */
export interface ProjectionChanges {
  threadIds: string[];
  signalIds: string[];
  /** 索引（sourceRefs・messageIds）が変わった */
  index: boolean;
}

export function emptyProjections(): Projections {
  return { lastSeq: 0, threads: {}, signals: {}, index: { sourceRefs: {}, messageIds: {} } };
}

export function indexKey(dataSourceId: string, value: string): string {
  return `${dataSourceId}|${value}`;
}
