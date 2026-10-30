import { z } from "zod";

export enum EvalRunTriggerIntEnum {
  Gate = 1,
  Manual = 2,
  Nightly = 3,
}

export enum EvalRunTriggerLabelEnum {
  Gate = "Gate",
  Manual = "Manual",
  Nightly = "Nightly",
}

export const EVAL_RUN_TRIGGER_LABEL_MAP: Record<EvalRunTriggerIntEnum, EvalRunTriggerLabelEnum> = {
  [EvalRunTriggerIntEnum.Gate]: EvalRunTriggerLabelEnum.Gate,
  [EvalRunTriggerIntEnum.Manual]: EvalRunTriggerLabelEnum.Manual,
  [EvalRunTriggerIntEnum.Nightly]: EvalRunTriggerLabelEnum.Nightly,
};

export enum EvalRunStatusIntEnum {
  Queued = 1,
  Running = 2,
  Done = 3,
  Failed = 4,
}

export enum EvalRunStatusLabelEnum {
  Queued = "Queued",
  Running = "Running",
  Done = "Done",
  Failed = "Failed",
}

export const EVAL_RUN_STATUS_LABEL_MAP: Record<EvalRunStatusIntEnum, EvalRunStatusLabelEnum> = {
  [EvalRunStatusIntEnum.Queued]: EvalRunStatusLabelEnum.Queued,
  [EvalRunStatusIntEnum.Running]: EvalRunStatusLabelEnum.Running,
  [EvalRunStatusIntEnum.Done]: EvalRunStatusLabelEnum.Done,
  [EvalRunStatusIntEnum.Failed]: EvalRunStatusLabelEnum.Failed,
};

// Whole Eval Run Body — DB shape
// DEV_NOTE: id, companyId and chatbotConfigId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client.
// Written by the eval harness (M5-2); the Tests page (M4-8) only reads runs. costUsd is an exact decimal string.
// caseCount, passAllKCount and hasPassed stay null until the run is Done. companyConnectionId and evalCaseIds are internal
// too: the staging connection and the cases the harness started the run with (null only on a run that never started).
export const ZEvalRun = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotConfigId: z.string(),
  companyConnectionId: z.string().nullable(),
  evalCaseIds: z.array(z.string()).nullable(),
  // DEV_NOTE: When the harness's reset (the connection's reset_op, or none to send) went through; Done needs it
  resetAt: z.date().nullable(),
  trigger: z.enum(EvalRunTriggerIntEnum),
  harnessVersion: z.string(),
  k: z.number().int(),
  status: z.enum(EvalRunStatusIntEnum),
  caseCount: z.number().int().nullable(),
  passAllKCount: z.number().int().nullable(),
  hasPassed: z.boolean().nullable(),
  costUsd: z.string(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EvalRun = z.infer<typeof ZEvalRun>;

export enum EvalRunSortColumn {
  CreatedAt = "createdAt",
}

export const ZEvalRunSortColumn = z.enum(EvalRunSortColumn);

// DEV_NOTE: A run's cases: Result puts the failed ones first (then safety cases, then by name); Name is alphabetical
export enum EvalRunCaseSortColumn {
  Result = "result",
  Name = "name",
}

export const ZEvalRunCaseSortColumn = z.enum(EvalRunCaseSortColumn);

// DEV_NOTE: The Tests page's rows per page: runs, a run's cases, and cases (the API's own default page size is smaller)
export const EVAL_RUNS_PAGE_SIZE = 25;
export const EVAL_RUN_CASES_PAGE_SIZE = 25;

// DEV_NOTE: How a case did in a run (pass^k): true once every one of the run's k attempts passed; false as soon as an
// attempt failed, or when the run ended (Done or Failed) without k passing attempts; null while the run is still going
// (Queued or Running) and nothing has failed yet, so a case being graded never reads as failed.
export function evalCaseRunResult(params: {
  passedAttemptCount: number;
  attemptCount: number;
  k: number;
  runStatus: EvalRunStatusIntEnum;
}): boolean | null {
  if (params.k > 0 && params.passedAttemptCount >= params.k) return true;
  if (params.attemptCount > params.passedAttemptCount) return false;
  return isEvalRunUnderway(params.runStatus) ? null : false;
}

// DEV_NOTE: A run still writing results
export function isEvalRunUnderway(status: EvalRunStatusIntEnum): boolean {
  return status === EvalRunStatusIntEnum.Queued || status === EvalRunStatusIntEnum.Running;
}
