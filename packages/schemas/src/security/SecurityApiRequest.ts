import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { ZOrigin } from "../companyConnections/CompanyConnectionsCommon";
import {
  ALLOWED_ORIGINS_MAX,
  InjectionEventSortColumn,
  ZContentRetentionDays,
} from "./SecurityCommon";

// PUT /dashboard/security/connections/:publicId/origins: the whole list, replacing the stored one
export const ZUpdateAllowedOriginsApiRequest = z.object({
  allowedOrigins: z
    .array(ZOrigin)
    .min(1, "Add at least one origin")
    .max(ALLOWED_ORIGINS_MAX, `At most ${ALLOWED_ORIGINS_MAX} origins`)
    .refine((origins) => new Set(origins).size === origins.length, {
      message: "Each origin once",
    }),
});
export type UpdateAllowedOriginsApiRequest = z.infer<typeof ZUpdateAllowedOriginsApiRequest>;

// PUT /dashboard/security/retention
export const ZUpdateContentRetentionApiRequest = z.object({
  contentRetentionDays: ZContentRetentionDays,
});
export type UpdateContentRetentionApiRequest = z.infer<typeof ZUpdateContentRetentionApiRequest>;

// GET /dashboard/security/injection-events: newest first by default
export const ZGetInjectionEventsApiRequest = ZPageApiRequest.extend({
  sortColumn: z.enum(InjectionEventSortColumn).nullable().optional(),
});
export type GetInjectionEventsApiRequest = z.infer<typeof ZGetInjectionEventsApiRequest>;

// DEV_NOTE: /security URL search: the page of the injection events and of the audit log
export const ZSecurityPageSearch = z.object({
  injectionPage: z.coerce.number().int().min(1).optional().catch(undefined),
  auditPage: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type SecurityPageSearch = z.infer<typeof ZSecurityPageSearch>;
