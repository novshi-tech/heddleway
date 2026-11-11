// ゲートウェイの口（0023 の決定 2・4・7、段取り 2）。Murmur がゲートウェイに頼むことは、全部この口を通す。
// ここに置くのは型と取り決め（エラーの種類・許可リストの形）だけで、実装は持たない。
// 実装はゲートウェイの中核（heddleway の src/feature-port.ts）。Murmur はゲートウェイの Worker の機能として動く。

/** 取り込みに使うサービスの種類。種類ごとに、ゲートウェイの接続先の名前と読める口が組み立て時に決まる */
export type UpstreamKind = 'graph' | 'jira' | 'teams' | 'gmail' | 'gtasks';

export interface GatewayCredential {
  id: string;
  service: string;
  label?: string;
}

export type UpstreamMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * 本人の接続で上流を 1 回呼ぶ。path は接続先のベース URL からの相対（クエリ込み）。
 * 応答は上流のものをそのまま返す（ゲートウェイ自身のエラーは本文が { error: "..." }）。
 * 読める口（ReadScope）にない呼び出しは送らずに UpstreamRefused で断る
 */
export type UpstreamCall = (
  method: UpstreamMethod,
  path: string,
  init?: { body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

/**
 * 読める口: 読み取りと、取り込みの購読の管理（Graph のサブスクリプション、Jira の動的 Webhook）だけ（0012・0024）。
 * 組み立て時（Worker の入口）に種類ごとに固定して口の実装に渡す。Murmur のコードが呼び出しのたびに広げることはできない
 */
export type ReadScope = ReadonlyArray<readonly [UpstreamMethod, RegExp]>;

/** 照合はパス（クエリ文字列の前）だけで行う。読める口は「どの口か」で決まり、クエリは口を変えない */
export function inScope(scope: ReadScope, method: UpstreamMethod, path: string): boolean {
  const pathname = path.split('?')[0]!;
  return scope.some(([m, re]) => m === method && re.test(pathname));
}

/** 本人の同意（Murmur に取り込みを許すこと）。ゲートウェイの画面で本人が Murmur を有効にする */
export interface ConsentPort {
  /** 同意をもらいに行く URL。state はこちらが覚えておき、戻ってきたときに complete に渡す。secret は口の実装だけが使う */
  begin(userId: string): Promise<{ url: string; state: string; secret: string }>;
  /**
   * 同意の画面から戻ってきた。許可したのが userId 本人かを、kind の接続で確かめてから保管する。
   * - wrong_user: 別の人が許可した
   * - no_credential: 確かめに使う kind の接続がゲートウェイにない
   */
  complete(input: { userId: string; code: string; secret: string; kind: UpstreamKind }): Promise<'ok' | 'wrong_user' | 'no_credential'>;
}

export interface GatewayPort {
  /** 本体の API の Bearer トークンを確かめ、ゲートウェイの User ID を返す。確かめられなければ null */
  authenticate(token: string): Promise<string | null>;
  /** 本人のゲートウェイの接続のうち、kind のサービスのもの。同意がない・取り消されたら ConsentRequired */
  credentials(userId: string, kind: UpstreamKind): Promise<GatewayCredential[]>;
  /** 本人の接続で上流を呼ぶ口。トークンは口の実装の中だけで使い、Murmur には渡さない */
  upstream(userId: string, credentialId: string, kind: UpstreamKind): Promise<UpstreamCall>;
  consent: ConsentPort;
  /** ゲートウェイの画面（接続の登録を案内するとき） */
  readonly homeUrl: string;
  /** ゲートウェイの管理者か（共有リストを外せる。0037 の決定 4） */
  isAdmin(userId: string): Promise<boolean>;
}

/** 読める口にない呼び出し。送る前に断った */
export class UpstreamRefused extends Error {
  constructor(method: string, path: string) {
    super(`not allowed: ${method} ${path}`);
    this.name = 'UpstreamRefused';
  }
}

/** ゲートウェイの外の資格情報の問題（同意の取り消し・つなぎ直しが必要）。データソースを broken にする */
export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

/**
 * 本人の同意がない、または取り消された。もう一度同意してもらう。
 * 資格情報の問題の 1 つなので、取り込みではデータソースを broken にして止める（本人がつなぎ直すと戻る）
 */
export class ConsentRequired extends GatewayAuthError {
  constructor(message = 'トピック索引がゲートウェイで有効になっていない（本人の同意がない）') {
    super(message);
    this.name = 'ConsentRequired';
  }
}

/** 一時的な失敗（試し直せば通るかもしれない） */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** 同意の画面から戻ってくる経路（Murmur の公開の経路の下） */
export const CALLBACK_PATH = '/oauth/callback';
