import type { ChatbotWithStatus } from "./ChatbotsCommon";
import type { ApiResponse } from "../common";

export interface CreateChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface GetChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface GetChatbotsApiResponse extends ApiResponse {
  chatbots?: ChatbotWithStatus[];
}

export interface UpdateChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface SetDefaultChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

// DEV_NOTE: One version a Bots row points at, by public id
export interface ChatbotConfigHead {
  publicId: string;
  configVersion: number;
}

// DEV_NOTE: A row of Settings › Bots (M4-10): the chatbot, its Published version (null = never published), its open
// version (Draft, Testing or Ready; null = none) and the conversations it started over the last
// CHATBOT_CONVERSATION_COUNT_DAYS days
export type ChatbotSettingsRow = ChatbotWithStatus & {
  liveConfig: ChatbotConfigHead | null;
  draftConfig: ChatbotConfigHead | null;
  conversationCount: number;
};

export interface GetChatbotSettingsRowsApiResponse extends ApiResponse {
  chatbots?: ChatbotSettingsRow[];
}
