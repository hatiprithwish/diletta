import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import AuditLogProvider from "@/providers/auditLog";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — the Security page's audit log (M4-9): the company's activity_log rows written by an admin or
// an operator (AuditEventProvider, and the admin events other pages record), one withTenant per call, read-only. Rows
// go out in words (AuditLogProvider): who, the action, what it was on, when; never an internal id or the row's detail.
export default class AuditLogRepo {
  private db: NodePgDatabase;
  private dal: ActivityLogDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ActivityLogDAL();
  }

  async getAuditLog(
    params: Schemas.GetAuditLogApiRequest & { companyId: string },
  ): Promise<Schemas.GetAuditLogApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetAuditLogApiResponse> => {
        const { auditLog, ...rest } = await this.dal.getAuditLog(tx, {
          companyId: params.companyId,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.AuditLogSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        return { ...rest, auditLog: auditLog?.map((row) => AuditLogProvider.toEntry(row)) };
      },
    );
  }

  async getAuditLogCount(params: {
    companyId: string;
  }): Promise<Schemas.GetAuditLogCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.getAuditLogCount(tx, params);
    });
  }

  // DEV_NOTE: Newest first, at most AUDIT_LOG_EXPORT_MAX_ROWS rows: one more is read to tell whether there were more
  // (isTruncated). The client turns it into a file.
  async exportAuditLog(params: { companyId: string }): Promise<Schemas.ExportAuditLogApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.ExportAuditLogApiResponse> => {
        const rows = await this.dal.getAuditLog(tx, {
          companyId: params.companyId,
          pageNo: 1,
          pageSize: Schemas.AUDIT_LOG_EXPORT_MAX_ROWS + 1,
          sortColumn: Schemas.AuditLogSortColumn.CreatedAt,
          sortDirection: Schemas.SortDirection.Desc,
        });
        if (!rows.isSuccess) return { isSuccess: false, message: rows.message };
        const auditLog = rows.auditLog ?? [];

        return {
          isSuccess: true,
          message: "Audit log exported successfully",
          auditLog: auditLog
            .slice(0, Schemas.AUDIT_LOG_EXPORT_MAX_ROWS)
            .map((row) => AuditLogProvider.toEntry(row)),
          isTruncated: auditLog.length > Schemas.AUDIT_LOG_EXPORT_MAX_ROWS,
        };
      },
    );
  }
}
