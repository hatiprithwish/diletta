export enum ToolDefinitionRiskIntEnum {
  Read = 1,
  Write = 2,
  Destructive = 3,
}

export enum ToolDefinitionRiskLabelEnum {
  Read = "Read",
  Write = "Write",
  Destructive = "Destructive",
}

export const TOOL_DEFINITION_RISK_LABEL_MAP: Record<
  ToolDefinitionRiskIntEnum,
  ToolDefinitionRiskLabelEnum
> = {
  [ToolDefinitionRiskIntEnum.Read]: ToolDefinitionRiskLabelEnum.Read,
  [ToolDefinitionRiskIntEnum.Write]: ToolDefinitionRiskLabelEnum.Write,
  [ToolDefinitionRiskIntEnum.Destructive]: ToolDefinitionRiskLabelEnum.Destructive,
};

export enum ToolDefinitionIdempotencyModeIntEnum {
  Native = 1,
  Emulated = 2,
  None = 3,
}

export enum ToolDefinitionIdempotencyModeLabelEnum {
  Native = "Native",
  Emulated = "Emulated",
  None = "None",
}

export const TOOL_DEFINITION_IDEMPOTENCY_MODE_LABEL_MAP: Record<
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionIdempotencyModeLabelEnum
> = {
  [ToolDefinitionIdempotencyModeIntEnum.Native]: ToolDefinitionIdempotencyModeLabelEnum.Native,
  [ToolDefinitionIdempotencyModeIntEnum.Emulated]: ToolDefinitionIdempotencyModeLabelEnum.Emulated,
  [ToolDefinitionIdempotencyModeIntEnum.None]: ToolDefinitionIdempotencyModeLabelEnum.None,
};

export enum ToolDefinitionApprovalIntEnum {
  Always = 1,
  Policy = 2,
  Never = 3,
}

export enum ToolDefinitionApprovalLabelEnum {
  Always = "Always",
  Policy = "Policy",
  Never = "Never",
}

export const TOOL_DEFINITION_APPROVAL_LABEL_MAP: Record<
  ToolDefinitionApprovalIntEnum,
  ToolDefinitionApprovalLabelEnum
> = {
  [ToolDefinitionApprovalIntEnum.Always]: ToolDefinitionApprovalLabelEnum.Always,
  [ToolDefinitionApprovalIntEnum.Policy]: ToolDefinitionApprovalLabelEnum.Policy,
  [ToolDefinitionApprovalIntEnum.Never]: ToolDefinitionApprovalLabelEnum.Never,
};

export enum ToolDefinitionSourceIntEnum {
  OpenApi = 1,
  Manual = 2,
}

export enum ToolDefinitionSourceLabelEnum {
  OpenApi = "OpenAPI",
  Manual = "Manual",
}

export const TOOL_DEFINITION_SOURCE_LABEL_MAP: Record<
  ToolDefinitionSourceIntEnum,
  ToolDefinitionSourceLabelEnum
> = {
  [ToolDefinitionSourceIntEnum.OpenApi]: ToolDefinitionSourceLabelEnum.OpenApi,
  [ToolDefinitionSourceIntEnum.Manual]: ToolDefinitionSourceLabelEnum.Manual,
};

export enum ToolDefinitionStatusIntEnum {
  Draft = 1,
  Active = 2,
  Disabled = 3,
}

export enum ToolDefinitionStatusLabelEnum {
  Draft = "Draft",
  Active = "Active",
  Disabled = "Disabled",
}

export const TOOL_DEFINITION_STATUS_LABEL_MAP: Record<
  ToolDefinitionStatusIntEnum,
  ToolDefinitionStatusLabelEnum
> = {
  [ToolDefinitionStatusIntEnum.Draft]: ToolDefinitionStatusLabelEnum.Draft,
  [ToolDefinitionStatusIntEnum.Active]: ToolDefinitionStatusLabelEnum.Active,
  [ToolDefinitionStatusIntEnum.Disabled]: ToolDefinitionStatusLabelEnum.Disabled,
};
