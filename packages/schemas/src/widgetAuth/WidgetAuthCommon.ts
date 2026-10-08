import z from "zod";
import type { CompanyConnectionEnvironmentIntEnum } from "../companyConnections";

// DEV_NOTE: The companion JWT's aud. A platform constant, never stored per connection: a host signs every widget
// token for this audience, so a token minted for another service (same issuer, other aud) is rejected.
export const WIDGET_JWT_AUDIENCE = "diletta-widget";

// DEV_NOTE: Signature algorithms a host may sign the companion JWT with (plan open question #7). Asymmetric only:
// "none" and every HS* fail the allowlist, so a token can't skip the signature or pass a public key off as an
// HMAC secret.
export enum WidgetJwtAlgorithmEnum {
  RS256 = "RS256",
  ES256 = "ES256",
}

// DEV_NOTE: WebSocket close codes the widget acts on. 4xxx mirrors the HTTP status: 4401 = token rejected (the
// widget may fetch a fresh token and reconnect), 4403 = not allowed (origin, disabled connection, churned or
// paused company, paused chatbot: reconnecting won't help), 4404 = unknown chatbot, 4408 = no auth message in
// time. 1011 = server error.
export enum WidgetCloseCodeEnum {
  BadRequest = 4400,
  Unauthorized = 4401,
  Forbidden = 4403,
  NotFound = 4404,
  AuthTimeout = 4408,
  ServerError = 1011,
}

// DEV_NOTE: Why WidgetAuthRepo.authenticate failed. The route maps each to a close code; the reason is logged,
// while the widget gets only the code and a generic message, so a caller can't probe which check failed.
export enum WidgetAuthFailureEnum {
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  ServerError = "ServerError",
}

export const WIDGET_AUTH_FAILURE_CLOSE_CODE_MAP: Record<
  WidgetAuthFailureEnum,
  WidgetCloseCodeEnum
> = {
  [WidgetAuthFailureEnum.Unauthorized]: WidgetCloseCodeEnum.Unauthorized,
  [WidgetAuthFailureEnum.Forbidden]: WidgetCloseCodeEnum.Forbidden,
  [WidgetAuthFailureEnum.NotFound]: WidgetCloseCodeEnum.NotFound,
  [WidgetAuthFailureEnum.ServerError]: WidgetCloseCodeEnum.ServerError,
};

// JOSE header of the companion JWT. kid is required: it picks the key out of the issuer's JWKS.
export const ZWidgetJwtHeader = z.object({
  alg: z.enum(WidgetJwtAlgorithmEnum),
  kid: z.string().min(1),
  typ: z.string().optional(),
});
export type WidgetJwtHeader = z.infer<typeof ZWidgetJwtHeader>;

// DEV_NOTE: Companion JWT claims {sub, roles, exp ≤ 5m} signed by the host backend. iss picks the
// company_connections row, so a company claim is ignored. aud may be a string or an array (RFC 7519 §4.1.3).
// name becomes chatbot_users.display_name (PII, never logged).
export const ZWidgetJwtClaims = z.object({
  iss: z.string().min(1),
  sub: z.string().trim().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  roles: z.array(z.string()).optional(),
  name: z.string().optional(),
});
export type WidgetJwtClaims = z.infer<typeof ZWidgetJwtClaims>;

// DEV_NOTE: One public key from the issuer's JWKS (RFC 7517). Loose: issuers publish extra members (x5c, x5t…),
// which are kept but never read. Private members (d, p, q…) are never imported: the key is rebuilt from the
// public members only.
export const ZJwk = z.looseObject({
  kty: z.string(),
  kid: z.string().optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
});
export type Jwk = z.infer<typeof ZJwk>;

export const ZJwks = z.object({
  keys: z.array(ZJwk),
});
export type Jwks = z.infer<typeof ZJwks>;

// DEV_NOTE: The JWKS_CACHE KV value per issuer. fetchedAt (epoch ms) rate-limits the refetch an unknown kid
// triggers, so a stream of tokens with made-up kids can't hammer the host's JWKS endpoint.
export const ZCachedJwks = ZJwks.extend({
  fetchedAt: z.number().int(),
});
export type CachedJwks = z.infer<typeof ZCachedJwks>;

// DEV_NOTE: A companion JWT split into its parts. signingInput is the ASCII bytes of "<header>.<payload>", which
// the signature covers; signature is the decoded third part.
export interface DecodedWidgetJwt {
  header: WidgetJwtHeader;
  claims: WidgetJwtClaims;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

// DEV_NOTE: Server-side only — the verified widget caller. Carries internal ids (companyId, connectionId,
// chatbotId), so it never goes to the widget; the Conversation DO (M2-2) takes it as the session identity.
export interface WidgetIdentity {
  companyId: string;
  connectionId: string;
  connectionEnvironment: CompanyConnectionEnvironmentIntEnum;
  chatbotId: string;
  chatbotPublicId: string;
  chatbotName: string;
  hostUserId: string;
  displayName: string | null;
  roles: string[];
  tokenExpiresAt: Date;
}
