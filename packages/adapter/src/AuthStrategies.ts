import * as Schemas from "@app/schemas";

// DEV_NOTE: A bearer token is a single RFC 6750 token68-like value. Anything else (spaces, CR/LF, control characters) is
// refused before it reaches a header, so a bad token can't inject headers or be split.
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;
const BEARER_TOKEN_MAX_LENGTH = 16_384;

// DEV_NOTE: jwt_forward: the chatbot user's own host token (from DO memory) as Authorization: Bearer, so the host
// applies that user's permissions. A missing token is TokenNeeded (the widget fetches a fresh one, M3-8); a malformed
// one is TokenRejected, since a fresh token is the fix. Messages never include the token.
const JwtForwardAuthStrategy: Schemas.HostAuthStrategy = {
  authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
  getHeaders({ getHostToken }) {
    const token = getHostToken();
    if (!token) {
      return {
        isSuccess: false,
        failureOutcome: Schemas.HostCallOutcomeEnum.TokenNeeded,
        message: "No host token",
      };
    }
    if (token.length > BEARER_TOKEN_MAX_LENGTH || !BEARER_TOKEN_PATTERN.test(token)) {
      return {
        isSuccess: false,
        failureOutcome: Schemas.HostCallOutcomeEnum.TokenRejected,
        message: "Host token is malformed",
      };
    }
    return { isSuccess: true, headers: { Authorization: `Bearer ${token}` } };
  },
};

// DEV_NOTE: The AuthStrategy registry: one entry per auth type in Schemas.SUPPORTED_AUTH_TYPES (a test checks they
// match). Adding a type = its strategy here + its auth_config schema there.
export const AUTH_STRATEGIES: Partial<
  Record<Schemas.CompanyConnectionAuthTypeEnum, Schemas.HostAuthStrategy>
> = {
  [Schemas.CompanyConnectionAuthTypeEnum.JwtForward]: JwtForwardAuthStrategy,
};

export function getAuthStrategy(authType: string): Schemas.HostAuthStrategy | null {
  return Object.hasOwn(AUTH_STRATEGIES, authType)
    ? (AUTH_STRATEGIES[authType as Schemas.CompanyConnectionAuthTypeEnum] ?? null)
    : null;
}
