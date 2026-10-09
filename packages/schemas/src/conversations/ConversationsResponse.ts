import type { ApiResponse } from "../common";
import type { ConfigSpec } from "../configSpec";
import type { WidgetAuthFailureEnum } from "../widgetAuth";
import type { ConversationSession } from "./ConversationsCommon";

// DEV_NOTE: Server-side only (never crosses an API). ConversationsRepo.startOrResume: the session the DO serves, or why
// the widget can't have it (mapped to an HTTP status). outboxId is the conversation.started event of a new
// conversation, relayed after the commit.
export interface StartConversationResponse extends ApiResponse {
  session?: ConversationSession;
  failure?: WidgetAuthFailureEnum;
  outboxId?: string;
}

// DEV_NOTE: Server-side only. The published config a turn runs on (loaded through loadConfigSpec, platform defaults
// filled in). isNotFound when the chatbot has no published config.
export interface LoadTurnConfigResponse extends ApiResponse {
  spec?: ConfigSpec;
  chatbotConfigId?: string;
}
