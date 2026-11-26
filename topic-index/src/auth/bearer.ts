// 本体の API のトークンの取り出し（純関数）。確かめるのはゲートウェイの口（ports/gateway.ts の authenticate）。

/** `Authorization: Bearer <token>` からトークンを取り出す */
export function bearerToken(header: string | undefined | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}
