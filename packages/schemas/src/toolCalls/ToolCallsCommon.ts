export enum ToolCallStatusIntEnum {
  Ok = 1,
  Error = 2,
  Blocked = 3,
}

export enum ToolCallStatusLabelEnum {
  Ok = "OK",
  Error = "Error",
  Blocked = "Blocked",
}

export const TOOL_CALL_STATUS_LABEL_MAP: Record<ToolCallStatusIntEnum, ToolCallStatusLabelEnum> = {
  [ToolCallStatusIntEnum.Ok]: ToolCallStatusLabelEnum.Ok,
  [ToolCallStatusIntEnum.Error]: ToolCallStatusLabelEnum.Error,
  [ToolCallStatusIntEnum.Blocked]: ToolCallStatusLabelEnum.Blocked,
};
