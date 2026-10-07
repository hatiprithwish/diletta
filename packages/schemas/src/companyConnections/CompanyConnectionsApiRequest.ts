import { z } from "zod";
import {
  CompanyConnectionAdapterTypeIntEnum,
  CompanyConnectionStatusIntEnum,
  ZCompanyConnectionBase,
} from "./CompanyConnectionsCommon";

// DEV_NOTE: adapterType defaults to REST and resetOp to none. The refine mirrors CHK_company_connections_base_url.
export const ZCreateCompanyConnectionApiRequest = z.object({
  companyConnection: ZCompanyConnectionBase.partial({ adapterType: true, resetOp: true }).refine(
    (connection) =>
      connection.baseUrl !== null ||
      connection.adapterType === CompanyConnectionAdapterTypeIntEnum.HostExec,
    { message: "Base URL is required", path: ["baseUrl"] },
  ),
});
export type CreateCompanyConnectionApiRequest = z.infer<typeof ZCreateCompanyConnectionApiRequest>;

// DEV_NOTE: environment, adapter, auth type and credential scope are fixed once created: company secrets and
// tools are bound to them. Change those by creating a new connection. resetOp is set on create only: with
// "null = unchanged" an update could never clear it, so changing it arrives with the eval reset flow (M5-2).
export const ZUpdateCompanyConnectionApiRequest = z.object({
  companyConnection: ZCompanyConnectionBase.pick({
    baseUrl: true,
    authConfig: true,
    jwtIssuer: true,
    allowedOrigins: true,
  })
    .extend({
      status: z.enum(CompanyConnectionStatusIntEnum),
    })
    .partial(),
});
export type UpdateCompanyConnectionApiRequest = z.infer<typeof ZUpdateCompanyConnectionApiRequest>;
