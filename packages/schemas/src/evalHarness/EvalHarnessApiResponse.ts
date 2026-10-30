import { z } from "zod";
import type { ApiResponse } from "../common";
import {
  ZCreateEvalRunApiRequest,
  ZEvalReadbackApiRequest,
  ZFinishEvalRunApiRequest,
  ZRecordEvalResultApiRequest,
  ZRunEvalAttemptApiRequest,
} from "./EvalHarnessApiRequest";
import type { Chatbot } from "../chatbots/ChatbotsCommon";
import type { ConversationSession } from "../conversations/ConversationsCommon";
import {
  EvalRunStatusIntEnum,
  EvalRunStatusLabelEnum,
  type EvalRun,
} from "../evalRuns/EvalRunsCommon";
import type { DashboardEvalRunRow } from "../evalRuns/EvalRunsDALResponse";
import {
  EvalReadbackVerdictEnum,
  EvalTurnStatusEnum,
  ZEvalAttemptToolCall,
  ZEvalHarnessCase,
  ZEvalHarnessRun,
  ZEvalReadbackField,
  type DecodedEvalJwt,
  EVAL_REFUSAL_FAILURES,
  EvalAttemptFailureEnum,
  type EvalAuthFailureEnum,
  type EvalHarnessCase,
  type EvalHarnessRun,
  type EvalIdentity,
  type EvalReadbackCheck,
  type EvalRunStepFailureEnum,
} from "./EvalHarnessCommon";

// DEV_NOTE: What /eval/* answers the harness (M5-2). Zod, because they are exported to evals/schemas/eval-api.schema.json
// and the harness parses every answer with the generated types. Public ids only. A refusal is { isSuccess: false,
// message, failure } with the failure's HTTP status.

export const ZCreateEvalRunApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    run: ZEvalHarnessRun,
    // DEV_NOTE: The run's cases: the config's chatbot's active cases and every active platform case, in a fixed order
    cases: z.array(ZEvalHarnessCase),
  })
  .meta({ id: "CreateEvalRunApiResponse" });
export type CreateEvalRunApiResponse = z.infer<typeof ZCreateEvalRunApiResponse>;

export const ZRunEvalAttemptApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    conversationId: z.string(),
    turnStatus: z.enum(EvalTurnStatusEnum),
    // DEV_NOTE: The chatbot's last reply of the attempt ("" when the turn ended without one)
    reply: z.string(),
    toolCalls: z.array(ZEvalAttemptToolCall),
    latencyMs: z.number().int().min(0),
  })
  .meta({ id: "RunEvalAttemptApiResponse" });
export type RunEvalAttemptApiResponse = z.infer<typeof ZRunEvalAttemptApiResponse>;

export const ZEvalReadbackApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    verdict: z.enum(EvalReadbackVerdictEnum),
    fields: z.array(ZEvalReadbackField),
    reason: z.string().nullable(),
  })
  .meta({ id: "EvalReadbackApiResponse" });
export type EvalReadbackApiResponse = z.infer<typeof ZEvalReadbackApiResponse>;

export const ZRecordEvalResultApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
  })
  .meta({ id: "RecordEvalResultApiResponse" });
export type RecordEvalResultApiResponse = z.infer<typeof ZRecordEvalResultApiResponse>;

// DEV_NOTE: isReset false = the connection has no reset_op (nothing to put back)
export const ZResetEvalRunApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    isReset: z.boolean(),
  })
  .meta({ id: "ResetEvalRunApiResponse" });
export type ResetEvalRunApiResponse = z.infer<typeof ZResetEvalRunApiResponse>;

export const ZFinishEvalRunApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    status: z.enum(EvalRunStatusIntEnum),
    statusLabel: z.enum(EvalRunStatusLabelEnum),
    caseCount: z.number().int().min(0),
    passAllKCount: z.number().int().min(0),
    hasPassed: z.boolean(),
    costUsd: z.string(),
  })
  .meta({ id: "FinishEvalRunApiResponse" });
export type FinishEvalRunApiResponse = z.infer<typeof ZFinishEvalRunApiResponse>;

// DEV_NOTE: Any refusal. failure is one of the eval enums (auth, attempt or run step): the harness decides by it, never
// by the HTTP status alone (an attempt the chatbot couldn't answer is a failed attempt; a ServerError stops the run).
export const ZEvalRefusalApiResponse = z
  .object({
    isSuccess: z.literal(false),
    message: z.string(),
    failure: z.enum(EVAL_REFUSAL_FAILURES).optional(),
  })
  .meta({ id: "EvalRefusalApiResponse" });
export type EvalRefusalApiResponse = z.infer<typeof ZEvalRefusalApiResponse>;

// ─── Server-side only ───────────────────────────────────────────────────────

export interface DecodeEvalJwtResponse extends ApiResponse {
  jwt?: DecodedEvalJwt;
}

