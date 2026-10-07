import z from "zod";

export enum CompanyConnectionEnvironmentIntEnum {
  Production = 1,
  Staging = 2,
}

export enum CompanyConnectionEnvironmentLabelEnum {
  Production = "Production",
  Staging = "Staging",
}

export const COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP: Record<
  CompanyConnectionEnvironmentIntEnum,
  CompanyConnectionEnvironmentLabelEnum
> = {
  [CompanyConnectionEnvironmentIntEnum.Production]:
    CompanyConnectionEnvironmentLabelEnum.Production,
  [CompanyConnectionEnvironmentIntEnum.Staging]: CompanyConnectionEnvironmentLabelEnum.Staging,
};

export enum CompanyConnectionAdapterTypeIntEnum {
  Rest = 1,
  HostExec = 2,
  Mcp = 3,
}

export enum CompanyConnectionAdapterTypeLabelEnum {
  Rest = "REST",
  HostExec = "Host-executed",
  Mcp = "MCP",
}

export const COMPANY_CONNECTION_ADAPTER_TYPE_LABEL_MAP: Record<
  CompanyConnectionAdapterTypeIntEnum,
  CompanyConnectionAdapterTypeLabelEnum
> = {
  [CompanyConnectionAdapterTypeIntEnum.Rest]: CompanyConnectionAdapterTypeLabelEnum.Rest,
  [CompanyConnectionAdapterTypeIntEnum.HostExec]: CompanyConnectionAdapterTypeLabelEnum.HostExec,
  [CompanyConnectionAdapterTypeIntEnum.Mcp]: CompanyConnectionAdapterTypeLabelEnum.Mcp,
};

export enum CompanyConnectionCredentialScopeIntEnum {
  None = 1,
  Company = 2,
  ChatbotUser = 3,
}

export enum CompanyConnectionCredentialScopeLabelEnum {
  None = "None",
  Company = "Company",
  ChatbotUser = "Chatbot user",
}

export const COMPANY_CONNECTION_CREDENTIAL_SCOPE_LABEL_MAP: Record<
  CompanyConnectionCredentialScopeIntEnum,
  CompanyConnectionCredentialScopeLabelEnum
> = {
  [CompanyConnectionCredentialScopeIntEnum.None]: CompanyConnectionCredentialScopeLabelEnum.None,
  [CompanyConnectionCredentialScopeIntEnum.Company]:
    CompanyConnectionCredentialScopeLabelEnum.Company,
  [CompanyConnectionCredentialScopeIntEnum.ChatbotUser]:
    CompanyConnectionCredentialScopeLabelEnum.ChatbotUser,
};

export enum CompanyConnectionStatusIntEnum {
  Active = 1,
  Disabled = 2,
}

export enum CompanyConnectionStatusLabelEnum {
  Active = "Active",
  Disabled = "Disabled",
}

export const COMPANY_CONNECTION_STATUS_LABEL_MAP: Record<
  CompanyConnectionStatusIntEnum,
  CompanyConnectionStatusLabelEnum
> = {
  [CompanyConnectionStatusIntEnum.Active]: CompanyConnectionStatusLabelEnum.Active,
  [CompanyConnectionStatusIntEnum.Disabled]: CompanyConnectionStatusLabelEnum.Disabled,
};

// DEV_NOTE: auth_type is a text column (no Status Enum Pattern): the value names the AuthStrategy (M3-2)
export enum CompanyConnectionAuthTypeEnum {
  JwtForward = "jwt_forward",
  ApiKeyHeader = "api_key_header",
  Oauth2Cc = "oauth2_cc",
  Oauth2Authcode = "oauth2_authcode",
  HmacSigned = "hmac_signed",
}

// DEV_NOTE: Host API calls and the issuer's signing keys (JWKS) must not travel in plaintext, or anyone on the
// path could read host data or swap the keys and forge host JWTs. OIDC also requires an https issuer.
const ZHttpsUrl = z.url({ protocol: /^https$/ });

// DEV_NOTE: A browser Origin header is scheme://host[:port] only, so a stored path, query or trailing slash
// could never match it. Only exact origins are accepted.
const ZOrigin = z.url().refine((value) => URL.canParse(value) && new URL(value).origin === value, {
  message: "Must be an origin (scheme://host[:port]) with no path",
});

// Create Company Connection Body
// DEV_NOTE: authConfig is a JSON object and resetOp any JSON until their shapes land: authConfig per auth type
// with the AuthStrategy (M3-2), resetOp with the tool op schemas (M3-1)
export const ZCompanyConnectionBase = z.object({
  environment: z.enum(CompanyConnectionEnvironmentIntEnum),
  adapterType: z.enum(CompanyConnectionAdapterTypeIntEnum),
  baseUrl: ZHttpsUrl.nullable(),
  authType: z.enum(CompanyConnectionAuthTypeEnum),
  authConfig: z.record(z.string(), z.json()),
  credentialScope: z.enum(CompanyConnectionCredentialScopeIntEnum),
  jwtIssuer: ZHttpsUrl,
  allowedOrigins: z.array(ZOrigin),
  resetOp: z.json().nullable(),
});
export type CompanyConnectionBase = z.infer<typeof ZCompanyConnectionBase>;

// Whole Company Connection Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, createdBy and updatedBy are internal bigint ids — used by DAL/Repo only, NEVER sent to a client.
// auth_type is untyped text and the jsonb columns are untyped in the DB, so the row reads them as such.
export const ZCompanyConnection = ZCompanyConnectionBase.extend({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  authType: z.string(),
  authConfig: z.unknown(),
  resetOp: z.unknown(),
  status: z.enum(CompanyConnectionStatusIntEnum),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanyConnection = z.infer<typeof ZCompanyConnection>;

// API response shape — includes both int and label for every enum; internal ids are structurally omitted
export type CompanyConnectionWithStatus = Omit<
  CompanyConnection,
  "id" | "companyId" | "createdBy" | "updatedBy"
> & {
  companyConnectionStatus: CompanyConnectionStatusIntEnum;
  companyConnectionStatusLabel: CompanyConnectionStatusLabelEnum;
  companyConnectionEnvironment: CompanyConnectionEnvironmentIntEnum;
  companyConnectionEnvironmentLabel: CompanyConnectionEnvironmentLabelEnum;
  companyConnectionAdapterType: CompanyConnectionAdapterTypeIntEnum;
  companyConnectionAdapterTypeLabel: CompanyConnectionAdapterTypeLabelEnum;
  companyConnectionCredentialScope: CompanyConnectionCredentialScopeIntEnum;
  companyConnectionCredentialScopeLabel: CompanyConnectionCredentialScopeLabelEnum;
};
