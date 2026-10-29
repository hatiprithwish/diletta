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

// DEV_NOTE: A version row with the name of the admin who last saved it (else created it): left join, null when gone
export type ChatbotConfigVersionRow = ChatbotConfig & { editedByName: string | null };

export interface ChatbotConfigVersionDALResponse extends ApiResponse {
  chatbotConfig?: ChatbotConfigVersionRow;
}

export interface ChatbotConfigVersionsDALResponse extends ApiResponse {
  chatbotConfigs?: ChatbotConfigVersionRow[];
}

export interface ChatbotConfigVersionStateDALResponse extends ApiResponse {
  latestVersion?: number;
  hasOpenVersion?: boolean;
}

export interface PublishedChatbotConfigBodiesDALResponse extends ApiResponse {
  configs?: Pick<ChatbotConfig, "publicId" | "schemaVersion" | "body">[];
}

// DEV_NOTE: chatbotId is internal (the Repo matches it to its chatbots)
export interface ChatbotConfigHeadsDALResponse extends ApiResponse {
  heads?: Pick<ChatbotConfig, "chatbotId" | "publicId" | "configVersion" | "status">[];
}
