export enum QualityIssueSourceIntEnum {
  User = 1,
  Admin = 2,
  System = 3,
}

export enum QualityIssueSourceLabelEnum {
  User = "User",
  Admin = "Admin",
  System = "System",
}

export const QUALITY_ISSUE_SOURCE_LABEL_MAP: Record<
  QualityIssueSourceIntEnum,
  QualityIssueSourceLabelEnum
> = {
  [QualityIssueSourceIntEnum.User]: QualityIssueSourceLabelEnum.User,
  [QualityIssueSourceIntEnum.Admin]: QualityIssueSourceLabelEnum.Admin,
  [QualityIssueSourceIntEnum.System]: QualityIssueSourceLabelEnum.System,
};

export enum QualityIssueStatusIntEnum {
  Open = 1,
  Dismissed = 2,
  Converted = 3,
  Fixed = 4,
}

export enum QualityIssueStatusLabelEnum {
  Open = "Open",
  Dismissed = "Dismissed",
  Converted = "Converted",
  Fixed = "Fixed",
}

export const QUALITY_ISSUE_STATUS_LABEL_MAP: Record<
  QualityIssueStatusIntEnum,
  QualityIssueStatusLabelEnum
> = {
  [QualityIssueStatusIntEnum.Open]: QualityIssueStatusLabelEnum.Open,
  [QualityIssueStatusIntEnum.Dismissed]: QualityIssueStatusLabelEnum.Dismissed,
  [QualityIssueStatusIntEnum.Converted]: QualityIssueStatusLabelEnum.Converted,
  [QualityIssueStatusIntEnum.Fixed]: QualityIssueStatusLabelEnum.Fixed,
};

export enum QualityIssueTypeIntEnum {
  KnowledgeGap = 1,
  MissingTool = 2,
  ToolBug = 3,
  ModelError = 4,
  Injection = 5,
}

export enum QualityIssueTypeLabelEnum {
  KnowledgeGap = "Knowledge gap",
  MissingTool = "Missing tool",
  ToolBug = "Tool bug",
  ModelError = "Model error",
  Injection = "Injection",
}

export const QUALITY_ISSUE_TYPE_LABEL_MAP: Record<
  QualityIssueTypeIntEnum,
  QualityIssueTypeLabelEnum
> = {
  [QualityIssueTypeIntEnum.KnowledgeGap]: QualityIssueTypeLabelEnum.KnowledgeGap,
  [QualityIssueTypeIntEnum.MissingTool]: QualityIssueTypeLabelEnum.MissingTool,
  [QualityIssueTypeIntEnum.ToolBug]: QualityIssueTypeLabelEnum.ToolBug,
  [QualityIssueTypeIntEnum.ModelError]: QualityIssueTypeLabelEnum.ModelError,
  [QualityIssueTypeIntEnum.Injection]: QualityIssueTypeLabelEnum.Injection,
};
