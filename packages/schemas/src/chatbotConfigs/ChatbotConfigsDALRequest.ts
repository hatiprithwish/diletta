import type { ChatbotConfig } from "./ChatbotConfigsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The chatbot's one published config (UNQ_chatbot_configs_chatbot_id_published).
export type FindPublishedChatbotConfigDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

// DEV_NOTE: The chatbot's newest config not yet published or archived (Draft, Testing, Ready): the Tests page's Draft
// card (M4-8). isNotFound when there is none.
export type FindLatestDraftChatbotConfigDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

// DEV_NOTE: The Conversations page's Config filter (M4-4): every config of the company's chatbots that was ever
// published (live conversations run only on published configs)
export type GetChatbotConfigOptionsDALRequest = Pick<ChatbotConfig, "companyId">;
