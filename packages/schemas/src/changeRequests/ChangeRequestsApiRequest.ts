import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { ZChangeRequestListTab, ZChangeRequestSortColumn } from "./ChangeRequestsCommon";

// DEV_NOTE: GET /dashboard/change-requests (M4-5). A company has any number of change requests, so the list is paged.
// requesterId = the chatbot user's host user id (chatbot_users keep the host's id as their client id), botId = a
// chatbot's public id (DESIGN.md §6); absent = everyone / the whole company, unknown → 404. tab absent = All.
export const ZGetChangeRequestsApiRequest = ZPageApiRequest.extend({
  tab: ZChangeRequestListTab.optional(),
  requesterId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  sortColumn: ZChangeRequestSortColumn.nullable().optional(),
});
export type GetChangeRequestsApiRequest = z.infer<typeof ZGetChangeRequestsApiRequest>;

// DEV_NOTE: GET /dashboard/change-requests/requesters: the Requested by choices. requesterId = the one the page's URL
// picked, added when it isn't among the top CHANGE_REQUEST_REQUESTERS_MAX (unknown or erased = left out)
export const ZGetChangeRequestRequestersApiRequest = z.object({
  requesterId: z.string().min(1).optional(),
});
export type GetChangeRequestRequestersApiRequest = z.infer<
  typeof ZGetChangeRequestRequestersApiRequest
>;

// DEV_NOTE: The Changes pages' URL search (apps/web validateSearch): the filters and the page; an unknown value falls
// back to the default instead of failing the page
export const ZChangesPageSearch = z.object({
  tab: ZChangeRequestListTab.optional().catch(undefined),
  requesterId: z.string().min(1).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type ChangesPageSearch = z.infer<typeof ZChangesPageSearch>;
