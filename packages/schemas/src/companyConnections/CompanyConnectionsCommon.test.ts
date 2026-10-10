import { describe, it, expect } from "vitest";
import {
  CompanyConnectionAuthTypeEnum,
  CompanyConnectionCredentialScopeIntEnum,
  getAuthConfigIssue,
} from "./CompanyConnectionsCommon";

describe("getAuthConfigIssue", () => {
  const jwtForward = {
    authType: CompanyConnectionAuthTypeEnum.JwtForward,
    credentialScope: CompanyConnectionCredentialScopeIntEnum.None,
    authConfig: {},
  };

  it("accepts jwt_forward with an empty config and no stored credential", () => {
    expect(getAuthConfigIssue(jwtForward)).toBeNull();
  });

  it("refuses a jwt_forward config with keys, or a stored credential", () => {
    expect(getAuthConfigIssue({ ...jwtForward, authConfig: { header: "X-Token" } })).toContain(
      "Invalid auth config",
    );
    expect(
      getAuthConfigIssue({
        ...jwtForward,
        credentialScope: CompanyConnectionCredentialScopeIntEnum.Company,
      }),
    ).toBe("Auth type jwt_forward doesn't work with this credential scope");
  });

  it("refuses auth types with no strategy yet, and unknown ones", () => {
    for (const authType of [
      CompanyConnectionAuthTypeEnum.ApiKeyHeader,
      CompanyConnectionAuthTypeEnum.Oauth2Cc,
      CompanyConnectionAuthTypeEnum.Oauth2Authcode,
      CompanyConnectionAuthTypeEnum.HmacSigned,
      "constructor",
    ]) {
      expect(getAuthConfigIssue({ ...jwtForward, authType })).toBe(
        `Auth type ${authType} is not supported yet`,
      );
    }
  });
});
