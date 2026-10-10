import { z } from "zod";

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

// Whole Quality Issue Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, conversationId, changeRequestId, feedbackId, evalCaseId, createdBy and updatedBy are
// internal bigint ids — used by DAL/Repo only, NEVER sent to a client. CHECKs tie feedbackId to source = User,
// createdBy to source = Admin and evalCaseId to status = Converted.
export const ZQualityIssue = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  conversationId: z.string(),
  changeRequestId: z.string().nullable(),
  feedbackId: z.string().nullable(),
  source: z.enum(QualityIssueSourceIntEnum),
  status: z.enum(QualityIssueStatusIntEnum),
  issueType: z.enum(QualityIssueTypeIntEnum).nullable(),
  note: z.string().nullable(),
  evalCaseId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type QualityIssue = z.infer<typeof ZQualityIssue>;
