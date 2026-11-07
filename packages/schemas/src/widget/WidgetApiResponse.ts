import { z } from "zod";
import type { ApiResponse } from "../common";
import { ZKnowledgeCitation } from "../knowledgeSearch";
import type { WidgetAuthFailureEnum } from "../widgetAuth";

// DEV_NOTE: GET /widget/bootstrap (M2-7): what the widget shows before any conversation exists, so opening the panel
// never creates one. The chatbot's name, and its widget settings from the published config (greeting, up to 3
// suggestions, the launcher label). widget is null when the chatbot has no loadable published config: the widget
// shows its unavailable state. linkOrigins (M6-4): the origins a reply's link may point to besides its cited sources,
// the connection's allowed origins (the host app's own pages). Client-facing: publicId and names only.
export const ZWidgetBootstrap = z.object({
  chatbot: z.object({ publicId: z.string(), name: z.string() }),
  linkOrigins: z.array(z.string()),
  widget: z
    .object({
      greeting: z.string(),
      suggestions: z.array(z.string()),
      launcherLabel: z.string().nullable(),
    })
    .nullable(),
});
export type WidgetBootstrap = z.infer<typeof ZWidgetBootstrap>;

export const ZWidgetBootstrapApiResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string().optional(),
  bootstrap: ZWidgetBootstrap.optional(),
});
export type WidgetBootstrapApiResponse = z.infer<typeof ZWidgetBootstrapApiResponse>;

// DEV_NOTE: Server-side only (WidgetBootstrapRepo → widget route). isSuccess false always comes with a failure, which
// the route maps to an HTTP status like the socket's.
export interface WidgetBootstrapResponse extends ApiResponse {
  bootstrap?: WidgetBootstrap;
  failure?: WidgetAuthFailureEnum;
}

// DEV_NOTE: The widget's history: rows per page of GET /widget/conversations
export const WIDGET_HISTORY_PAGE_SIZE = 20;

// DEV_NOTE: One of the signed-in host user's chats with this chatbot, for the widget's Your chats list. title is the
// first message (chat content: only its own user ever gets it); isOpen = it can still be picked up (Open), else it
// has ended and is shown read-only. lastActivityAt is an ISO string. An eval chat, a chat with no message yet and a
// purged chat are never listed. Client-facing: publicId only.
export const ZWidgetConversationListItem = z.object({
  publicId: z.string(),
  title: z.string(),
  isOpen: z.boolean(),
  lastActivityAt: z.string(),
});
export type WidgetConversationListItem = z.infer<typeof ZWidgetConversationListItem>;

export const ZWidgetConversationsApiResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string().optional(),
  conversations: z.array(ZWidgetConversationListItem).optional(),
  totalRecords: z.number().int().optional(),
});
export type WidgetConversationsApiResponse = z.infer<typeof ZWidgetConversationsApiResponse>;

// DEV_NOTE: One message of a past chat as the read model keeps it: its text and, for a reply, the sources it cites.
// Tool steps and change cards are live-chat details and aren't kept for it.
export const ZWidgetPastMessage = z.object({
  publicId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  citations: z.array(ZKnowledgeCitation),
});
export type WidgetPastMessage = z.infer<typeof ZWidgetPastMessage>;

export const ZWidgetPastConversation = ZWidgetConversationListItem.extend({
  messages: z.array(ZWidgetPastMessage),
});
export type WidgetPastConversation = z.infer<typeof ZWidgetPastConversation>;

export const ZWidgetConversationApiResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string().optional(),
  conversation: ZWidgetPastConversation.optional(),
});
export type WidgetConversationApiResponse = z.infer<typeof ZWidgetConversationApiResponse>;

// DEV_NOTE: Server-side only (WidgetHistoryRepo → widget route). isNotFound = no such chat of this user with this
// chatbot (404, the same answer whether it exists for someone else or not at all).
export interface WidgetConversationsResponse extends ApiResponse {
  conversations?: WidgetConversationListItem[];
  totalRecords?: number;
}

export interface WidgetConversationResponse extends ApiResponse {
  conversation?: WidgetPastConversation;
}
