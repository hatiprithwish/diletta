import { z } from "zod";
import {
  ZEvalCaseMessages,
  ZEvalCaseReadback,
  ZEvalCaseRubric,
} from "../evalCases/EvalCasesCommon";
import { EvalRunFailureIntEnum, EvalRunTriggerIntEnum } from "../evalRuns/EvalRunsCommon";
import { ZEvalGraderOutputV1 } from "../evalResults/EvalResultsCommon";
import {
  EVAL_HARNESS_VERSION_MAX_CHARS,
  EVAL_RESULT_MAX_LATENCY_MS,
  EVAL_RUN_MAX_K,
} from "./EvalHarnessCommon";

// DEV_NOTE: Bodies the harness sends to /eval/* (M5-2). Every id is a public id; the company and the staging
// connection come from the eval JWT, never from a body. Exported to evals/schemas/eval-api.schema.json.

// DEV_NOTE: Starts a run of one config on the token's staging connection, named by exactly one of chatbotConfigId (that
// config) or chatbotId (the chatbot's published config when the run starts, else NoPublishedConfig: the nightly suite,
// M5-5, follows what is live without a config id in its settings). trigger Gate (M5-4): the config must be Testing (an
// admin sent it), else NotTesting, and is named by chatbotConfigId only; its finish moves the config to Ready or back to
// Draft. Manual and Nightly run a config of any status and never move it.
export const ZCreateEvalRunApiRequest = z
  .object({
    chatbotConfigId: z.string().min(1).max(64).optional(),
    chatbotId: z.string().min(1).max(64).optional(),
    k: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    harnessVersion: z.string().trim().min(1).max(EVAL_HARNESS_VERSION_MAX_CHARS),
    trigger: z.enum(EvalRunTriggerIntEnum),
  })
  .refine((body) => (body.chatbotConfigId === undefined) !== (body.chatbotId === undefined), {
    message: "Name either a config or a chatbot",
  })
  .refine((body) => body.trigger !== EvalRunTriggerIntEnum.Gate || body.chatbotId === undefined, {
    message: "A gate run names its config",
    path: ["chatbotId"],
  })
  .meta({ id: "CreateEvalRunApiRequest" });
export type CreateEvalRunApiRequest = z.infer<typeof ZCreateEvalRunApiRequest>;

// DEV_NOTE: One attempt of one case: a new conversation (pinned to the run's config) that holds the case's messages,
// the {case.tag} already filled by the harness, and answers the last one in one turn. attempt is 1..k, once: a repeat
// of (run, case, attempt) is Duplicate before anything runs, so the harness never retries it.
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

// DEV_NOTE: The pinned judge on one attempt (M5-3): the attempt's conversation (one of the run's) and the case's rubric,
// {case.tag} filled as in the attempt's messages. The backend reads the transcript itself, never from the harness.
export const ZEvalJudgeApiRequest = z
  .object({
    conversationId: z.string().min(1).max(64),
    rubric: ZEvalCaseRubric,
  })
  .meta({ id: "EvalJudgeApiRequest" });
export type EvalJudgeApiRequest = z.infer<typeof ZEvalJudgeApiRequest>;

// DEV_NOTE: One graded attempt. An attempt whose grading stopped (graderOutput.error) never passes.
export const ZRecordEvalResultApiRequest = z
  .object({
    caseId: z.string().min(1).max(64),
    attempt: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    hasPassed: z.boolean(),
    graderOutput: ZEvalGraderOutputV1,
    latencyMs: z.number().int().min(0).max(EVAL_RESULT_MAX_LATENCY_MS).nullable(),
  })
  .refine((body) => !body.hasPassed || body.graderOutput.error === null, {
    message: "An attempt whose grading stopped can't pass",
    path: ["hasPassed"],
  })
  .meta({ id: "RecordEvalResultApiRequest" });
export type RecordEvalResultApiRequest = z.infer<typeof ZRecordEvalResultApiRequest>;

// DEV_NOTE: Ends the run. isComplete true = every case of the run ran its k attempts and the staging data was reset
// (Done; refused while an attempt or the reset is missing); false = the harness stopped early (Failed). failure (M5-3)
// = why it stopped, shown on the Tests page in place of "Didn't finish"; only with isComplete false.
export const ZFinishEvalRunApiRequest = z
  .object({
    isComplete: z.boolean(),
    // DEV_NOTE: Named, so the generated Python enum is EvalRunFailure and the refusal's stays Failure
    failure: z.enum(EvalRunFailureIntEnum).meta({ id: "EvalRunFailure" }).nullable().optional(),
  })
  .refine((body) => !body.isComplete || body.failure === null || body.failure === undefined, {
    message: "A complete run has no failure",
    path: ["failure"],
  })
  .meta({ id: "FinishEvalRunApiRequest" });
export type FinishEvalRunApiRequest = z.infer<typeof ZFinishEvalRunApiRequest>;

export const ZEvalRunParam = z.object({ runId: z.string().min(1).max(64) });
