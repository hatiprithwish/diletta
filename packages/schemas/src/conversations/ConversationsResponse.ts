import { z } from "zod";
import type { ApiResponse } from "../common";
import type { ConfigSpec } from "../configSpec";
import type { Company } from "../companies/CompaniesCommon";
import type { Conversation, ConversationSession } from "./ConversationsCommon";

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
// DEV_NOTE: isReadOnly = the company's is_read_only switch (M3-4): the agent may only read, so write tools are left out
// DEV_NOTE: Server-side only — ConversationCheckProvider, the step every turn and change request step starts with: the
// conversation as it is now (open), and its company and chatbot active; or why not. NotFound: no such conversation in
// the company. ServerError: a read failed.
export enum ConversationCheckFailureEnum {
  NotFound = "NotFound",
  ConversationClosed = "ConversationClosed",
  ChatbotUnavailable = "ChatbotUnavailable",
  ServerError = "ServerError",
}

export type ConversationCheckResponse =
  | { isSuccess: true; conversation: Conversation; company: Company }
  | { isSuccess: false; failure: ConversationCheckFailureEnum; message: string };

export interface LoadTurnConfigResponse extends ApiResponse {
  spec?: ConfigSpec;
  chatbotConfigId?: string;
  isReadOnly?: boolean;
  failure?: TurnConfigFailureEnum;
}

// DEV_NOTE: The retention purge's run (M6-1): chats cleared, and chats left for the next run (a turn running, a new
// message since the read, a step that failed), and companies with a chat overdue after it (alerted)
export interface PurgeConversationContentResponse extends ApiResponse {
  purgedCount?: number;
  skippedCount?: number;
  overdueCompanyCount?: number;
}

// DEV_NOTE: ConversationDO.purgeContent's answer over DO RPC. isBusy = a turn, decision or close is running; nothing wiped.
export const ZConversationContentWipeResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string(),
  isBusy: z.boolean(),
});
export type ConversationContentWipeResponse = z.infer<typeof ZConversationContentWipeResponse>;
