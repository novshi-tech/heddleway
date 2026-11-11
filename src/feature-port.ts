import {
  ConsentRequired,
  GatewayAuthError,
  scopeTarget,
  UpstreamRefused,
  type GatewayCredential,
  type GatewayPort,
  type ReadScope,
  type UpstreamCall,
  type UpstreamKind,
} from "../murmur/src/ports/gateway";
import { publicUrl, splitList } from "./config";
import { randomToken } from "./crypto";
import { IDENTITY_CREDENTIAL } from "./identity";
import { denied, forward, upstreamFetcher } from "./proxy";
import { getUpstream } from "./services";
import { signToken, verifyToken, type GatewayClaims } from "./tokens";
import { vaultFor } from "./vault";

// The gateway core's side of a feature's port (docs/adr/0005; Murmur's murmur/src/ports/gateway.ts).
// Only the contract is imported from the feature, never its implementation.
//
// The feature gets functions, not secrets: upstream() keeps the user's credential inside the
// gateway and refuses any call outside the read scope fixed by the entry, so a bug in the
// feature cannot send mail or file an issue. Everything is the user's own credential and
// only after the user turned the feature on (consent).

const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"];

export const CONSENT_CODE_TTL_SECONDS = 5 * 60;

export interface FeaturePortOptions {
  feature: string;
  // Per kind: the gateway service the feature reads and what it may call there. Fixed by the entry.
  kinds: Record<UpstreamKind, { service: string; scope: ReadScope }>;
}

export function featurePort(env: Env, opts: FeaturePortOptions): GatewayPort {
  const base = publicUrl(env);
  const { feature, kinds } = opts;
  const vault = (userId: string) => vaultFor(env, userId);
  const requireConsent = async (userId: string) => {
    if (!(await vault(userId).consented(feature))) throw new ConsentRequired();
  };

  return {
    homeUrl: `${base}/`,

    // Admins are listed by user ID in ADMINS, as for the gateway's own admin pages.
    async isAdmin(userId) {
      return splitList(env.ADMINS).includes(userId);
    },

    // The stand's gateway token, as issued by issue_token for `identity:<feature>`.
    async authenticate(token) {
      const claims = await verifyToken<GatewayClaims>(env.SIGNING_KEY, base, "api", token);
      return claims && claims.creds?.[feature] === IDENTITY_CREDENTIAL ? claims.sub : null;
    },

    async credentials(userId, kind): Promise<GatewayCredential[]> {
      await requireConsent(userId);
      return (await vault(userId).list())
        .filter((c) => c.service === kinds[kind].service)
        .map(({ id, service, label }) => ({ id, service, label }));
    },

    async upstream(userId, credentialId, kind): Promise<UpstreamCall> {
      await requireConsent(userId);
      const { service, scope } = kinds[kind];
      const info = await vault(userId).get(credentialId);
      if (!info || info.service !== service) throw new GatewayAuthError(`unknown credential: ${credentialId}`);
      if (info.needsReconnect) throw new GatewayAuthError(`credential ${credentialId} must be reconnected by the user at ${base}/`);
      const target = await getUpstream(env, service);
      if (!target) throw new GatewayAuthError(`unknown service: ${service}`);

      return async (method, path, init = {}) => {
        // 照合したのと同じ URL だけを送る（照合と送るパスが別物にならないように scopeTarget が URL を返す）
        const url = scopeTarget(scope, method, path);
        if (!url) throw new UpstreamRefused(method, path);
        // The vault is asked on every call, so a refresh or a reconnect is picked up as for the stand.
        const result = await vault(userId).headers(credentialId, target);
        if ("error" in result) {
          if (result.error === "missing") return denied(403, "credential no longer exists");
          if (result.error === "reconnect") return denied(403, `credential must be reconnected by the user at ${base}/`);
          if (result.error === "no_value") return denied(502, `credential has no value for ${result.field}`);
          return denied(502, "could not refresh the upstream access token; try again later");
        }
        const headers = new Headers(init.headers);
        // 上流に別のメソッドとして扱わせるヘッダーは渡さない（GET に見せて書き込みをさせられないように）
        for (const name of METHOD_OVERRIDE_HEADERS) headers.delete(name);
        if (init.body !== undefined) headers.set("content-type", "application/json");
        const request = new Request(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
        return forward(request, target.config, upstreamFetcher(env, target.config), url.pathname, result.headers, {
          caller: feature,
          user: userId,
          credential: credentialId,
          service,
        });
      };
    },

    consent: {
      // The user turns the feature on at the gateway's own page, signed in as themselves.
      async begin() {
        const state = randomToken();
        return { url: `${base}/features/${feature}/consent?state=${encodeURIComponent(state)}`, state, secret: "" };
      },
      // `code` is what the consent page signed for the signed-in user.
      async complete({ userId, code, kind }) {
        const claims = await verifyToken<{ feature?: string }>(env.SIGNING_KEY, base, "consent", code);
        if (!claims || claims.feature !== feature || claims.sub !== userId) return "wrong_user";
        if (!(await vault(userId).consented(feature))) return "wrong_user";
        return (await vault(userId).list()).some((c) => c.service === kinds[kind].service) ? "ok" : "no_credential";
      },
    },
  };
}

// Signed by the consent page once the user turned the feature on; the feature checks it in complete().
export async function consentCode(env: Env, feature: string, userId: string): Promise<string> {
  const { token } = await signToken(env.SIGNING_KEY, publicUrl(env), "consent", userId, { feature }, CONSENT_CODE_TTL_SECONDS);
  return token;
}
