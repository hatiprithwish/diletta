import { z } from "zod";
import { FeedbackRatingIntEnum, ZWidgetFeedbackRatings } from "../feedback";
import type { Chatbot } from "../chatbots";
import { ZWidgetChangeRequest } from "../changeRequests/ChangeRequestsCommon";
import type { ApiResponse } from "../common";
import type {
  CachedJwks,
  DecodedWidgetJwt,
  WidgetAuthFailureEnum,
  WidgetIdentity,
} from "./WidgetAuthCommon";

// DEV_NOTE: Frames the Conversation DO sends next to Think's own chat frames (cf_agent_*). Only client-facing
// fields: publicIds, names, Think message ids, safe text. Zod schemas, because the widget parses every frame it
// receives before acting on it (ZWidgetServerMessage).
// Sent to each socket as it connects: which conversation it is in (the widget keeps the publicId to resume it), the
// chatbot, and the ratings the user already gave this conversation's replies (M2-7).
export const ZWidgetConversationMessage = z.object({
  type: z.literal("conversation"),
  conversation: z.object({ publicId: z.string() }),
  chatbot: z.object({ publicId: z.string(), name: z.string() }),
  feedback: ZWidgetFeedbackRatings,
});
export type WidgetConversationMessage = z.infer<typeof ZWidgetConversationMessage>;

// DEV_NOTE: A frame the DO won't act on (not allowed, malformed, or sent while a reply is still streaming). The
// socket stays open and nothing was saved.
export const ZWidgetErrorMessage = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type WidgetErrorMessage = z.infer<typeof ZWidgetErrorMessage>;

// DEV_NOTE: The chatbot can't answer right now (no model key, provider failure, no published config). The message
// wasn't saved; the widget shows its unavailable state and may retry later.
export const ZWidgetUnavailableMessage = z.object({
  type: z.literal("unavailable"),
  message: z.string(),
});
export type WidgetUnavailableMessage = z.infer<typeof ZWidgetUnavailableMessage>;

// DEV_NOTE: The conversation was closed (idle too long); the socket closes next and the widget starts a new one
export const ZWidgetConversationClosedMessage = z.object({
  type: z.literal("closed"),
});
export type WidgetConversationClosedMessage = z.infer<typeof ZWidgetConversationClosedMessage>;

// DEV_NOTE: The answer to a feedback frame (M2-7): the rating now stored for that reply, or null when it wasn't saved
// (the widget goes back to what it showed before)
export const ZWidgetFeedbackMessage = z.object({
  type: z.literal("feedback"),
  messageId: z.string(),
  rating: z.enum(FeedbackRatingIntEnum).nullable(),
});
export type WidgetFeedbackMessage = z.infer<typeof ZWidgetFeedbackMessage>;

// DEV_NOTE: One change request as it now stands (M3-4): sent to every socket when a write is proposed and at each
// status change after it, and on connect for the ones still open. Carries the diff's values (the user's own host data,
// to their own widget only); the review UI is M3-5.
export const ZWidgetChangeRequestMessage = z.object({
  type: z.literal("change_request"),
  changeRequest: ZWidgetChangeRequest,
});
export type WidgetChangeRequestMessage = z.infer<typeof ZWidgetChangeRequestMessage>;

// DEV_NOTE: The DO has no usable host token for a step that needs one (an approval). The widget fetches a fresh one
// from its host and sends it in a host_token frame (M3-8), then tries again; nothing was done.
export const ZWidgetTokenNeededMessage = z.object({
  type: z.literal("token_needed"),
});
export type WidgetTokenNeededMessage = z.infer<typeof ZWidgetTokenNeededMessage>;

export const ZWidgetServerMessage = z.discriminatedUnion("type", [
  ZWidgetConversationMessage,
  ZWidgetErrorMessage,
  ZWidgetUnavailableMessage,
  ZWidgetConversationClosedMessage,
  ZWidgetFeedbackMessage,
  ZWidgetChangeRequestMessage,
  ZWidgetTokenNeededMessage,
]);
export type WidgetServerMessage = z.infer<typeof ZWidgetServerMessage>;

// DEV_NOTE: Server-side only (WidgetAuthRepo → widget route): identity carries internal ids.
// isSuccess false always comes with a failure, which the route maps to an HTTP status.
export interface WidgetAuthResponse extends ApiResponse {
  identity?: WidgetIdentity;
  failure?: WidgetAuthFailureEnum;
}

// DEV_NOTE: Server-side only (JwksProvider): the issuer's JWKS and when it was fetched
export interface JwksResponse extends ApiResponse {
  jwks?: CachedJwks;
}

// DEV_NOTE: Server-side only (WidgetJwtProvider.decode): parsed but NOT yet verified, so nothing in it may be
// trusted beyond picking the connection row and the key to verify with
export interface DecodeWidgetJwtResponse extends ApiResponse {
  jwt?: DecodedWidgetJwt;
}

// DEV_NOTE: Server-side only (WidgetJwtProvider.verifySignature / checkClaims). failure tells a rejected token
// (Unauthorized) from an issuer whose JWKS couldn't be read (ServerError).
export interface VerifyWidgetJwtResponse extends ApiResponse {
  failure?: WidgetAuthFailureEnum;
}

// DEV_NOTE: Server-side only (WidgetAuthRepo): the chatbot the widget talks to, once its company checks out.
// failure says how a miss maps to an HTTP status.
export interface WidgetChatbotResponse extends ApiResponse {
  chatbot?: Chatbot;
  failure?: WidgetAuthFailureEnum;
}
