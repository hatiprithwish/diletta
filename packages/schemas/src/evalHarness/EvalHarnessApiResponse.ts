import { z } from "zod";
import type { ApiResponse } from "../common";
import {
  ZCreateEvalRunApiRequest,
  ZEvalJudgeApiRequest,
  ZEvalReadbackApiRequest,
  ZFinishEvalRunApiRequest,
  ZRecordEvalResultApiRequest,
  ZRunEvalAttemptApiRequest,
} from "./EvalHarnessApiRequest";
import type { Chatbot } from "../chatbots/ChatbotsCommon";
import type { ConfigSpec } from "../configSpec";
import type { ConversationSession } from "../conversations/ConversationsCommon";
import {
  EvalRunStatusIntEnum,
  EvalRunStatusLabelEnum,
  type EvalRun,
} from "../evalRuns/EvalRunsCommon";
import type { DashboardEvalRunRow } from "../evalRuns/EvalRunsDALResponse";
import { ModelProviderEnum } from "../companySecrets/CompanySecretsCommon";
import type { EvalTranscript } from "../evalResults/EvalResultsCommon";
import {
  type EvalAttemptRecord,
  EVAL_JUDGE_REASON_MAX_CHARS,
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

// DEV_NOTE: The pinned judge's verdict on one attempt (M5-3): whether the reply meets the rubric and why, and which
// judge gave it (the provider's pinned model, the prompt version). Its model call is the run's (cost, budget).
export const ZEvalJudgeApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    hasPassed: z.boolean(),
    reason: z.string().min(1).max(EVAL_JUDGE_REASON_MAX_CHARS),
    provider: z.enum(ModelProviderEnum),
    model: z.string(),
    promptVersion: z.number().int().min(1),
  })
  .meta({ id: "EvalJudgeApiResponse" });
export type EvalJudgeApiResponse = z.infer<typeof ZEvalJudgeApiResponse>;

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
    // DEV_NOTE: Safety cases of the set that didn't pass all k, a never-run one included (M5-4): any one fails the run
    failedSafetyCaseCount: z.number().int().min(0),
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

export interface EvalJudgeResponse extends EvalRunStepResponse {
  verdict?: Omit<EvalJudgeApiResponse, "isSuccess" | "message">;
}

// DEV_NOTE: outboxIds = the audit row of a Gate run's move of its version (M5-4), relayed by the route after the commit
export interface FinishEvalRunResponse extends EvalRunStepResponse {
  outboxIds?: string[];
  run?: Pick<EvalRun, "status" | "caseCount" | "passAllKCount" | "hasPassed" | "costUsd"> & {
    failedSafetyCaseCount: number;
  };
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

// DEV_NOTE: The config a run starts on (M5-5): by the public id the request named, or by the internal id of the chatbot's
// published config
export interface EvalRunConfigTargetResponse extends EvalRunStepResponse {
  target?: { publicId: string; id?: undefined } | { id: string; publicId?: undefined };
}

export interface EvalRunConversationResponse extends EvalRunStepResponse {
  conversationId?: string;
}

// DEV_NOTE: A conversation of the run with what its transcript and judge need: the run and its config's chatbot
// (internal ids: the judge's model call is the run's), the conversation (internal id and public id, the DO's name), the
// company's public id (the R2 key), and the run config's tool pins (name → version: a transcript tool call names the
// version it ran) and routing (the judge's provider)
export interface EvalRunTranscriptSourceResponse extends EvalRunStepResponse {
  source?: EvalRunTranscriptSource;
}

export interface EvalRunTranscriptSource {
  evalRunId: string;
  chatbotId: string;
  conversationId: string;
  conversationPublicId: string;
  companyPublicId: string;
  toolVersions: Record<string, number>;
  routing: ConfigSpec["routing"];
}

// DEV_NOTE: A recorded attempt's source: hasConversation false = it never started (no transcript to store)
export interface EvalResultSourceResponse extends EvalRunTranscriptSourceResponse {
  hasConversation?: boolean;
}

// DEV_NOTE: The Running run, its chatbot and the case of the run a result is for
export interface EvalResultCaseResponse extends EvalRunningRunResponse {
  evalCaseId?: string;
}

// DEV_NOTE: An attempt as its DO and change requests hold it (EvalTranscriptsRepo.read)
export interface EvalAttemptRecordResponse extends EvalRunStepResponse {
  record?: EvalAttemptRecord;
}

// DEV_NOTE: An attempt's transcript stored (EvalTranscriptsRepo.store): its files row, still pending its owner, and the
// R2 object written after it. The result's transaction attaches it (EvalTranscriptFilesProvider.attach).
export interface StoredEvalTranscriptResponse extends EvalRunStepResponse {
  stored?: { fileId: string; fileR2Key: string };
}

// DEV_NOTE: Transcript v1 as stored: the parsed transcript and the exact text of its R2 file (the parsed one, serialized)
export interface BuiltEvalTranscript {
  transcript: EvalTranscript;
  text: string;
  bytes: Uint8Array;
}

// DEV_NOTE: Why a transcript couldn't be built (EvalTranscriptProvider.build): it doesn't hold to ZEvalTranscriptV1 (a
// bug), or it is still over EVAL_TRANSCRIPT_MAX_BYTES at the smallest text cap
export enum EvalTranscriptBuildFailureEnum {
  Invalid = "Invalid",
  TooLarge = "TooLarge",
}

export type BuildEvalTranscriptResponse =
  | { isSuccess: true; built: BuiltEvalTranscript }
  | { isSuccess: false; failure: EvalTranscriptBuildFailureEnum };

// DEV_NOTE: The whole /eval/* API as one object, for the JSON Schema export (evals/schemas/eval-api.schema.json): each
// message is a $def named by its meta id, so the generated Python module has one model per message. Never sent.
export const ZEvalApiContract = z.object({
  createRunRequest: ZCreateEvalRunApiRequest,
  createRunResponse: ZCreateEvalRunApiResponse,
  runAttemptRequest: ZRunEvalAttemptApiRequest,
  runAttemptResponse: ZRunEvalAttemptApiResponse,
  readbackRequest: ZEvalReadbackApiRequest,
  readbackResponse: ZEvalReadbackApiResponse,
  judgeRequest: ZEvalJudgeApiRequest,
  judgeResponse: ZEvalJudgeApiResponse,
  recordResultRequest: ZRecordEvalResultApiRequest,
  recordResultResponse: ZRecordEvalResultApiResponse,
  resetResponse: ZResetEvalRunApiResponse,
  finishRequest: ZFinishEvalRunApiRequest,
  finishResponse: ZFinishEvalRunApiResponse,
  refusal: ZEvalRefusalApiResponse,
});

// DEV_NOTE: The transcript sweep (EvalTranscriptsRepo.sweepPending): pending transcript rows removed with their objects
export interface SweepEvalTranscriptsResponse extends ApiResponse {
  sweptCount?: number;
}

// DEV_NOTE: One sweep batch's transaction: the R2 keys of the rows it actually removed (still pending at the delete)
export interface SweptEvalTranscriptsResponse extends ApiResponse {
  keys?: string[];
}
