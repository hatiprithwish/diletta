// DEV_NOTE: Server-side only (FeedbackRepo → UserQualityIssueProvider, M2-8). Every id is internal and comes from the
// Conversation DO's verified session or the rows the Repo just read and wrote in the same transaction. conversationRootLogId
// is the conversation's root log (conversation.started), the parent and root of the issue's event.
export interface OpenUserQualityIssueRequest {
  companyId: string;
  conversationId: string;
  conversationRootLogId: string | null;
  chatbotUserId: string;
  messageId: string;
  feedbackId: string;
}

// DEV_NOTE: Server-side only (route → QualityIssuesRepo.flagConversation, M4-4). companyId and adminId come from the
// signed-in admin; conversationPublicId from the path.
export interface FlagConversationRequest {
  companyId: string;
  adminId: string;
  conversationPublicId: string;
}
