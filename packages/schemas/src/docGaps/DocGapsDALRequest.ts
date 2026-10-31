import type { DocGap } from "./DocGapsCommon";
import type { QualityIssueCloseStatus } from "../qualityIssues";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.

// DEV_NOTE: One gap per user message (UNQ_doc_gaps_message_id), pending; question_generic is already rewritten and checked
export type CreateDocGapDALRequest = Pick<
  DocGap,
  "companyId" | "chatbotId" | "conversationId" | "messageId" | "questionGeneric" | "signal"
>;

// DEV_NOTE: A pending gap into its group, with the embedding that placed it
export type AttachDocGapToClusterDALRequest = Pick<DocGap, "companyId" | "id"> & {
  clusterId: string;
  embedding: number[];
};

export type GetDocGapByMessageDALRequest = Pick<DocGap, "companyId"> & { messageId: string };

export type CountDocGapUsersDALRequest = Pick<DocGap, "companyId"> & { clusterId: string };

export type HasDocGapOnLastUserMessageDALRequest = Pick<DocGap, "companyId"> & {
  conversationId: string;
};

export type GetDocGapCandidateMessagesDALRequest = Pick<DocGap, "companyId"> & {
  messageId: string;
};

// DEV_NOTE: DocGapQualityProvider's params: the group opening its one Quality item, or closed by an admin
export interface OpenDocGapQualityIssueRequest {
  companyId: string;
  chatbotId: string;
  docGapClusterId: string;
  label: string;
}

export interface CloseDocGapQualityIssueRequest {
  companyId: string;
  docGapClusterId: string;
  status: QualityIssueCloseStatus;
  adminId: string;
}

// DEV_NOTE: Groups reopened by removing their document: the items closing them marked Fixed open again
export interface ReopenDocGapQualityIssuesRequest {
  companyId: string;
  docGapClusterIds: string[];
}

export interface MarkClosedConversationUnansweredDALRequest {
  companyId: string;
  id: string;
}
