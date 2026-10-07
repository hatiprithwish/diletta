import type {
  ChatbotUserSecretValue,
  ChatbotUserSecretWithStatus,
} from "./ChatbotUserSecretsCommon";
import type { ApiResponse } from "../common";

export interface CreateChatbotUserSecretApiResponse extends ApiResponse {
  chatbotUserSecret?: ChatbotUserSecretWithStatus;
}

export interface GetChatbotUserSecretApiResponse extends ApiResponse {
  chatbotUserSecret?: ChatbotUserSecretWithStatus;
}

export interface GetChatbotUserSecretsApiResponse extends ApiResponse {
  chatbotUserSecrets?: ChatbotUserSecretWithStatus[];
}

export interface UpdateChatbotUserSecretApiResponse extends ApiResponse {
  chatbotUserSecret?: ChatbotUserSecretWithStatus;
}

// DEV_NOTE: Server-side only (AuthStrategy) — never a route response body
export interface DecryptedChatbotUserSecretResponse extends ApiResponse {
  secret?: ChatbotUserSecretValue;
}
