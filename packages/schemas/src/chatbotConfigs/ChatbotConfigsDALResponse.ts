import type { ChatbotConfig } from "./ChatbotConfigsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface ChatbotConfigDALResponse extends ApiResponse {
  chatbotConfig?: ChatbotConfig;
}
