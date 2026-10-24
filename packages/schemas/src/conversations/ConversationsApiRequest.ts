import { z } from "zod";
import { ZPageApiRequest } from "../common";
import {
  ZConversationListTab,
  ZConversationOutcomeFilter,
  ZConversationSortColumn,
} from "./ConversationsCommon";

// DEV_NOTE: The list's filters, shared by the list and the export. configId = a chatbot config's public id, botId = a
// chatbot's public id (DESIGN.md §6); absent = every config / the whole company. tab absent = All.
export const ZConversationsFilterApiRequest = z.object({
  tab: ZConversationListTab.optional(),
  outcome: ZConversationOutcomeFilter.optional(),
  configId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
});
export type ConversationsFilterApiRequest = z.infer<typeof ZConversationsFilterApiRequest>;

// DEV_NOTE: GET /dashboard/conversations. A company has any number of conversations, so the list is paged.
export const ZGetConversationsApiRequest = ZPageApiRequest.extend(
  ZConversationsFilterApiRequest.shape,
).extend({
  sortColumn: ZConversationSortColumn.nullable().optional(),
});
export type GetConversationsApiRequest = z.infer<typeof ZGetConversationsApiRequest>;

// GET /dashboard/conversations/export: the same filters, newest first, at most CONVERSATIONS_EXPORT_MAX_ROWS rows
export const ZExportConversationsApiRequest = ZConversationsFilterApiRequest;
export type ExportConversationsApiRequest = z.infer<typeof ZExportConversationsApiRequest>;

// DEV_NOTE: The Conversations pages' URL search (apps/web validateSearch): the filters and the page; an unknown value
// falls back to the default instead of failing the page
export const ZConversationsPageSearch = z.object({
  tab: ZConversationListTab.optional().catch(undefined),
  outcome: ZConversationOutcomeFilter.optional().catch(undefined),
  configId: z.string().min(1).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type ConversationsPageSearch = z.infer<typeof ZConversationsPageSearch>;
