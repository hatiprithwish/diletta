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
