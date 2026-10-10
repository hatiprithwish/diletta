import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import { AUTH_STRATEGIES, getAuthStrategy } from "./AuthStrategies";

describe("AuthStrategy registry", () => {
  it("has a strategy for exactly the auth types the schemas accept", () => {
    expect(Object.keys(AUTH_STRATEGIES).sort()).toEqual(
      Object.keys(Schemas.SUPPORTED_AUTH_TYPES).sort(),
    );
    for (const [authType, strategy] of Object.entries(AUTH_STRATEGIES)) {
      expect(strategy.authType).toBe(authType);
    }
  });

  it("finds no strategy for an unbuilt or unknown type", () => {
    expect(getAuthStrategy(Schemas.CompanyConnectionAuthTypeEnum.Oauth2Cc)).toBeNull();
    expect(getAuthStrategy("toString")).toBeNull();
  });
});

describe("jwt_forward", () => {
  const strategy = getAuthStrategy(Schemas.CompanyConnectionAuthTypeEnum.JwtForward)!;

  it("sends the user's host token as a bearer token", () => {
    expect(strategy.getHeaders({ authConfig: {}, getHostToken: () => "a.b.c" })).toEqual({
      isSuccess: true,
      headers: { Authorization: "Bearer a.b.c" },
    });
  });

  it("asks for a token when there is none, and rejects a malformed one without echoing it", () => {
    expect(strategy.getHeaders({ authConfig: {}, getHostToken: () => null })).toMatchObject({
      isSuccess: false,
      failureOutcome: Schemas.HostCallOutcomeEnum.TokenNeeded,
    });
    for (const token of ["a b", "a\nb", "x".repeat(16_385)]) {
      const response = strategy.getHeaders({ authConfig: {}, getHostToken: () => token });
      expect(response.failureOutcome).toBe(Schemas.HostCallOutcomeEnum.TokenRejected);
      expect(response.message).toBe("Host token is malformed");
    }
  });
});
