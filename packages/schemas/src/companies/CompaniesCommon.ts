import z from "zod";

export enum CompanyStatusIntEnum {
  Active = 1,
  Paused = 2,
  Churned = 3,
}

export enum CompanyStatusLabelEnum {
  Active = "Active",
  Paused = "Paused",
  Churned = "Churned",
}

export const COMPANY_STATUS_LABEL_MAP: Record<CompanyStatusIntEnum, CompanyStatusLabelEnum> = {
  [CompanyStatusIntEnum.Active]: CompanyStatusLabelEnum.Active,
  [CompanyStatusIntEnum.Paused]: CompanyStatusLabelEnum.Paused,
  [CompanyStatusIntEnum.Churned]: CompanyStatusLabelEnum.Churned,
};

// Create Company Body
export const ZCompanyBase = z.object({
  name: z.string().trim().min(1),
});
export type CompanyBase = z.infer<typeof ZCompanyBase>;

// Whole Company Body — DB shape (status stored as integer)
// DEV_NOTE: id is the internal bigint identity PK — it is also the tenant key passed to withTenant.
// NEVER sent to a client; publicId is client-facing.
export const ZCompany = ZCompanyBase.extend({
  id: z.string(),
  publicId: z.string(),
  status: z.enum(CompanyStatusIntEnum),
  isReadOnly: z.boolean(),
  // DEV_NOTE: numeric(12,6) USD, kept as a string for exact decimals
  spendingBudget: z.string().nullable(),
  contentRetentionDays: z.number().int().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Company = z.infer<typeof ZCompany>;

// API response shape — includes both int and label; internal ids are structurally omitted, publicId is client-facing
export type CompanyWithStatus = Omit<Company, "id" | "updatedBy"> & {
  companyStatus: CompanyStatusIntEnum;
  companyStatusLabel: CompanyStatusLabelEnum;
};
