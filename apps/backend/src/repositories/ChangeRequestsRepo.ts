import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — change requests as the dashboard reads them. M4-4: one change's detail (the Conversations
// page's Open change); M4-5 adds the list, the timeline from activity_log and resolve. Never reads or returns a change's
// values (encrypted_changes): the action engine (ActionEngineRepo) is the only reader of those.
export default class ChangeRequestsRepo {
  private db: NodePgDatabase;
  private dal: ChangeRequestsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChangeRequestsDAL();
  }

  // DEV_NOTE: Status Enum Pattern — status int + label; errorCode + the words for it. A purged conversation's title
  // stays out.
  private toDetail(row: Schemas.DashboardChangeRequestRow): Schemas.ChangeRequestDetail {
    return {
      publicId: row.publicId,
      summary: row.summary,
      changeCount: row.changeCount,
      changeRequestStatus: row.status,
      changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[row.status],
      ...Schemas.changeRequestErrorOf(row.errorCode),
      toolName: row.toolName,
      toolVersion: row.toolVersion,
      wasEdited: row.wasEdited,
      undoUntil: row.undoUntil?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      conversation: {
        publicId: row.conversationPublicId,
        title: row.conversationContentPurgedAt === null ? row.conversationTitle : null,
        chatbotName: row.chatbotName,
        userName: row.userName,
      },
    };
  }

  async getChangeRequest(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetChangeRequestApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { changeRequest, ...rest } = await this.dal.getDashboardChangeRequest(tx, params);
      return { ...rest, changeRequest: changeRequest ? this.toDetail(changeRequest) : undefined };
    });
  }
}
