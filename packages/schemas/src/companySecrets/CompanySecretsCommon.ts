export enum CompanySecretTypeIntEnum {
  ModelKey = 1,
  ApiKey = 2,
  ClientSecret = 3,
  HmacKey = 4,
}

export enum CompanySecretTypeLabelEnum {
  ModelKey = "Model key",
  ApiKey = "API key",
  ClientSecret = "Client secret",
  HmacKey = "HMAC key",
}

export const COMPANY_SECRET_TYPE_LABEL_MAP: Record<
  CompanySecretTypeIntEnum,
  CompanySecretTypeLabelEnum
> = {
  [CompanySecretTypeIntEnum.ModelKey]: CompanySecretTypeLabelEnum.ModelKey,
  [CompanySecretTypeIntEnum.ApiKey]: CompanySecretTypeLabelEnum.ApiKey,
  [CompanySecretTypeIntEnum.ClientSecret]: CompanySecretTypeLabelEnum.ClientSecret,
  [CompanySecretTypeIntEnum.HmacKey]: CompanySecretTypeLabelEnum.HmacKey,
};

export enum CompanySecretStatusIntEnum {
  Active = 1,
  Invalid = 2,
  Revoked = 3,
}

export enum CompanySecretStatusLabelEnum {
  Active = "Active",
  Invalid = "Invalid",
  Revoked = "Revoked",
}

export const COMPANY_SECRET_STATUS_LABEL_MAP: Record<
  CompanySecretStatusIntEnum,
  CompanySecretStatusLabelEnum
> = {
  [CompanySecretStatusIntEnum.Active]: CompanySecretStatusLabelEnum.Active,
  [CompanySecretStatusIntEnum.Invalid]: CompanySecretStatusLabelEnum.Invalid,
  [CompanySecretStatusIntEnum.Revoked]: CompanySecretStatusLabelEnum.Revoked,
};