export interface VerifyEvalJwtResponse extends ApiResponse {
  failure?: EvalAuthFailureEnum;
}

// DEV_NOTE: The eval caller (EvalAuthRepo.authenticate): who the token names, or why it was refused
export type EvalAuthResponse =
  | { isSuccess: true; message: string; identity: EvalIdentity }
  | { isSuccess: false; message: string; failure: EvalAuthFailureEnum };

export interface CreateEvalRunResponse extends ApiResponse {
  failure?: EvalRunStepFailureEnum;
  run?: EvalHarnessRun;
  cases?: EvalHarnessCase[];
}

// DEV_NOTE: An attempt's conversation, ready for the DO: the session (with its eval context). outboxId = its
// conversation.started event, relayed after the commit.
export interface StartEvalConversationResponse extends ApiResponse {
  failure?: EvalAttemptFailureEnum;
  session?: ConversationSession;
  outboxId?: string;
  // DEV_NOTE: The attempt already has its conversation: nothing was started
  isDuplicate?: boolean;
}

// DEV_NOTE: What the Conversation DO's runEvalAttempt answers the worker (DO RPC). It crosses the RPC as JSON text,
// parsed back with this schema: the RPC type of a recursive JSON value (a tool call's args) is too deep for the
// compiler.
export const ZEvalAttemptRunResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string().optional(),
  failure: z.enum(EvalAttemptFailureEnum).optional(),
  turnStatus: z.enum(EvalTurnStatusEnum).optional(),
  reply: z.string().optional(),
  toolCalls: z.array(ZEvalAttemptToolCall).optional(),
});
export type EvalAttemptRunResponse = z.infer<typeof ZEvalAttemptRunResponse>;

// DEV_NOTE: An attempt as EvalHarnessRepo answers the route: what the DO ran, a run step refusal (nothing started), or
// an attempt that couldn't run (its conversation may have started: outboxIds to relay). failure is one enum or the
// other, told apart by kind, each with its own HTTP status map.
export type RunEvalAttemptResponse =
  | {
      isSuccess: true;
      message: string;
      outboxIds: string[];
      attempt: Omit<RunEvalAttemptApiResponse, "isSuccess" | "message">;
    }
  | { isSuccess: false; message: string; kind: "step"; failure: EvalRunStepFailureEnum }
  | {
      isSuccess: false;
      message: string;
      kind: "attempt";
      failure: EvalAttemptFailureEnum;
      outboxIds: string[];
    };

export interface EvalReadbackResponse extends ApiResponse {
  failure?: EvalRunStepFailureEnum;
  check?: EvalReadbackCheck;
}

export interface EvalRunStepResponse extends ApiResponse {
  failure?: EvalRunStepFailureEnum;
}

export interface ResetEvalRunResponse extends EvalRunStepResponse {
  isReset?: boolean;
}

export interface FinishEvalRunResponse extends EvalRunStepResponse {
  run?: Pick<EvalRun, "status" | "caseCount" | "passAllKCount" | "hasPassed" | "costUsd">;
}

// DEV_NOTE: EvalHarnessRepo's own checks, each a refusal (failure) or what it found: the token company's Running run
// with its config's chatbot, a case of that run, the run's chatbot (active), a conversation of the run
export interface EvalRunningRunResponse extends EvalRunStepResponse {
  run?: DashboardEvalRunRow;
  chatbotId?: string;
}

export interface EvalAttemptCheckResponse extends EvalRunStepResponse {
  run?: DashboardEvalRunRow;
  chatbot?: Chatbot;
  evalCaseId?: string;
}

export interface EvalRunCaseResponse extends EvalRunStepResponse {
  evalCaseId?: string;
}

export interface EvalRunChatbotResponse extends EvalRunStepResponse {
  chatbot?: Chatbot;
}

export interface EvalRunConversationResponse extends EvalRunStepResponse {
  conversationId?: string;
}

// DEV_NOTE: The whole /eval/* API as one object, for the JSON Schema export (evals/schemas/eval-api.schema.json): each
// message is a $def named by its meta id, so the generated Python module has one model per message. Never sent.
export const ZEvalApiContract = z.object({
  createRunRequest: ZCreateEvalRunApiRequest,
  createRunResponse: ZCreateEvalRunApiResponse,
  runAttemptRequest: ZRunEvalAttemptApiRequest,
  runAttemptResponse: ZRunEvalAttemptApiResponse,
  readbackRequest: ZEvalReadbackApiRequest,
  readbackResponse: ZEvalReadbackApiResponse,
  recordResultRequest: ZRecordEvalResultApiRequest,
  recordResultResponse: ZRecordEvalResultApiResponse,
  resetResponse: ZResetEvalRunApiResponse,
  finishRequest: ZFinishEvalRunApiRequest,
  finishResponse: ZFinishEvalRunApiResponse,
  refusal: ZEvalRefusalApiResponse,
});
