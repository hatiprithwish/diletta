import type { ChatbotUserSecret } from "./ChatbotUserSecretsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints + ciphertext). The Repo maps them to API responses.
export interface ChatbotUserSecretDALResponse extends ApiResponse {
  chatbotUserSecret?: ChatbotUserSecret;
}

export interface ChatbotUserSecretsDALResponse extends ApiResponse {
  chatbotUserSecrets?: ChatbotUserSecret[];
}
