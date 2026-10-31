import type { ApiResponse } from "../common";
import type { MessageRoleIntEnum } from "../messages";
import type { ConfigSpec } from "../configSpec";
import type { DocGap, DocGapCandidateDetail, DocGapRewriteSource } from "./DocGapsCommon";

export interface DocGapDALResponse extends ApiResponse {
  docGap?: DocGap;
}

export interface DocGapUserCountDALResponse extends ApiResponse {
  userCount?: number;
}

export interface HasDocGapDALResponse extends ApiResponse {
  hasDocGap?: boolean;
}

// DEV_NOTE: A candidate's handling. isSuccess false = try the message again (a provider or database failure); a
// candidate that can't ever become a gap (budget, no key, no published config, purged chat, no verdict) is a success
// with isDropped, logged where it is decided. isGap = this call stored a gap.
export interface ProcessDocGapCandidateResponse extends ApiResponse {
  outboxIds?: string[];
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

// DEV_NOTE: Server-side only — what processCandidate works from. No ready = nothing to do (message says why, isDropped);
// pendingGap set = an earlier attempt already stored the rewrite, so source and routing aren't read.
export interface DocGapCandidateReady {
  detail: DocGapCandidateDetail;
  companyPublicId: string;
  pendingGap: DocGap | null;
  source: DocGapRewriteSource | null;
  routing: ConfigSpec["routing"] | null;
}

export interface DocGapCandidateInputsResponse extends ApiResponse {
  ready?: DocGapCandidateReady;
}

export interface OpenDocGapQualityIssueResponse extends ApiResponse {
  isOpened?: boolean;
  outboxId?: string;
}

// DEV_NOTE: outboxId unset = there was no open item to close
export interface CloseDocGapQualityIssueResponse extends ApiResponse {
  outboxId?: string;
}
