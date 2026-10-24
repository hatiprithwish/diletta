import type { EvalCaseMessage } from "../evalCases";
import type { TriageQualityIssueApiRequest } from "./QualityIssuesApiRequest";
import type {
  QualityIssueCloseStatus,
  QualityIssueTypeLabelEnum,
  QualityTestDraft,
} from "./QualityIssuesCommon";

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

// DEV_NOTE: Server-side only (route → QualityIssuesRepo, M4-6). companyId and adminId come from the signed-in admin;
// publicId from the path.
export interface QualityIssueActionRequest {
  companyId: string;
  adminId: string;
  publicId: string;
}

export type TriageQualityIssueRequest = QualityIssueActionRequest & TriageQualityIssueApiRequest;

export type CloseQualityIssueRequest = QualityIssueActionRequest & {
  status: QualityIssueCloseStatus;
};

export type ConvertQualityIssueRequest = QualityIssueActionRequest & {
  draft: QualityTestDraft;
};

// DEV_NOTE: Server-side only — what the rewrite model is shown (QualityTestRewriteProvider): the conversation up to the
// question (oldest first, ending with the user's), the reply that went wrong (null when there is none), and the
// admin's triage (type label, note). Every text is untrusted chat or admin text: it goes inside the prompt's fence.
export interface QualityTestRewriteSource {
  messages: EvalCaseMessage[];
  reply: string | null;
  issueTypeLabel: QualityIssueTypeLabelEnum | null;
  note: string | null;
}
