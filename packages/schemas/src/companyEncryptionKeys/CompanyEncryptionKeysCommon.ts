import z from "zod";
import { ZBytes } from "../common";

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

// Whole Company Encryption Key Body — DB shape
// DEV_NOTE: id and companyId are internal bigint ids, and encryptedKey is key material — used by DAL/Repo only,
// NEVER sent to a client. encryptedKey is null once destroyed (crypto-shred).
export const ZCompanyEncryptionKey = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  version: z.number().int().min(1),
  encryptedKey: ZBytes.nullable(),
  masterKeyVersion: z.number().int().min(1),
  status: z.enum(CompanyEncryptionKeyStatusIntEnum),
  destroyedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanyEncryptionKey = z.infer<typeof ZCompanyEncryptionKey>;

// API response shape — includes both int and label; internal ids and key material are structurally omitted
export type CompanyEncryptionKeyWithStatus = Omit<
  CompanyEncryptionKey,
  "id" | "companyId" | "encryptedKey"
> & {
  companyEncryptionKeyStatus: CompanyEncryptionKeyStatusIntEnum;
  companyEncryptionKeyStatusLabel: CompanyEncryptionKeyStatusLabelEnum;
};
