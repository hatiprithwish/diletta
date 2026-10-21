import type { ApiResponse } from "../common";
import type { ToolCall } from "./ToolCallsCommon";

export interface ToolCallDALResponse extends ApiResponse {
  toolCall?: ToolCall;
}
