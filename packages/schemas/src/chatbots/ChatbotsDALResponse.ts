import type { Chatbot } from "./ChatbotsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface ChatbotDALResponse extends ApiResponse {
  chatbot?: Chatbot;
}

export interface ChatbotsDALResponse extends ApiResponse {
  chatbots?: Chatbot[];
}
