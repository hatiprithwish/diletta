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
