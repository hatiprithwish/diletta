import type { ApiResponse } from "../common";
import type { ChangeRequestStatusIntEnum } from "../changeRequests/ChangeRequestsCommon";
import type { ToolCall, ToolCallStatusIntEnum } from "./ToolCallsCommon";

export interface ToolCallDALResponse extends ApiResponse {
  toolCall?: ToolCall;
}

// DEV_NOTE: A tool call as the dashboard transcript shows it (M4-4): no args (encrypted, never shown), its tool's name
// (null = the definition is gone) and the change request it proposed, if any (one per tool call)
export interface TranscriptToolCallRow {
  publicId: string;
  turnId: string;
  toolName: string | null;
  toolVersion: number;
  status: ToolCallStatusIntEnum;
  errorCode: string | null;
  createdAt: Date;
  change: {
    publicId: string;
    summary: string;
    changeCount: number;
    status: ChangeRequestStatusIntEnum;
    errorCode: string | null;
  } | null;
}

export interface TranscriptToolCallsDALResponse extends ApiResponse {
  toolCalls?: TranscriptToolCallRow[];
}
