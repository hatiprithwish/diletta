import { z } from "zod";
import { ZEvalCaseMessages, ZEvalCaseReadback } from "../evalCases/EvalCasesCommon";
import { EvalRunTriggerIntEnum } from "../evalRuns/EvalRunsCommon";
import { ZEvalGraderOutputV1 } from "../evalResults/EvalResultsCommon";
import { EVAL_HARNESS_VERSION_MAX_CHARS, EVAL_RUN_MAX_K } from "./EvalHarnessCommon";

// DEV_NOTE: Bodies the harness sends to /eval/* (M5-2). Every id is a public id; the company and the staging
// connection come from the eval JWT, never from a body. Exported to evals/schemas/eval-api.schema.json.

// DEV_NOTE: Starts a run of one config (any status: a Draft is what the gate tests) on the token's staging connection.
// trigger: Manual from the CLI; Gate (M5-4) and Nightly (M5-5) start runs the same way.
export const ZCreateEvalRunApiRequest = z
  .object({
    chatbotConfigId: z.string().min(1).max(64),
    k: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    harnessVersion: z.string().trim().min(1).max(EVAL_HARNESS_VERSION_MAX_CHARS),
    trigger: z.enum(EvalRunTriggerIntEnum),
  })
  .meta({ id: "CreateEvalRunApiRequest" });
export type CreateEvalRunApiRequest = z.infer<typeof ZCreateEvalRunApiRequest>;

// DEV_NOTE: One attempt of one case: a new conversation (pinned to the run's config) that holds the case's messages,
// the {case.tag} already filled by the harness, and answers the last one in one turn. attempt is 1..k.
export const ZRunEvalAttemptApiRequest = z
  .object({
    caseId: z.string().min(1).max(64),
    attempt: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    messages: ZEvalCaseMessages,
  })
  .meta({ id: "RunEvalAttemptApiRequest" });
export type RunEvalAttemptApiRequest = z.infer<typeof ZRunEvalAttemptApiRequest>;

// DEV_NOTE: A readback assert: the change request of the chatbot's call the harness matched to the case's toolCalls
// entry, in that attempt's conversation; expect has the tag filled
export const ZEvalReadbackApiRequest = z
  .object({
    conversationId: z.string().min(1).max(64),
    changeRequestId: z.string().min(1).max(64),
    readback: ZEvalCaseReadback,
  })
  .meta({ id: "EvalReadbackApiRequest" });
export type EvalReadbackApiRequest = z.infer<typeof ZEvalReadbackApiRequest>;

// DEV_NOTE: One graded attempt. An attempt whose grading stopped (graderOutput.error) never passes.
export const ZRecordEvalResultApiRequest = z
  .object({
    caseId: z.string().min(1).max(64),
    attempt: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    hasPassed: z.boolean(),
    graderOutput: ZEvalGraderOutputV1,
    latencyMs: z.number().int().min(0).nullable(),
  })
  .refine((body) => !body.hasPassed || body.graderOutput.error === null, {
    message: "An attempt whose grading stopped can't pass",
    path: ["hasPassed"],
  })
  .meta({ id: "RecordEvalResultApiRequest" });
export type RecordEvalResultApiRequest = z.infer<typeof ZRecordEvalResultApiRequest>;

// DEV_NOTE: Ends the run. isComplete true = every case ran its k attempts (Done; refused while one is missing);
// false = the harness stopped early (Failed: the page says "Didn't finish").
export const ZFinishEvalRunApiRequest = z
  .object({
    isComplete: z.boolean(),
  })
  .meta({ id: "FinishEvalRunApiRequest" });
export type FinishEvalRunApiRequest = z.infer<typeof ZFinishEvalRunApiRequest>;

export const ZEvalRunParam = z.object({ runId: z.string().min(1).max(64) });
