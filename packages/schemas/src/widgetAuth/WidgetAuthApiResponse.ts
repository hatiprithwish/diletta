import type { Chatbot } from "../chatbots";
import type { ApiResponse } from "../common";
import type {
  CachedJwks,
  DecodedWidgetJwt,
  WidgetAuthFailureEnum,
  WidgetIdentity,
} from "./WidgetAuthCommon";

// DEV_NOTE: Frames the Conversation DO sends next to Think's own chat frames (cf_agent_*). Only client-facing
// fields: publicIds, names, safe text.
// Sent to each socket as it connects: which conversation it is in (the widget keeps the publicId to resume it).
export interface WidgetConversationMessage {
  type: "conversation";
  conversation: { publicId: string };
  chatbot: { publicId: string; name: string };
}

// DEV_NOTE: A frame the DO won't act on (not allowed, malformed, or sent while a reply is still streaming). The
// socket stays open and nothing was saved.
export interface WidgetErrorMessage {
  type: "error";
  message: string;
}

// DEV_NOTE: The chatbot can't answer right now (no model key, provider failure, no published config). The message
// wasn't saved; the widget shows its unavailable state and may retry later.
export interface WidgetUnavailableMessage {
  type: "unavailable";
  message: string;
}

// DEV_NOTE: The conversation was closed (idle too long); the socket closes next and the widget starts a new one
export interface WidgetConversationClosedMessage {
  type: "closed";
}

export type WidgetServerMessage =
  | WidgetConversationMessage
  | WidgetErrorMessage
  | WidgetUnavailableMessage
  | WidgetConversationClosedMessage;

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
