export enum CompanyEncryptionKeyStatusIntEnum {
  Active = 1,
  Retiring = 2,
  Destroyed = 3,
}

export enum CompanyEncryptionKeyStatusLabelEnum {
  Active = "Active",
  Retiring = "Retiring",
  Destroyed = "Destroyed",
}

export const COMPANY_ENCRYPTION_KEY_STATUS_LABEL_MAP: Record<
  CompanyEncryptionKeyStatusIntEnum,
  CompanyEncryptionKeyStatusLabelEnum
> = {
  [CompanyEncryptionKeyStatusIntEnum.Active]: CompanyEncryptionKeyStatusLabelEnum.Active,
  [CompanyEncryptionKeyStatusIntEnum.Retiring]: CompanyEncryptionKeyStatusLabelEnum.Retiring,
  [CompanyEncryptionKeyStatusIntEnum.Destroyed]: CompanyEncryptionKeyStatusLabelEnum.Destroyed,
};
