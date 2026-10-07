import { z } from "zod";
import { CompanyStatusIntEnum, ZCompanyBase } from "./CompaniesCommon";

export const ZCreateCompanyApiRequest = z.object({
  company: ZCompanyBase,
});
export type CreateCompanyApiRequest = z.infer<typeof ZCreateCompanyApiRequest>;

export const ZUpdateCompanyApiRequest = z.object({
  company: ZCompanyBase.extend({
    status: z.enum(CompanyStatusIntEnum),
    isReadOnly: z.boolean(),
  }).partial(),
});
export type UpdateCompanyApiRequest = z.infer<typeof ZUpdateCompanyApiRequest>;
