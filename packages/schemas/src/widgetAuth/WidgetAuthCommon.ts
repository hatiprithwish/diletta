import { z } from "zod";
import type { CompanyConnectionEnvironmentIntEnum } from "../companyConnections";
import { ConversationStartFailureEnum } from "../conversations/ConversationsResponse";

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

// DEV_NOTE: The widget's WebSocket subprotocol (ADR 0001). The widget offers ['diletta.v1', <companion JWT>] in
// Sec-WebSocket-Protocol: the JWT never goes in the URL (URLs land in logs and history), and the server answers with
// 'diletta.v1' only, so the token is never echoed back.
export const WIDGET_SUBPROTOCOL = "diletta.v1";

// DEV_NOTE: Why WidgetAuthRepo.authenticate (or the conversation lookup that follows it) failed. The route answers the
// upgrade with the mapped HTTP status before any socket exists; the reason is logged, while the widget gets only the
// status and a generic body, so a caller can't probe which check failed. 401 = token rejected (fetch a fresh token and
// retry), 403 = not allowed (origin, disabled connection, churned or paused company, paused chatbot), 404 = unknown
// chatbot, or a conversation that isn't this user's or is closed (start a new one).
export enum WidgetAuthFailureEnum {
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  ServerError = "ServerError",
}

export const WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP: Record<
  WidgetAuthFailureEnum,
  401 | 403 | 404 | 500
> = {
  [WidgetAuthFailureEnum.Unauthorized]: 401,
  [WidgetAuthFailureEnum.Forbidden]: 403,
  [WidgetAuthFailureEnum.NotFound]: 404,
  [WidgetAuthFailureEnum.ServerError]: 500,
};

// DEV_NOTE: A conversation that can't be started or resumed answers like the auth checks before it
export const CONVERSATION_START_FAILURE_WIDGET_AUTH_MAP: Record<
  ConversationStartFailureEnum,
  WidgetAuthFailureEnum
> = {
  [ConversationStartFailureEnum.NotFound]: WidgetAuthFailureEnum.NotFound,
  [ConversationStartFailureEnum.ServerError]: WidgetAuthFailureEnum.ServerError,
};

// JOSE header of the companion JWT. kid is required: it picks the key out of the issuer's JWKS.
// DEV_NOTE: crit names header extensions the verifier must understand (RFC 7515 §4.1.11). We understand none, so a
// token that sets it is rejected rather than having the member silently stripped.
export const ZWidgetJwtHeader = z.object({
  alg: z.enum(WidgetJwtAlgorithmEnum),
  kid: z.string().min(1),
  typ: z.string().optional(),
  crit: z.never({ message: "No critical header extensions are supported" }).optional(),
});
export type WidgetJwtHeader = z.infer<typeof ZWidgetJwtHeader>;

// DEV_NOTE: Companion JWT claims {sub, roles, exp ≤ 5m} signed by the host backend. nbf is optional and honoured. iss picks the
// company_connections row, so a company claim is ignored. aud may be a string or an array (RFC 7519 §4.1.3).
// name becomes chatbot_users.display_name (PII, never logged).
export const ZWidgetJwtClaims = z.object({
  iss: z.string().min(1),
  // DEV_NOTE: Validated, never transformed: hostUserId must be exactly the signed value
  sub: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, { message: "sub must not be blank" }),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
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
// chatbotId), so it never goes to the widget; the widget route turns it into the conversation session (M2-2).
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
