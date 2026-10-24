import type { ChatbotConfig } from "./ChatbotConfigsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface ChatbotConfigDALResponse extends ApiResponse {
  chatbotConfig?: ChatbotConfig;
}

// DEV_NOTE: One Config filter choice; id and chatbotId are internal (the Repo resolves a configId with them)
export interface ChatbotConfigOptionRow {
  id: string;
  publicId: string;
  chatbotId: string;
  chatbotName: string;
  configVersion: number;
}

export interface ChatbotConfigOptionsDALResponse extends ApiResponse {
  options?: ChatbotConfigOptionRow[];
}
