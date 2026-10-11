import type { ToolCall } from "./ToolCallsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. The DAL generates
// the publicId and checks the conversation and the tool definition exist in the company. The args arrive encrypted.
export type CreateToolCallDALRequest = Pick<
  ToolCall,
  | "companyId"
  | "conversationId"
  | "turnId"
  | "toolId"
  | "toolVersion"
  | "encryptedArgs"
  | "iv"
  | "encryptionKeyVersion"
  | "hasUntrustedContext"
  | "status"
  | "errorCode"
  | "latencyMs"
>;
