import type { ActivityLog } from "../activityLog/ActivityLogCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: An audit row as read (raw: actor type int, untyped detail) with the admin's name joined (null for an
// operator or a removed admin). Internal ids stay server-side.
export type AuditLogRow = Pick<
  ActivityLog,
  "actorType" | "entityType" | "entityAction" | "entityVersion" | "detail" | "createdAt"
> & {
  actorName: string | null;
};

export interface AuditLogDALResponse extends ApiResponse {
  auditLog?: AuditLogRow[];
}

// DEV_NOTE: The record an audit write returns: its outbox row, relayed after the commit
export interface RecordAuditEventResponse extends ApiResponse {
  outboxId?: string;
}
