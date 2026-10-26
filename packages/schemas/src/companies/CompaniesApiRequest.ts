import { z } from "zod";
import { CompanyStatusIntEnum, ZCompanyBase, ZCompanySortColumn } from "./CompaniesCommon";
import { ZPageApiRequest } from "../common";

export const ZCreateCompanyApiRequest = z.object({
  company: ZCompanyBase,
});
export type CreateCompanyApiRequest = z.infer<typeof ZCreateCompanyApiRequest>;

// DEV_NOTE: What a company admin may edit on their own company. status is not here: pausing or churning a
// company is an operator decision (ZUpdateCompanyStatusApiRequest).
export const ZUpdateCompanyApiRequest = z.object({
  company: ZCompanyBase.extend({
    isReadOnly: z.boolean(),
  }).partial(),
});
export type UpdateCompanyApiRequest = z.infer<typeof ZUpdateCompanyApiRequest>;

// DEV_NOTE: Operator only
export const ZUpdateCompanyStatusApiRequest = z.object({
  company: z.object({
    status: z.enum(CompanyStatusIntEnum),
  }),
});
export type UpdateCompanyStatusApiRequest = z.infer<typeof ZUpdateCompanyStatusApiRequest>;

// DEV_NOTE: Operator list across every company, so it is paged
export const ZGetCompaniesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZCompanySortColumn.nullable().optional(),
});
export type GetCompaniesApiRequest = z.infer<typeof ZGetCompaniesApiRequest>;

// DEV_NOTE: PUT /dashboard/settings/read-only (Settings › Bots, M4-10): the company's emergency switch. On, every write
// tool is left out of every chatbot's turns (the action engine's is_read_only check); answers keep working.
export const ZUpdateReadOnlyModeApiRequest = z.object({
  isReadOnly: z.boolean(),
});
export type UpdateReadOnlyModeApiRequest = z.infer<typeof ZUpdateReadOnlyModeApiRequest>;
