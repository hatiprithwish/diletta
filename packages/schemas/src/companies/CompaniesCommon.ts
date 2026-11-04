import { z } from "zod";
import { AuditEntityActionEnum } from "../auditLog/AuditLogCommon";
import type {
  CompanyConnectionEnvironmentIntEnum,
  CompanyConnectionEnvironmentLabelEnum,
} from "../companyConnections/CompanyConnectionsCommon";

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

export enum CompanySortColumn {
  CreatedAt = "createdAt",
  Name = "name",
  Status = "status",
}

export const ZCompanySortColumn = z.enum(CompanySortColumn);

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

// DEV_NOTE: M7-8. A row of the operator's Companies list: the company and the environments of its active connections
// (Production first), each as int and label
export type OperatorCompanyListItem = CompanyWithStatus & {
  connectionEnvironments: CompanyConnectionEnvironmentIntEnum[];
  connectionEnvironmentLabels: CompanyConnectionEnvironmentLabelEnum[];
};

// DEV_NOTE: M7-8. How many companies are in each status, for the Companies list's status tabs
export type CompanyStatusCounts = Record<CompanyStatusIntEnum, number>;

export const OPERATOR_COMPANIES_PAGE_SIZE = 25;

// DEV_NOTE: M7-8. The status a company may be moved to, and the audit action each move records. Same status = no move.
export const COMPANY_STATUS_AUDIT_ACTION_MAP = {
  [CompanyStatusIntEnum.Active]: AuditEntityActionEnum.Resumed,
  [CompanyStatusIntEnum.Paused]: AuditEntityActionEnum.Paused,
  [CompanyStatusIntEnum.Churned]: AuditEntityActionEnum.Churned,
} as const satisfies Record<CompanyStatusIntEnum, AuditEntityActionEnum>;

// DEV_NOTE: The operator's Companies list tabs (URL ?status=): All, or one status
export enum OperatorCompanyStatusTabEnum {
  All = "all",
  Active = "active",
  Paused = "paused",
  Churned = "churned",
}

export const OPERATOR_COMPANY_STATUS_TAB_MAP: Record<
  OperatorCompanyStatusTabEnum,
  CompanyStatusIntEnum | null
> = {
  [OperatorCompanyStatusTabEnum.All]: null,
  [OperatorCompanyStatusTabEnum.Active]: CompanyStatusIntEnum.Active,
  [OperatorCompanyStatusTabEnum.Paused]: CompanyStatusIntEnum.Paused,
  [OperatorCompanyStatusTabEnum.Churned]: CompanyStatusIntEnum.Churned,
};

// DEV_NOTE: The sections of an operator's company page (URL ?tab=)
export enum OperatorCompanyTabEnum {
  Connections = "connections",
  Tools = "tools",
  Maintenance = "maintenance",
}
