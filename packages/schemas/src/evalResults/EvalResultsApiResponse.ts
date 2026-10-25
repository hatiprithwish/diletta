import type { ApiResponse } from "../common";
import type { EvalCaseMessageRoleEnum } from "../evalCases";
import type { EvalRunCaseItem } from "../evalRuns";
import type { ToolCallStatusIntEnum, ToolCallStatusLabelEnum } from "../toolCalls";
import type {
  EvalCheckV1,
  EvalTranscriptEntryKindEnum,
  EvalTranscriptFailureEnum,
} from "./EvalResultsCommon";

// DEV_NOTE: One attempt of a case in a run (M4-8). grader null = no grader output, or one that fails
// parseEvalGraderOutput (isGraderOutputUnreadable tells them apart). transcriptFilePublicId opens the transcript
// (GET …/transcripts/:filePublicId); null = none stored.
export interface EvalAttempt {
  attempt: number;
  hasPassed: boolean;
  latencyMs: number | null;
  grader: { checks: EvalCheckV1[]; error: string | null } | null;
  isGraderOutputUnreadable: boolean;
  transcriptFilePublicId: string | null;
  createdAt: string;
}

// DEV_NOTE: GET /dashboard/eval-runs/:publicId/cases/:casePublicId: the case's line in the run and every attempt,
// in order. k = the attempts the run asked for (fewer ran when the run didn't finish).
export interface GetEvalRunCaseApiResponse extends ApiResponse {
  runCase?: EvalRunCaseItem;
  k?: number;
  attempts?: EvalAttempt[];
}

export interface EvalTranscriptMessageView {
  kind: EvalTranscriptEntryKindEnum.Message;
  role: EvalCaseMessageRoleEnum;
  text: string;
}

// DEV_NOTE: Status Enum Pattern for the tool call's status
export interface EvalTranscriptToolCallView {
  kind: EvalTranscriptEntryKindEnum.ToolCall;
  toolName: string;
  toolVersion: number;
  toolCallStatus: ToolCallStatusIntEnum;
  toolCallStatusLabel: ToolCallStatusLabelEnum;
  summary: string | null;
}

export type EvalTranscriptEntryView = EvalTranscriptMessageView | EvalTranscriptToolCallView;

// DEV_NOTE: GET /dashboard/eval-runs/:publicId/transcripts/:filePublicId: the transcript read from R2 and parsed (the
// raw file never reaches the client). failure set (422) = the file is there but unreadable.
export interface GetEvalTranscriptApiResponse extends ApiResponse {
  transcript?: { entries: EvalTranscriptEntryView[] };
  failure?: EvalTranscriptFailureEnum;
}
