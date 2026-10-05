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
