import z from "zod";
import { ZBytes } from "../common";

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

// DEV_NOTE: provider is a text column (no Status Enum Pattern): the value names the model provider (model_key only)
export enum ModelProviderEnum {
  Google = "google",
  OpenAI = "openai",
  Anthropic = "anthropic",
}

// Create Company Secret Body
// DEV_NOTE: secret is the plaintext the admin pastes. The Repo encrypts it under the company key straight away;
// it is never stored, logged or returned as-is (only the last four characters of a long secret are kept for display).
export const ZCompanySecretBase = z.object({
  type: z.enum(CompanySecretTypeIntEnum),
  provider: z.enum(ModelProviderEnum).nullable(),
  secret: z.string().trim().min(1),
  expiresAt: z.coerce.date().nullable(),
});
export type CompanySecretBase = z.infer<typeof ZCompanySecretBase>;

// Whole Company Secret Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, connectionId, createdBy and updatedBy are internal bigint ids, and encryptedSecret, iv
// and encryptionKeyVersion are ciphertext metadata — used by DAL/Repo only, NEVER sent to a client.
// provider is untyped text in the DB, so the row reads it as such.
export const ZCompanySecret = ZCompanySecretBase.omit({ secret: true }).extend({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  provider: z.string().nullable(),
  connectionId: z.string().nullable(),
  encryptedSecret: ZBytes,
  iv: ZBytes,
  encryptionKeyVersion: z.number().int().min(1),
  lastFourChars: z.string(),
  status: z.enum(CompanySecretStatusIntEnum),
  expiresAt: z.date().nullable(),
  lastValidatedAt: z.date().nullable(),
  rotatedAt: z.date().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanySecret = z.infer<typeof ZCompanySecret>;

// API response shape — includes both int and label for every enum; internal ids and ciphertext are structurally omitted
export type CompanySecretWithStatus = Omit<
  CompanySecret,
  | "id"
  | "companyId"
  | "connectionId"
  | "encryptedSecret"
  | "iv"
  | "encryptionKeyVersion"
  | "createdBy"
  | "updatedBy"
> & {
  companySecretStatus: CompanySecretStatusIntEnum;
  companySecretStatusLabel: CompanySecretStatusLabelEnum;
  companySecretType: CompanySecretTypeIntEnum;
  companySecretTypeLabel: CompanySecretTypeLabelEnum;
};
