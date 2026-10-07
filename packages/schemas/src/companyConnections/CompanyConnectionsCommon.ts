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

// Create Company Connection Body
// DEV_NOTE: authConfig and resetOp are any JSON until their shapes land: authConfig per auth type with the
// AuthStrategy (M3-2), resetOp with the tool op schemas (M3-1)
export const ZCompanyConnectionBase = z.object({
  environment: z.enum(CompanyConnectionEnvironmentIntEnum),
  adapterType: z.enum(CompanyConnectionAdapterTypeIntEnum),
  baseUrl: z.url().nullable(),
  authType: z.enum(CompanyConnectionAuthTypeEnum),
  authConfig: z.json(),
  credentialScope: z.enum(CompanyConnectionCredentialScopeIntEnum),
  jwtIssuer: z.url(),
  allowedOrigins: z.array(z.url()),
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
