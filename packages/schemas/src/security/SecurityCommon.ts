import { z } from "zod";
import { QualityIssueStatusIntEnum } from "../qualityIssues/QualityIssuesCommon";

// DEV_NOTE: The Security page (M4-9): identity and origins, encryption keys, retention, prompt-injection events and the
// audit log, all for the signed-in admin's company.

// DEV_NOTE: How long chat content is kept after a conversation's last message (companies.content_retention_days). NULL
// = the platform default. The admin picks one of these; the purge that applies it is M6-1.
export const CONTENT_RETENTION_DAYS_OPTIONS = [7, 30, 90, 180, 365] as const;
export const DEFAULT_CONTENT_RETENTION_DAYS = 30;

export const ZContentRetentionDays = z
  .number()
  .int()
  .refine((value) => (CONTENT_RETENTION_DAYS_OPTIONS as readonly number[]).includes(value), {
    message: `Must be one of ${CONTENT_RETENTION_DAYS_OPTIONS.join(", ")} days`,
  });

// DEV_NOTE: The days in force: the company's choice, else the default
export const effectiveContentRetentionDays = (contentRetentionDays: number | null): number =>
  contentRetentionDays ?? DEFAULT_CONTENT_RETENTION_DAYS;

// DEV_NOTE: AI Gateway keeps full prompts in its logs for this long (architecture: short log retention), shown as copy
export const GATEWAY_LOG_RETENTION_DAYS = 7;

// DEV_NOTE: The widget's allowed origins per connection: at least one (a connection with none serves no widget), at most
// this many
export const ALLOWED_ORIGINS_MAX = 20;

// DEV_NOTE: Why a rotation changed nothing (409): the previous rotation's old key is still waiting for the rotation job
// (M6-3) to re-encrypt its rows and retire it. At most two live keys.
export enum EncryptionKeyRotateFailureEnum {
  RotationInProgress = "RotationInProgress",
}

// DEV_NOTE: A prompt-injection event's "Action taken", from its quality issue's status (until M6-4 detects them, the
// events are the issues an admin typed as Prompt injection)
export const INJECTION_EVENT_ACTION_LABEL_MAP: Record<QualityIssueStatusIntEnum, string> = {
  [QualityIssueStatusIntEnum.Open]: "Waiting for review",
  [QualityIssueStatusIntEnum.Fixed]: "Fixed",
  [QualityIssueStatusIntEnum.Dismissed]: "Dismissed",
  [QualityIssueStatusIntEnum.Converted]: "Turned into a test",
};

export enum InjectionEventSortColumn {
  CreatedAt = "createdAt",
}

export const INJECTION_EVENTS_PAGE_SIZE = 10;
export const AUDIT_LOG_PAGE_SIZE = 20;
