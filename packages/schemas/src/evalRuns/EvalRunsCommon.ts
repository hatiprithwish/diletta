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
// caseCount, passAllKCount and hasPassed stay null until the run is Done.
export const ZEvalRun = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotConfigId: z.string(),
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

// DEV_NOTE: A case passes a run when every one of its k attempts passed (pass^k)
export function hasEvalCasePassed(passedAttemptCount: number, k: number): boolean {
  return k > 0 && passedAttemptCount >= k;
}
