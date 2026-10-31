import type { ApiResponse } from "../common";
import type { MessageRoleIntEnum } from "../messages";
import type { DocGap } from "./DocGapsCommon";

export interface DocGapDALResponse extends ApiResponse {
  docGap?: DocGap;
}

export interface DocGapConversationCountDALResponse extends ApiResponse {
  conversationCount?: number;
}

export interface HasDocGapDALResponse extends ApiResponse {
  hasDocGap?: boolean;
}

// DEV_NOTE: A candidate's handling. isSuccess false = try the message again (a provider or database failure); a
// candidate that can't ever become a gap (budget, no key, no published config, purged chat, no verdict) is a success
// with isDropped, logged where it is decided. isGap = this call stored a gap.
export interface ProcessDocGapCandidateResponse extends ApiResponse {
  isDropped?: boolean;
  isGap?: boolean;
  qualityIssueOpened?: boolean;
}

export interface DocGapCandidateMessage {
  role: MessageRoleIntEnum;
  text: string | null;
  contentPurgedAt: Date | null;
  evalRunId: string | null;
}

export interface DocGapCandidateMessagesDALResponse extends ApiResponse {
  messages?: DocGapCandidateMessage[];
}

export interface OpenDocGapQualityIssueResponse extends ApiResponse {
  isOpened?: boolean;
  outboxId?: string;
}

// DEV_NOTE: outboxId unset = there was no open item to close
export interface CloseDocGapQualityIssueResponse extends ApiResponse {
  outboxId?: string;
}
