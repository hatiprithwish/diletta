import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ActivityRollupsDAL from "@/data-access-layer/ActivityRollupsDAL";
import AdminsDAL from "@/data-access-layer/AdminsDAL";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import RoiAssumptionsDAL from "@/data-access-layer/RoiAssumptionsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import InsightsProvider from "@/providers/insights";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

type ResolvedChatbot =
  | { isSuccess: true; chatbot: Schemas.Chatbot | null }
  | { isSuccess: false; message?: string; isNotFound?: boolean };

// DEV_NOTE: Tenant Repo — the Insights pages (M4-3): Overview, Usage, Impact. One read-only withTenant per page.
// Numbers come from activity_rollups (rebuilt hourly, M4-2), read for one owner: the botId's chatbot, else the
// company-wide rows; the math is pure in InsightsProvider. botId is a chatbot public id, resolved in the company
// (unknown → 404). The current state (needs attention, live config) is read from its own tables. Overview's spend card
// is the company's billing month against the company's budget, so it reads the company-wide rows whatever the botId.
export default class InsightsRepo {
  private db: NodePgDatabase;
  private rollupsDal: ActivityRollupsDAL;
  private chatbotsDal: ChatbotsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private adminsDal: AdminsDAL;
  private companiesDal: CompaniesDAL;
  private changeRequestsDal: ChangeRequestsDAL;
  private qualityIssuesDal: QualityIssuesDAL;
  private knowledgeSourcesDal: KnowledgeSourcesDAL;
  private toolDefinitionsDal: ToolDefinitionsDAL;
  private roiAssumptionsDal: RoiAssumptionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.rollupsDal = new ActivityRollupsDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.adminsDal = new AdminsDAL();
    this.companiesDal = new CompaniesDAL();
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
    this.knowledgeSourcesDal = new KnowledgeSourcesDAL();
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
    this.roiAssumptionsDal = new RoiAssumptionsDAL();
  }

  async getOverview(
    params: Schemas.GetInsightsApiRequest & { companyId: string; now?: number },
  ): Promise<Schemas.GetInsightsOverviewApiResponse> {
    const { companyId } = params;
    const now = params.now ?? Date.now();
    const periods = Schemas.insightsRangePeriods(
      params.range ?? Schemas.DEFAULT_INSIGHTS_RANGE,
      now,
    );
    const month = Schemas.insightsBillingMonth(now);

    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetInsightsOverviewApiResponse> => {
        const bot = await this.resolveChatbot(tx, companyId, params.botId);
        if (!bot.isSuccess) return bot;
        const chatbotId = bot.chatbot?.id ?? null;

        // DEV_NOTE: The company-wide rows hold the billing month too, so one read covers both unless a bot is asked
        // for: the budget is the company's, so its spend card always reads the company-wide month.
        const fromDay =
          chatbotId === null && month.fromDay < periods.previous.fromDay
            ? month.fromDay
            : periods.previous.fromDay;
        const rollups = await this.rollupsDal.getActivityRollups(tx, {
          companyId,
          chatbotId,
          fromDay,
          toDay: periods.current.toDay,
        });
        if (!rollups.isSuccess) return { isSuccess: false, message: rollups.message };
        const index = InsightsProvider.indexReadings(rollups.readings ?? []);
        let monthIndex = index;
        if (chatbotId !== null) {
          const monthRollups = await this.rollupsDal.getActivityRollups(tx, {
            companyId,
            chatbotId: null,
            fromDay: month.fromDay,
            toDay: month.toDay,
          });
          if (!monthRollups.isSuccess) return { isSuccess: false, message: monthRollups.message };
          monthIndex = InsightsProvider.indexReadings(monthRollups.readings ?? []);
        }

        const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message };
        }

        const needsHuman = await this.changeRequestsDal.getChangeRequestsCountByStatus(tx, {
          companyId,
          status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
          chatbotId,
        });
        if (!needsHuman.isSuccess) return { isSuccess: false, message: needsHuman.message };
        const issues = await this.qualityIssuesDal.getOpenQualityIssueCounts(tx, {
          companyId,
          chatbotId,
        });
        if (!issues.isSuccess) return { isSuccess: false, message: issues.message };
        const sources = await this.knowledgeSourcesDal.getFailedKnowledgeSourcesSummary(tx, {
          companyId,
        });
        if (!sources.isSuccess) return { isSuccess: false, message: sources.message };

        const liveConfig = await this.getLiveConfig(tx, companyId, bot.chatbot);
        if (!liveConfig.isSuccess) return { isSuccess: false, message: liveConfig.message };

        return {
          isSuccess: true,
          message: "Overview fetched successfully",
          overview: InsightsProvider.buildOverview({
            periods,
            index,
            monthIndex,
            month,
            budgetUsd: company.company.spendingBudget ?? Schemas.DEFAULT_SPENDING_BUDGET_USD,
            attention: {
              needsHumanCount: needsHuman.totalRecords ?? 0,
              openIssueCount: issues.totalCount ?? 0,
              openUserIssueCount: issues.userCount ?? 0,
              failedSourceCount: sources.failedCount ?? 0,
              lastSourceFailedAt: sources.lastFailedAt?.toISOString() ?? null,
            },
            liveConfig: liveConfig.liveConfig,
          }),
        };
      },
    );
  }

  async getUsage(
    params: Schemas.GetInsightsApiRequest & { companyId: string; now?: number },
  ): Promise<Schemas.GetInsightsUsageApiResponse> {
    const { companyId } = params;
    const periods = Schemas.insightsRangePeriods(
      params.range ?? Schemas.DEFAULT_INSIGHTS_RANGE,
      params.now ?? Date.now(),
    );

    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetInsightsUsageApiResponse> => {
        const bot = await this.resolveChatbot(tx, companyId, params.botId);
        if (!bot.isSuccess) return bot;

        const rollups = await this.rollupsDal.getActivityRollups(tx, {
          companyId,
          chatbotId: bot.chatbot?.id ?? null,
          fromDay: periods.previous.fromDay,
          toDay: periods.current.toDay,
        });
        if (!rollups.isSuccess) return { isSuccess: false, message: rollups.message };

        return {
          isSuccess: true,
          message: "Usage fetched successfully",
          usage: InsightsProvider.buildUsage({
            periods,
            index: InsightsProvider.indexReadings(rollups.readings ?? []),
          }),
        };
      },
    );
  }

  async getImpact(
    params: Schemas.GetImpactApiRequest & { companyId: string; now?: number },
  ): Promise<Schemas.GetInsightsImpactApiResponse> {
    const { companyId } = params;
    const now = params.now ?? Date.now();
    const periods = Schemas.impactRangePeriods(params.range ?? Schemas.DEFAULT_IMPACT_RANGE, now);

    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetInsightsImpactApiResponse> => {
        const bot = await this.resolveChatbot(tx, companyId, params.botId);
        if (!bot.isSuccess) return bot;

        const rollups = await this.rollupsDal.getActivityRollups(tx, {
          companyId,
          chatbotId: bot.chatbot?.id ?? null,
          fromDay: periods.previous.fromDay,
          toDay: periods.current.toDay,
        });
        if (!rollups.isSuccess) return { isSuccess: false, message: rollups.message };
        const assumptions = await this.roiAssumptionsDal.getRoiAssumptions(tx, { companyId });
        if (!assumptions.isSuccess) return { isSuccess: false, message: assumptions.message };
        const tools = await this.toolDefinitionsDal.getWriteToolSummaries(tx, { companyId });
        if (!tools.isSuccess) return { isSuccess: false, message: tools.message };

        return {
          isSuccess: true,
          message: "Impact fetched successfully",
          impact: InsightsProvider.buildImpact({
            periods,
            index: InsightsProvider.indexReadings(rollups.readings ?? []),
            roiAssumptions: assumptions.roiAssumptions ?? [],
            writeTools: tools.tools ?? [],
            now,
          }),
        };
      },
    );
  }

  // DEV_NOTE: The botId's chatbot in this company (unknown → isNotFound), or null for the company-wide rows
  private async resolveChatbot(
    tx: Tx,
    companyId: string,
    botId: string | undefined,
  ): Promise<ResolvedChatbot> {
    if (botId === undefined) return { isSuccess: true, chatbot: null };
    const found = await this.chatbotsDal.getChatbotDetails(tx, { companyId, publicId: botId });
    if (!found.isSuccess || !found.chatbot) {
      return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
    }
    return { isSuccess: true, chatbot: found.chatbot };
  }

  // DEV_NOTE: The chatbot shown is the botId's, else the company's default; none → no live config card content
  private async getLiveConfig(
    tx: Tx,
    companyId: string,
    chatbot: Schemas.Chatbot | null,
  ): Promise<
    | { isSuccess: true; liveConfig: Schemas.InsightsLiveConfig | null }
    | { isSuccess: false; message?: string }
  > {
    let shown = chatbot;
    if (shown === null) {
      const fallback = await this.chatbotsDal.getDefaultChatbot(tx, { companyId });
      if (!fallback.isSuccess) {
        return fallback.isNotFound
          ? { isSuccess: true, liveConfig: null }
          : { isSuccess: false, message: fallback.message };
      }
      shown = fallback.chatbot ?? null;
    }
    if (shown === null) return { isSuccess: true, liveConfig: null };

    const config = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
      companyId,
      chatbotId: shown.id,
    });
    if (!config.isSuccess || !config.chatbotConfig) {
      return config.isNotFound
        ? { isSuccess: true, liveConfig: { chatbotName: shown.name, published: null } }
        : { isSuccess: false, message: config.message };
    }

    let publishedByName: string | null = null;
    if (config.chatbotConfig.publishedBy !== null) {
      const publisher = await this.adminsDal.getAdminDetails(tx, {
        companyId,
        adminId: config.chatbotConfig.publishedBy,
      });
      if (!publisher.isSuccess && !publisher.isNotFound) {
        return { isSuccess: false, message: publisher.message };
      }
      publishedByName = publisher.admin?.name ?? publisher.admin?.email ?? null;
    }

    return {
      isSuccess: true,
      liveConfig: {
        chatbotName: shown.name,
        published: {
          configVersion: config.chatbotConfig.configVersion,
          publishedAt: config.chatbotConfig.publishedAt?.toISOString() ?? null,
          publishedByName,
        },
      },
    };
  }
}
