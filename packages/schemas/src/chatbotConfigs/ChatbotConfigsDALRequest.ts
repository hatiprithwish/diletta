import type { PageDALRequest } from "../common";
import type { ChatbotConfig, ChatbotConfigSortColumn } from "./ChatbotConfigsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The chatbot's one published config (UNQ_chatbot_configs_chatbot_id_published).
export type FindPublishedChatbotConfigDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

// DEV_NOTE: The chatbot's newest config not yet published or archived (Draft, Testing, Ready): the Tests page's Draft
// card (M4-8). isNotFound when there is none.
export type FindLatestDraftChatbotConfigDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

// DEV_NOTE: The Conversations page's Config filter (M4-4): every config of the company's chatbots that was ever
// published (live conversations run only on published configs)
export type GetChatbotConfigOptionsDALRequest = Pick<ChatbotConfig, "companyId">;

// ─── Settings › Bots (M4-10)

export type GetChatbotConfigsDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId"> &
  PageDALRequest & { sortColumn: ChatbotConfigSortColumn };

export type GetChatbotConfigsCountDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

// DEV_NOTE: One version of one chatbot by its public id. isForUpdate locks the row, so a save, discard or publish
// decides on a status no concurrent write can change in between.
// DEV_NOTE: By public id or internal id. chatbotId set = only that chatbot's config (the dashboard's); unset = any
// chatbot's (an eval run's config, M5-2, checked against its chatbot by the caller).
export type GetChatbotConfigDetailsDALRequest = Pick<ChatbotConfig, "companyId"> &
  ({ publicId: string; id?: undefined } | { id: string; publicId?: undefined }) & {
    chatbotId?: string;
    isForUpdate?: boolean;
  };

// DEV_NOTE: The chatbot's highest config_version (0 when it has none) and whether one of its versions is open (Draft,
// Testing or Ready). Read under the chatbot row's lock, so a new version number and the one-draft rule hold.
export type GetChatbotConfigVersionStateDALRequest = Pick<ChatbotConfig, "companyId" | "chatbotId">;

export type CreateChatbotConfigDALRequest = Pick<
  ChatbotConfig,
  "companyId" | "chatbotId" | "configVersion" | "schemaVersion" | "body" | "bodyHash" | "createdBy"
>;

// DEV_NOTE: Writes a Draft row only (the DAL matches Draft), so a version that left Draft is never edited
export type UpdateChatbotConfigDraftDALRequest = Pick<
  ChatbotConfig,
  "companyId" | "chatbotId" | "publicId" | "schemaVersion" | "body" | "bodyHash" | "updatedBy"
>;

// DEV_NOTE: Draft → Archived (a discarded draft: configs are never deleted, eval runs and conversations point at them)
export type ArchiveChatbotConfigDraftDALRequest = Pick<
  ChatbotConfig,
  "companyId" | "chatbotId" | "publicId" | "updatedBy"
>;

// DEV_NOTE: The chatbot's Published version → Archived; zero rows is fine (its first publish)
export type ArchivePublishedChatbotConfigDALRequest = Pick<
  ChatbotConfig,
  "companyId" | "chatbotId" | "updatedBy"
>;

export type PublishChatbotConfigDALRequest = Pick<
  ChatbotConfig,
  "companyId" | "chatbotId" | "publicId" | "publishedBy"
>;

// DEV_NOTE: The company's Published configs (at most one per chatbot), for the pin guard (M4-10: a pinned tool version
// can't be disabled). Bodies are returned as stored; the Repo reads them through Schemas.readConfigBody, never by
// their raw shape, so a later schema version still guards.
export type GetPublishedChatbotConfigBodiesDALRequest = Pick<ChatbotConfig, "companyId">;

// DEV_NOTE: Each chatbot's Published version and its open one (Draft, Testing or Ready), for the Bots table's Live config
// column and Open draft
export type GetChatbotConfigHeadsDALRequest = Pick<ChatbotConfig, "companyId">;
