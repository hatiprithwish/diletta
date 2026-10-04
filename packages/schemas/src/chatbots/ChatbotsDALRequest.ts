import type { NullableDALFields } from "../common";
import type { Chatbot, ChatbotBase } from "./ChatbotsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateChatbotDALRequest = ChatbotBase & Pick<Chatbot, "companyId">;

// Params to find a chatbot by its public ID within one company
export type FindChatbotDALRequest = Pick<Chatbot, "publicId" | "companyId">;

export type GetChatbotsDALRequest = Pick<Chatbot, "companyId">;

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateChatbotDALRequest = FindChatbotDALRequest &
  NullableDALFields<ChatbotBase & Pick<Chatbot, "status">>;

export type ClearDefaultChatbotDALRequest = Pick<Chatbot, "companyId">;
