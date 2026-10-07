import type { NullableDALFields } from "../common";
import type { ChatbotUser, ChatbotUserBase } from "./ChatbotUsersCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateChatbotUserDALRequest = ChatbotUserBase & Pick<ChatbotUser, "companyId">;

// Params to find a chatbot user by its host user ID within one company
export type FindChatbotUserDALRequest = Pick<ChatbotUser, "hostUserId" | "companyId">;

export type GetChatbotUsersDALRequest = Pick<ChatbotUser, "companyId">;

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateChatbotUserDALRequest = FindChatbotUserDALRequest &
  NullableDALFields<Pick<ChatbotUserBase, "displayName">>;
