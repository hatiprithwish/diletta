import type { NullableDALFields, PageDALRequest } from "../common";
import type { ChatbotUser, ChatbotUserBase, ChatbotUserSortColumn } from "./ChatbotUsersCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateChatbotUserDALRequest = ChatbotUserBase & Pick<ChatbotUser, "companyId">;

// Params to find a chatbot user by its host user ID within one company
export type FindChatbotUserDALRequest = Pick<ChatbotUser, "hostUserId" | "companyId">;

// DEV_NOTE: The erasure's steps (M6-2) address the user by chatbot_users.id, except the first, which finds it
export type EraseChatbotUserDALRequest = FindChatbotUserDALRequest;

export interface ChatbotUserContentDALRequest {
  companyId: string;
  chatbotUserId: string;
}

export type GetChatbotUsersCountDALRequest = Pick<ChatbotUser, "companyId">;

export type GetChatbotUsersDALRequest = GetChatbotUsersCountDALRequest &
  PageDALRequest & { sortColumn: ChatbotUserSortColumn };

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateChatbotUserDALRequest = FindChatbotUserDALRequest &
  NullableDALFields<Pick<ChatbotUserBase, "displayName">>;
