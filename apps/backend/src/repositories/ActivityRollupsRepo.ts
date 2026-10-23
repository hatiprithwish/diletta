import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import ActivityRollupsDAL from "@/data-access-layer/ActivityRollupsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ActivityRollupsProvider from "@/providers/activityRollups";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Activity rollups (M4-2). A (company, day) is rebuilt as a whole in one withTenant: lock the day, read the
// source groups (conversations, feedback, change_request events, model_calls), delete the day's rows and insert the
// fresh ones; any failure rolls the day back to its previous rows. So a rebuild is safe to repeat for any company and
// day, and leaves no metric behind that the sources no longer hold. The hourly run (ActivityRollupsCron) rebuilds
// today and yesterday (UTC) for every company that isn't churned, listing them in withPlatform (a sweep across
// companies, pattern rule 3.15); an operator rebuilds any range by hand (ActivityRollupsRoutes).
export default class ActivityRollupsRepo {
  private db: NodePgDatabase;
  private dal: ActivityRollupsDAL;
  private companiesDal: CompaniesDAL;
  private conversationsDal: ConversationsDAL;
  private feedbackDal: FeedbackDAL;
  private activityLogDal: ActivityLogDAL;
  private modelCallsDal: ModelCallsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ActivityRollupsDAL();
    this.companiesDal = new CompaniesDAL();
    this.conversationsDal = new ConversationsDAL();
    this.feedbackDal = new FeedbackDAL();
    this.activityLogDal = new ActivityLogDAL();
    this.modelCallsDal = new ModelCallsDAL();
  }

  async rebuildDay(params: {
    companyId: string;
    day: Schemas.ActivityRollupDay;
  }): Promise<Schemas.RebuildActivityRollupDayResponse> {
    const { companyId, day } = params;
    const window = { companyId, ...Schemas.activityRollupDayRange(day) };

    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.RebuildActivityRollupDayResponse> => {
        const locked = await this.dal.lockActivityRollupDay(tx, { companyId, day });
        if (!locked.isSuccess) throw new TenantRollbackError(locked.message);

        const conversations = await this.conversationsDal.getConversationRollupGroups(tx, window);
        if (!conversations.isSuccess) throw new TenantRollbackError(conversations.message);
        const feedback = await this.feedbackDal.getFeedbackRollupGroups(tx, window);
        if (!feedback.isSuccess) throw new TenantRollbackError(feedback.message);
        const changeRequests = await this.activityLogDal.getChangeRequestRollupGroups(tx, window);
        if (!changeRequests.isSuccess) throw new TenantRollbackError(changeRequests.message);
        const modelCalls = await this.modelCallsDal.getModelCallRollupGroups(tx, window);
        if (!modelCalls.isSuccess) throw new TenantRollbackError(modelCalls.message);

        const values = ActivityRollupsProvider.buildValues({
          conversations: conversations.groups ?? [],
          feedback: feedback.groups ?? [],
          changeRequests: changeRequests.groups ?? [],
          modelCalls: modelCalls.groups ?? [],
        });

        const deleted = await this.dal.deleteActivityRollupDay(tx, { companyId, day });
        if (!deleted.isSuccess) throw new TenantRollbackError(deleted.message);
        const created = await this.dal.createActivityRollups(tx, { companyId, day, values });
        if (!created.isSuccess) throw new TenantRollbackError(created.message);

        return {
          isSuccess: true,
          message: "Activity rollup day rebuilt",
          rowCount: created.rowCount ?? 0,
        };
      },
    );
  }

  // DEV_NOTE: Operator rebuild: each day in its own transaction, oldest first; a failed day is reported and the rest
  // still run. The range is checked by ZRebuildActivityRollupsApiRequest.
  async rebuildDays(
    params: Schemas.RebuildActivityRollupsApiRequest & { companyId: string },
  ): Promise<Schemas.RebuildActivityRollupsApiResponse> {
    const rebuiltDays: Schemas.ActivityRollupDay[] = [];
    const failedDays: Schemas.ActivityRollupDay[] = [];

    for (const day of Schemas.activityRollupDays(params.fromDay, params.toDay)) {
      const rebuilt = await this.rebuildDay({ companyId: params.companyId, day });
      if (rebuilt.isSuccess) {
        rebuiltDays.push(day);
      } else {
        failedDays.push(day);
      }
    }

    return {
      isSuccess: failedDays.length === 0,
      message: failedDays.length === 0 ? "Activity rollups rebuilt" : "Some days failed to rebuild",
      rebuiltDays,
      failedDays,
    };
  }

  // DEV_NOTE: The hourly run: yesterday and today (UTC) for every Active or Paused company (a paused company keeps
  // its dashboard). Yesterday is rebuilt too, so what lands after midnight for it (a Pending cost backfilled, a late
  // change request event) still reaches its row. One company's failure is logged and the sweep goes on.
  async rebuildRecent(
    params: { now?: number } = {},
  ): Promise<Schemas.RebuildRecentActivityRollupsResponse> {
    const now = params.now ?? Date.now();
    const days = Schemas.activityRollupDays(
      Schemas.activityRollupDayKey(now - 24 * 60 * 60 * 1000),
      Schemas.activityRollupDayKey(now),
    );

    const listed = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyIdsByStatus(tx, {
        statuses: [Schemas.CompanyStatusIntEnum.Active, Schemas.CompanyStatusIntEnum.Paused],
      });
    });
    const companyIds = "companyIds" in listed ? (listed.companyIds ?? []) : [];
    if (!listed.isSuccess) {
      return { isSuccess: false, message: listed.message, rebuiltCount: 0, failedCount: 0 };
    }

    let rebuiltCount = 0;
    let failedCount = 0;
    for (const companyId of companyIds) {
      for (const day of days) {
        const rebuilt = await this.rebuildDay({ companyId, day });
        if (rebuilt.isSuccess) {
          rebuiltCount += 1;
          continue;
        }
        failedCount += 1;
        AppLogger.error({
          category: Schemas.LogCategory.Rollup,
          action: Schemas.LogAction.RebuildActivityRollupDay,
          message: rebuilt.message ?? "Activity rollup day failed to rebuild",
          metadata: { companyId, day },
        });
      }
    }

    return {
      isSuccess: failedCount === 0,
      message: failedCount === 0 ? "Activity rollups rebuilt" : "Some activity rollups failed",
      rebuiltCount,
      failedCount,
    };
  }
}
