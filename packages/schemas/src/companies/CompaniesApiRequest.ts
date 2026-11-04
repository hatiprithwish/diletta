import { z } from "zod";
import {
  CompanyStatusIntEnum,
  OperatorCompanyStatusTabEnum,
  OperatorCompanyTabEnum,
  ZCompanyBase,
  ZCompanySortColumn,
} from "./CompaniesCommon";
import { ZPageApiRequest } from "../common";
import { OperatorToolStatusTabEnum } from "../toolDefinitions/ToolDefinitionsCommon";

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

// DEV_NOTE: Operator list across every company, so it is paged; status narrows it to one status (a query string, so
// the int is coerced)
export const ZGetCompaniesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZCompanySortColumn.nullable().optional(),
  status: z.coerce.number().pipe(z.enum(CompanyStatusIntEnum)).nullable().optional(),
});
export type GetCompaniesApiRequest = z.infer<typeof ZGetCompaniesApiRequest>;

// DEV_NOTE: M7-8. The operator's Companies page URL search: the status tab and the page; an unknown value falls back to
// the default instead of failing the page
export const ZOperatorCompaniesPageSearch = z.object({
  status: z.enum(OperatorCompanyStatusTabEnum).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type OperatorCompaniesPageSearch = z.infer<typeof ZOperatorCompaniesPageSearch>;

// DEV_NOTE: M7-8. An operator's company page URL search: its section, and the Tools section's status tab and page
export const ZOperatorCompanyPageSearch = z.object({
  tab: z.enum(OperatorCompanyTabEnum).optional().catch(undefined),
  tools: z.enum(OperatorToolStatusTabEnum).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type OperatorCompanyPageSearch = z.infer<typeof ZOperatorCompanyPageSearch>;

// DEV_NOTE: PUT /dashboard/settings/read-only (Settings › Bots, M4-10): the company's emergency switch. On, every write
// tool is left out of every chatbot's turns (the action engine's is_read_only check); answers keep working.
export const ZUpdateReadOnlyModeApiRequest = z.object({
  isReadOnly: z.boolean(),
});
export type UpdateReadOnlyModeApiRequest = z.infer<typeof ZUpdateReadOnlyModeApiRequest>;
