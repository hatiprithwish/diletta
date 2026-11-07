import type { Feedback } from "./FeedbackCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. One rating per
// (message, chatbot user): a second one replaces the first. The DAL generates the publicId and checks the message and
// the chatbot user exist in the company.
export type UpsertFeedbackDALRequest = Pick<
  Feedback,
  "companyId" | "messageId" | "chatbotUserId" | "rating"
>;

// DEV_NOTE: The ratings one chatbot user gave the replies of one conversation (conversationId is internal), the newest
// replies' first, at most limit
export type ListConversationFeedbackDALRequest = Pick<Feedback, "companyId" | "chatbotUserId"> & {
  conversationId: string;
  limit: number;
};

// DEV_NOTE: The note on one chatbot user's rating of one message (M7-10): only an existing rating row gets it
export type SetFeedbackCommentDALRequest = Pick<
  Feedback,
  "companyId" | "messageId" | "chatbotUserId"
> & {
  comment: string;
};
