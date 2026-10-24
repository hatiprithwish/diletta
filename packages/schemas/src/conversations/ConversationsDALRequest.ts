import type { PageDALRequest } from "../common";
import type {
  Conversation,
  ConversationListTabEnum,
  ConversationOutcomeFilterEnum,
  ConversationSortColumn,
} from "./ConversationsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId and checks the chatbot and chatbot user exist in the company.
export type CreateConversationDALRequest = Pick<
  Conversation,
  "companyId" | "chatbotId" | "chatbotUserId"
>;

// Params to find a conversation by its public ID within one company
export type FindConversationDALRequest = Pick<Conversation, "publicId" | "companyId">;

// DEV_NOTE: The activity root, set once right after create (the critical event needs the conversation's id first)
export type SetConversationRootLogDALRequest = FindConversationDALRequest & {
  rootLogId: string;
};

// DEV_NOTE: The config the conversation runs on, updated at the first turn after a publish
export type SetConversationConfigDALRequest = FindConversationDALRequest & {
  chatbotConfigId: string;
};

// DEV_NOTE: After each turn: last_activity_at = now, and title only while it is still unset
export type TouchConversationDALRequest = FindConversationDALRequest & {
  title: string | null;
};

// DEV_NOTE: Closes an Open conversation; a closed one is left as it is
export type CloseConversationDALRequest = FindConversationDALRequest & {
  outcome: NonNullable<Conversation["outcome"]>;
};

// DEV_NOTE: The dashboard list's filters (M4-4), resolved by the Repo: outcome null = any; chatbotConfigId and
// chatbotId are internal ids (from the public ids the client sent), null = any
export type ConversationsFilterDALRequest = Pick<Conversation, "companyId"> & {
  tab: ConversationListTabEnum;
  outcome: ConversationOutcomeFilterEnum | null;
  chatbotConfigId: string | null;
  chatbotId: string | null;
};

// DEV_NOTE: The counts read every tab at once, so they take the filters without one
export type CountDashboardConversationsDALRequest = Omit<ConversationsFilterDALRequest, "tab">;

export type GetDashboardConversationsDALRequest = ConversationsFilterDALRequest &
  PageDALRequest & { sortColumn: ConversationSortColumn };
