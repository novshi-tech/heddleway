import { jwtVerify, SignJWT, type JWTPayload } from "jose";

// One HS256 key signs every token; the audience keeps the kinds apart.
// "appdef" carries an app definition from the admin's confirmation page to the approval.
export type TokenKind = "api" | "session" | "login" | "connect" | "consent" | "appdef";

export const GATEWAY_TOKEN_TTL_SECONDS = 15 * 60;

function key(secret: string): Uint8Array {
  if (!secret || secret.length < 32) throw new Error("SIGNING_KEY must be at least 32 characters");
  return new TextEncoder().encode(secret);
}

function audience(issuer: string, kind: TokenKind): string {
  return `${issuer}/${kind}`;
}

export async function signToken(
  secret: string,
  issuer: string,
  kind: TokenKind,
  subject: string,
  claims: JWTPayload,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience(issuer, kind))
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key(secret));
  return { token, expiresAt };
}

export async function verifyToken<T extends JWTPayload>(
  secret: string,
  issuer: string,
  kind: TokenKind,
  token: string,
): Promise<(T & { sub: string }) | null> {
  try {
    const { payload } = await jwtVerify<T>(token, key(secret), {
      algorithms: ["HS256"],
      issuer,
      audience: audience(issuer, kind),
    });
    if (typeof payload.sub !== "string") return null;
    return payload as T & { sub: string };
  } catch {
    return null;
  }
}

// Claims of a gateway token: which credential to use for each service.
export interface GatewayClaims extends JWTPayload {
  creds: Record<string, string>;
  // Set for a token issued to an app (docs/adr/0008): the proxy lets through only its ports.
  app?: string;
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
