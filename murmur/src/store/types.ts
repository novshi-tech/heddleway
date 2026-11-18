import type { DomainEvent, DraftEvent, MasterChange, ProjectionChanges, Projections, Seed, WorkingSetRequest } from '../domain';

export class ConcurrencyError extends Error {
  constructor(expected: number) {
    super(`concurrent append (expected last seq ${expected})`);
    this.name = 'ConcurrencyError';
  }
}

/** append-only のイベントストア。単調な seq（1 デプロイ = 1 チームで 1 本、0021） */
export interface EventStore {
  /**
   * expectedLastSeq の直後に追記する。他の書き込みが先にあれば ConcurrencyError（楽観ロック）。
   * at は全イベント共通の記録時刻。
   */
  append(expectedLastSeq: number, drafts: readonly DraftEvent[], at: string): Promise<DomainEvent[]>;
  read(afterSeq?: number): Promise<DomainEvent[]>;
}

/** 投影の保存先。fold の結果をそのまま置き、いつでも消して作り直せる */
export interface ProjectionStore {
  /** 返す投影は読むだけ（凍っていることがある。畳むときは fold がコピーする） */
  load(): Promise<Projections | null>;
  /**
   * changes を渡せば、保存済みの投影に変わったスレッド・シグナル（と索引）だけを書く（0021）。
   * 渡さなければ丸ごと入れ替える（作り直しのとき）。保存したあと、p は書き換えない（保存先がそのまま写しとして凍らせて持つことがある）
   */
  save(p: Projections, changes?: ProjectionChanges, opts?: { partial?: boolean }): Promise<void>;
  clear(): Promise<void>;
  /**
   * 取り込みの作業範囲（0046）。保存済みの投影から、依頼の範囲だけを返す（意味は `selectWorkingSet`）。保存済みの投影がなければ null。
   * 返す投影は読むだけ。作業範囲の上で畳んだものを保存するときは `{ partial: true }` を渡す（全件の写しとして持たない）。
   * 持たない保存先は、呼び手が全件（load）を使う
   */
  workingSet?(req: WorkingSetRequest): Promise<Projections | null>;
  /**
   * データソースの中で、すでに取り込んだシグナルの sourceRef（重複排除の索引にあるもの）。コネクタがまとめて読んだものを、
   * 1 件ずつ取り込む前に落とすため（`prepareInbound` の duplicate と同じ判定）。持たない保存先は、呼び手が 1 件ずつ確かめる
   */
  knownSourceRefs?(dataSourceId: string, refs: readonly string[]): Promise<Set<string>>;
  /** 期限の見回り（planOverdue）の作業範囲。返事期待の期限が before より前のスレッドだけ（意味は `selectOverdueSet`）。保存済みの投影がなければ null */
  overdueSet?(before: string): Promise<Projections | null>;
}

/** 変更の記録の 1 行（0030 の 5。マスタはその場で書き換えるので、誰がいつ何を変えたかはここに残す） */
export interface MasterChangeRecord extends MasterChange {
  id: number;
  at: string;
  /** 変えた User（管理者のスクリプトなど、User でなければ null） */
  actorUserId: string | null;
  reason: string | null;
}

export interface MasterStore {
  /** 返すマスタは読むだけ（凍っていることがある。書き換えは planMasterEdit がコピーしてから） */
  loadSeed(): Promise<Seed>;
  /** マスタを丸ごと入れ替える（seed 投入用。変更の記録は残さない） */
  replaceSeed(seed: Seed): Promise<void>;
  /** 差分を当て、同じ書き込みで変更の記録に残す */
  applyChanges(changes: readonly MasterChange[], meta: { at: string; actorUserId: string | null; reason?: string }): Promise<void>;
  /** 変更の記録（古い順） */
  changeLog(): Promise<MasterChangeRecord[]>;
}

export interface Repo {
  events: EventStore;
  projections: ProjectionStore;
  master: MasterStore;
}
