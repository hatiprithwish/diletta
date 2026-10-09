import type { ApiResponse } from "../common";
import type { ConfigSpec } from "../configSpec";
import type { ConversationSession } from "./ConversationsCommon";

// DEV_NOTE: Why a conversation couldn't be started or resumed. NotFound covers a conversation that is missing, another
// user's or chatbot's, or closed, without saying which. The widget route maps it to an HTTP status.
export enum ConversationStartFailureEnum {
  NotFound = "NotFound",
  ServerError = "ServerError",
}

// DEV_NOTE: Why a turn can't run. The Conversation DO answers ConversationClosed with {type:"closed"}, everything else
// with {type:"unavailable"}; nothing is saved either way.
//   ChatbotUnavailable: the chatbot was paused, or its company paused or churned, after the socket opened.
//   NoPublishedConfig: the chatbot has nothing published.
export enum TurnConfigFailureEnum {
  ConversationClosed = "ConversationClosed",
  ChatbotUnavailable = "ChatbotUnavailable",
  NoPublishedConfig = "NoPublishedConfig",
  ServerError = "ServerError",
}

// DEV_NOTE: Server-side only (never crosses an API). ConversationsRepo.startOrResume: the session the DO serves, or
// why not. isNew when this call created the conversation (the route closes it again if the DO upgrade then fails).
// outboxId is the conversation.started event of a new conversation, relayed after the commit.
export interface StartConversationResponse extends ApiResponse {
  session?: ConversationSession;
  isNew?: boolean;
  failure?: ConversationStartFailureEnum;
  outboxId?: string;
}

// DEV_NOTE: Server-side only. The published config a turn runs on (loaded through loadConfigSpec, platform defaults
// filled in), checked against the conversation, chatbot and company as they are now.
export interface LoadTurnConfigResponse extends ApiResponse {
  spec?: ConfigSpec;
  chatbotConfigId?: string;
  failure?: TurnConfigFailureEnum;
}
