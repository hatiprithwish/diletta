import type {
  ActivityLogActorTypeIntEnum,
  ActivityLogActorTypeLabelEnum,
} from "../activityLog/ActivityLogCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

// DEV_NOTE: One audit row as the Security page shows it: who (the admin's name; null for an operator, whose name a
// company never reads, or an admin since removed), the action in words, what it was on, and when. No internal id: the
// log is read by page and never addressed one row at a time.
export interface AuditLogEntry {
  actorType: ActivityLogActorTypeIntEnum;
  actorTypeLabel: ActivityLogActorTypeLabelEnum;
  actorName: string | null;
  action: string;
  on: string | null;
  createdAt: string;
}

export interface GetAuditLogApiResponse extends ApiResponse {
  auditLog?: AuditLogEntry[];
}

export interface ExportAuditLogApiResponse extends ApiResponse {
  auditLog?: AuditLogEntry[];
  isTruncated?: boolean;
}

export type GetAuditLogCountApiResponse = TotalRecordsResponse;
