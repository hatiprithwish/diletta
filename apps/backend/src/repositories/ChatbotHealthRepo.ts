import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ActivityRollupsDAL from "@/data-access-layer/ActivityRollupsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ChatbotHealthProvider from "@/providers/chatbotHealth";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Daily production health per chatbot (M5-5), run by the ChatbotHealthCron. It judges yesterday (UTC), whose
// rollups the hourly run has rebuilt since midnight, against the Schemas.CHATBOT_HEALTH_BASELINE_DAYS before it, for
// every chatbot of every Active company with rollups in that span (live traffic only: eval conversations are never in
// them). The companies are listed in withPlatform (a sweep across companies, pattern rule 3.15); each company's rows
// are read in its own withTenant, and each dropped chatbot is written in its own withTenant through
// ChatbotHealthProvider.record (a failure rolls that chatbot back alone). A newly recorded drop also logs an error for
// our team (→ Sentry, M6-6); a rerun on the same day finds the day covered and writes and logs nothing. The events are
// left to the per-minute outbox sweep (a cron has no request to relay them from). One company's failure is logged and
// the sweep goes on; a missed day is judged by nobody (the next run judges its own yesterday), which is safe: the
// issue stays open until an admin closes it.
export default class ChatbotHealthRepo {
  private db: NodePgDatabase;
  private companiesDal: CompaniesDAL;
  private activityRollupsDal: ActivityRollupsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.companiesDal = new CompaniesDAL();
    this.activityRollupsDal = new ActivityRollupsDAL();
  }

  async checkAll(params: { now: number }): Promise<Schemas.CheckChatbotHealthResponse> {
    const day = Schemas.activityRollupAddDays(Schemas.activityRollupDayKey(params.now), -1);

    const listed: Schemas.CompanyIdsDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyIdsByStatus(tx, {
        statuses: [Schemas.CompanyStatusIntEnum.Active],
      });
    });
    if (!listed.isSuccess || !listed.companyIds) {
      const message = listed.message ?? "Companies couldn't be listed";
      AppLogger.error({
        category: Schemas.LogCategory.Health,
        action: Schemas.LogAction.CheckChatbotHealth,
        message,
        metadata: { day },
      });
      return { isSuccess: false, message };
    }

    let checkedCount = 0;
    let dropCount = 0;
    let failedCompanyCount = 0;
    for (const companyId of listed.companyIds) {
      const checked = await this.checkCompany({ companyId, day });
      checkedCount += checked.checkedCount ?? 0;
      dropCount += checked.dropCount ?? 0;
      if (!checked.isSuccess) {
        failedCompanyCount += 1;
        AppLogger.error({
          category: Schemas.LogCategory.Health,
          action: Schemas.LogAction.CheckChatbotHealth,
          message: checked.message ?? "The company's health check failed",
          metadata: { companyId, day },
        });
      }
    }

    return {
      isSuccess: failedCompanyCount === 0,
      message: failedCompanyCount === 0 ? "Chatbot health checked" : "Some health checks failed",
      day,
      checkedCount,
      dropCount,
      failedCompanyCount,
    };
  }

  // DEV_NOTE: One company: its chatbots' yesterday against their baseline, and a write for each that dropped
  async checkCompany(params: {
    companyId: string;
    day: Schemas.ActivityRollupDay;
  }): Promise<Schemas.CheckChatbotHealthResponse> {
    const { companyId, day } = params;
    const fromDay = Schemas.activityRollupAddDays(day, -Schemas.CHATBOT_HEALTH_BASELINE_DAYS);

    const read: Schemas.ChatbotHealthRollupsDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => {
        return await this.activityRollupsDal.getChatbotHealthRollups(tx, {
          companyId,
          fromDay,
          toDay: day,
        });
      },
    );
    if (!read.isSuccess || !read.rows) {
      return { isSuccess: false, message: read.message ?? "Health rollups couldn't be read" };
    }

    const byChatbot = new Map<string, { day: typeof read.rows; baseline: typeof read.rows }>();
    for (const row of read.rows) {
      const entry = byChatbot.get(row.chatbotId) ?? { day: [], baseline: [] };
      (row.day === day ? entry.day : entry.baseline).push(row);
      byChatbot.set(row.chatbotId, entry);
    }

    let dropCount = 0;
    let isEverySaved = true;
    for (const [chatbotId, rows] of byChatbot) {
      const drops = Schemas.evaluateChatbotHealth({
        day: Schemas.chatbotHealthCounts(rows.day),
        baseline: Schemas.chatbotHealthCounts(rows.baseline),
      });
      if (drops.length === 0) continue;
      dropCount += 1;

      const recorded: Schemas.RecordChatbotHealthDropResponse = await withTenant(
        this.db,
        companyId,
        async (tx) => {
          const result = await ChatbotHealthProvider.record(tx, {
            companyId,
            chatbotId,
            day,
            drops,
          });
          if (!result.isSuccess) {
            throw new TenantRollbackError(result.message ?? "Health drop not recorded");
          }
          return result;
        },
      );
      const metadata = { companyId, chatbotId, day, drops };
      if (!recorded.isSuccess) {
        isEverySaved = false;
        AppLogger.error({
          category: Schemas.LogCategory.Health,
          action: Schemas.LogAction.RecordChatbotHealthDrop,
          message: recorded.message ?? "Health drop not recorded",
          metadata,
        });
      } else if (recorded.isOpened || recorded.isAdded) {
        AppLogger.error({
          category: Schemas.LogCategory.Health,
          action: Schemas.LogAction.RecordChatbotHealthDrop,
          message: "A chatbot's production health dropped",
          metadata: { ...metadata, isOpened: recorded.isOpened },
        });
      }
    }

    return {
      isSuccess: isEverySaved,
      message: isEverySaved ? "Company health checked" : "Some health drops weren't recorded",
      day,
      checkedCount: byChatbot.size,
      dropCount,
    };
  }
}
