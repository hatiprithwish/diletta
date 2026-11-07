import { z } from "zod";

// DEV_NOTE: Query of GET /widget/bootstrap (M2-7): the embed's chatbot publicId, as for the socket (absent = the
// company's default chatbot). The companion JWT rides in Authorization: Bearer, never here.
export const ZWidgetBootstrapApiRequest = z.object({
  chatbot: z.string().trim().min(1).max(64).optional(),
});
export type WidgetBootstrapApiRequest = z.infer<typeof ZWidgetBootstrapApiRequest>;

// DEV_NOTE: Query of GET /widget/conversations (the widget's history): the chatbot as on /bootstrap and the page. The page
// size is the server's (WIDGET_HISTORY_PAGE_SIZE) and the order fixed (last activity, newest first): the widget only
// ever asks for the next page.
export const ZWidgetConversationsApiRequest = ZWidgetBootstrapApiRequest.extend({
  pageNo: z.coerce.number().int().min(1).max(1000).optional(),
});
export type WidgetConversationsApiRequest = z.infer<typeof ZWidgetConversationsApiRequest>;

// DEV_NOTE: Path of GET /widget/conversations/:publicId (one past chat's messages); its query is the bootstrap's
export const ZWidgetConversationApiParams = z.object({
  publicId: z.string().trim().min(1).max(64),
});
export type WidgetConversationApiParams = z.infer<typeof ZWidgetConversationApiParams>;
