import type { Chatbot } from "../chatbots";
import type { ApiResponse } from "../common";
import type {
  CachedJwks,
  DecodedWidgetJwt,
  WidgetAuthFailureEnum,
  WidgetIdentity,
} from "./WidgetAuthCommon";

// DEV_NOTE: Sent once the auth message verifies. Only client-facing fields: the chatbot by its publicId.
export interface WidgetAuthOkMessage {
  type: "auth_ok";
  chatbot: { publicId: string; name: string };
}

// DEV_NOTE: A message the server can't act on. The socket stays open; a failed auth closes it instead.
export interface WidgetErrorMessage {
  type: "error";
  message: string;
}

export type WidgetServerMessage = WidgetAuthOkMessage | WidgetErrorMessage;

// DEV_NOTE: Server-side only (WidgetAuthRepo → widget route / Conversation DO): identity carries internal ids.
// isSuccess false always comes with a failure, which the route maps to a close code.
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
// failure says how a miss maps to a close code.
export interface WidgetChatbotResponse extends ApiResponse {
  chatbot?: Chatbot;
  failure?: WidgetAuthFailureEnum;
}
