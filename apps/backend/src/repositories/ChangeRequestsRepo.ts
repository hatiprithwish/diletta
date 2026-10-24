import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ChatbotUsersDAL from "@/data-access-layer/ChatbotUsersDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ChangeRequestTimelineProvider from "@/providers/changeRequestTimeline";
import ChangeRequestsProvider from "@/providers/changeRequests";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

type ResolvedFilter =
  | { isSuccess: true; filter: Schemas.ChangeRequestsFilterDALRequest }
  | { isSuccess: false; message?: string; isNotFound?: boolean };

// DEV_NOTE: What the resolve's transaction committed: the row as it stands after (internal ids, server-side only)
type ResolvedChange = Schemas.ResolveChangeRequestResponse & {
  row?: Schemas.DashboardChangeRequestRow;
};

// DEV_NOTE: Tenant Repo — change requests as the dashboard reads them: the Changes list with its tab counts, the
// Requested by choices, one change's detail with its timeline from activity_log, the sidebar's needs-a-person count (M4-5), and
// Mark resolved, the only write. Never reads or returns a change's values (encrypted_changes): the action engine
// (ActionEngineRepo) is the only reader of those. requesterId (a host user id) and botId (a chatbot public id) are
// resolved in the company (unknown → 404).
export default class ChangeRequestsRepo {
  private db: NodePgDatabase;
  private dal: ChangeRequestsDAL;
  private activityLogDal: ActivityLogDAL;
  private chatbotsDal: ChatbotsDAL;
  private chatbotUsersDal: ChatbotUsersDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChangeRequestsDAL();
    this.activityLogDal = new ActivityLogDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.chatbotUsersDal = new ChatbotUsersDAL();
  }

  // DEV_NOTE: Status Enum Pattern — status int + label; errorCode + the words for it
  private toListItem(row: Schemas.DashboardChangeRequestRow): Schemas.ChangeRequestListItem {
    return {
      publicId: row.publicId,
      summary: row.summary,
      changeCount: row.changeCount,
      changeRequestStatus: row.status,
      changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[row.status],
      ...Schemas.changeRequestErrorOf(row.errorCode),
      toolName: row.toolName,
      toolVersion: row.toolVersion,
      requesterName: row.userName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // DEV_NOTE: A purged conversation's title stays out
  private toDetail(
    row: Schemas.DashboardChangeRequestRow,
    timeline: Schemas.ChangeRequestTimelineEntry[],
  ): Schemas.ChangeRequestDetail {
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
      timeline,
    };
  }

  async getChangeRequests(
    params: Schemas.GetChangeRequestsApiRequest & { companyId: string },
  ): Promise<Schemas.GetChangeRequestsApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetChangeRequestsApiResponse> => {
        const resolved = await this.resolveFilter(tx, params);
        if (!resolved.isSuccess) return resolved;
        const { filter } = resolved;

        const page = await this.dal.getDashboardChangeRequests(tx, {
          ...filter,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.ChangeRequestSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };

        const { tab: _tab, ...countFilter } = filter;
        const counted = await this.dal.getDashboardChangeRequestsCount(tx, countFilter);
        if (!counted.isSuccess || !counted.tabCounts) {
          return { isSuccess: false, message: counted.message };
        }
        const { tabCounts } = counted;

        return {
          isSuccess: true,
          message: "Change requests fetched successfully",
          changeRequests: (page.changeRequests ?? []).map((row) => this.toListItem(row)),
          totalRecords: tabCounts[filter.tab],
          tabCounts,
        };
      },
    );
  }

  // DEV_NOTE: The Requested by choices: the top CHANGE_REQUEST_REQUESTERS_MAX by change count, then the requester the
  // page's URL picked when it isn't among them (so the filter still names them), unless unknown or erased
  async getRequesters(
    params: Schemas.GetChangeRequestRequestersApiRequest & { companyId: string },
  ): Promise<Schemas.GetChangeRequestRequestersApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetChangeRequestRequestersApiResponse> => {
        const top = await this.dal.getChangeRequestRequesters(tx, {
          companyId,
          limit: Schemas.CHANGE_REQUEST_REQUESTERS_MAX,
        });
        if (!top.isSuccess) return { isSuccess: false, message: top.message };
        const requesters = (top.requesters ?? []).map((row) => ({
          hostUserId: row.hostUserId,
          name: row.name,
        }));

        const { requesterId } = params;
        if (requesterId && !requesters.some((row) => row.hostUserId === requesterId)) {
          const picked = await this.chatbotUsersDal.getChatbotUserDetails(tx, {
            companyId,
            hostUserId: requesterId,
          });
          if (!picked.isSuccess && !picked.isNotFound) {
            return { isSuccess: false, message: picked.message };
          }
          if (picked.chatbotUser && picked.chatbotUser.erasedAt === null) {
            requesters.push({ hostUserId: requesterId, name: picked.chatbotUser.displayName });
          }
        }

        return { isSuccess: true, message: "Requesters fetched successfully", requesters };
      },
    );
  }

  // DEV_NOTE: The sidebar's Changes badge: how many of the company's change requests need a person now
  async getNeedsHumanCount(params: {
    companyId: string;
  }): Promise<Schemas.GetChangeRequestsNeedsHumanCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const counted = await this.dal.getChangeRequestsCountByStatus(tx, {
        companyId: params.companyId,
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        chatbotId: null,
      });
      if (!counted.isSuccess) return { isSuccess: false, message: counted.message };
      return {
        isSuccess: true,
        message: "Change requests counted successfully",
        needsHumanCount: counted.totalRecords ?? 0,
      };
    });
  }

  async getChangeRequest(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetChangeRequestApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.dal.getDashboardChangeRequest(tx, params);
      if (!found.isSuccess || !found.changeRequest) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      return await this.withTimeline(tx, params.companyId, found.changeRequest);
    });
  }

  // DEV_NOTE: Mark resolved (M4-5), one withTenant: the change request locked (unknown → 404), only from NeedsHuman
  // (else failure NotNeedsHuman, 409, nothing written), then Resolved with undo_until = now
  // (ChangeRequestsProvider.undoUntil: the next purge empties its values) and its change_request.resolved critical event
  // (actor the admin, under the conversation's root log). The event failing rolls the status back
  // (TenantRollbackError). The answer (the change with its timeline) is read after the commit, on its own: a failed read
  // never undoes a resolve that committed, it answers the change without its timeline (the client refetches it). The
  // route relays outboxId after the commit.
  async resolveChangeRequest(
    params: Schemas.ResolveChangeRequestRequest,
  ): Promise<Schemas.ResolveChangeRequestResponse> {
    const { companyId } = params;
    const resolved = await withTenant(this.db, companyId, async (tx): Promise<ResolvedChange> => {
      const found = await this.dal.getDashboardChangeRequest(tx, {
        companyId,
        publicId: params.publicId,
        isForUpdate: true,
      });
      if (!found.isSuccess || !found.changeRequest) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.NeedsHuman) {
        return {
          isSuccess: false,
          message: "Only a change that needs a person can be resolved",
          failure: Schemas.ChangeRequestResolveFailureEnum.NotNeedsHuman,
        };
      }

      const status = Schemas.ChangeRequestStatusIntEnum.Resolved;
      const updated = await this.dal.updateChangeRequestStatus(tx, {
        companyId,
        id: row.id,
        status,
        fromStatuses: [Schemas.ChangeRequestStatusIntEnum.NeedsHuman],
        undoUntil: ChangeRequestsProvider.undoUntil(status, Date.now()),
      });
      if (!updated.isSuccess || !updated.changeRequest) {
        throw new TenantRollbackError(updated.message ?? "Change request not resolved");
      }

      const action = Schemas.ChangeRequestEntityActionEnum.Resolved;
      const event = await CriticalEventProvider.record(tx, {
        companyId,
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        actorId: params.adminId,
        entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
        entityId: row.id,
        entityAction: action,
        entityVersion: null,
        parentLogId: row.conversationRootLogId,
        rootLogId: row.conversationRootLogId,
        detail: { conversationId: row.conversationId, status, errorCode: row.errorCode },
        eventType: Schemas.changeRequestEventType(action),
        dedupeKey: Schemas.changeRequestEventDedupeKey(action, row.publicId),
      });
      if (!event.isSuccess || !event.outboxId) {
        throw new TenantRollbackError(event.message ?? "Change request event not recorded");
      }

      return {
        isSuccess: true,
        message: "Change request resolved",
        outboxId: event.outboxId,
        row: {
          ...row,
          status: updated.changeRequest.status,
          undoUntil: updated.changeRequest.undoUntil,
          updatedAt: updated.changeRequest.updatedAt,
        },
      };
    });
    if (!resolved.isSuccess || !("row" in resolved) || !resolved.row) {
      const failure = "failure" in resolved ? resolved.failure : undefined;
      if (failure) {
        AppLogger.warn({
          category: Schemas.LogCategory.Repo,
          action: Schemas.LogAction.ResolveChangeRequest,
          message: "Change request not resolved: it doesn't need a person",
          metadata: { companyId, publicId: params.publicId, failure },
        });
      }
      return {
        isSuccess: false,
        message: resolved.message,
        isNotFound: resolved.isNotFound,
        failure,
      };
    }

    const { row, outboxId } = resolved;
    const detail = await this.getChangeRequest({ companyId, publicId: params.publicId });
    if (!detail.isSuccess || !detail.changeRequest) {
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.ResolveChangeRequest,
        message: "Change request resolved, but its timeline didn't load for the answer",
        metadata: { companyId, publicId: params.publicId, reason: detail.message ?? null },
      });
    }
    return {
      isSuccess: true,
      message: "Change request resolved",
      outboxId,
      changeRequest: detail.changeRequest ?? this.toDetail(row, []),
    };
  }

  // DEV_NOTE: The detail with its timeline (ChangeRequestTimelineProvider), read in the caller's transaction
  private async withTimeline(
    tx: Tx,
    companyId: string,
    row: Schemas.DashboardChangeRequestRow,
  ): Promise<Schemas.GetChangeRequestApiResponse> {
    const logs = await this.activityLogDal.getActivityLogTimeline(tx, {
      companyId,
      entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
      entityId: row.id,
      limit: Schemas.CHANGE_REQUEST_TIMELINE_MAX_EVENTS,
    });
    if (!logs.isSuccess) return { isSuccess: false, message: logs.message };
    return {
      isSuccess: true,
      message: "Change request fetched successfully",
      changeRequest: this.toDetail(
        row,
        ChangeRequestTimelineProvider.timeline(logs.activityLogs ?? []),
      ),
    };
  }

  private async resolveFilter(
    tx: Tx,
    params: Schemas.GetChangeRequestsApiRequest & { companyId: string },
  ): Promise<ResolvedFilter> {
    let chatbotId: string | null = null;
    if (params.botId !== undefined) {
      const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
        companyId: params.companyId,
        publicId: params.botId,
      });
      if (!chatbot.isSuccess || !chatbot.chatbot) {
        return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
      }
      chatbotId = chatbot.chatbot.id;
    }

    // DEV_NOTE: One lookup on UNQ_chatbot_users_company_id_host_user_id; an erased user still filters (its changes
    // stay listed)
    let chatbotUserId: string | null = null;
    if (params.requesterId !== undefined) {
      const requester = await this.chatbotUsersDal.getChatbotUserDetails(tx, {
        companyId: params.companyId,
        hostUserId: params.requesterId,
      });
      if (!requester.isSuccess || !requester.chatbotUser) {
        return { isSuccess: false, message: requester.message, isNotFound: requester.isNotFound };
      }
      chatbotUserId = requester.chatbotUser.id;
    }

    return {
      isSuccess: true,
      filter: {
        companyId: params.companyId,
        tab: params.tab ?? Schemas.ChangeRequestListTabEnum.All,
        chatbotUserId,
        chatbotId,
      },
    };
  }
}
