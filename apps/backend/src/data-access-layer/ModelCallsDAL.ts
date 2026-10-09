import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { EmptyRelations, SQL } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  evalRuns,
  modelCalls,
} from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: model_calls rows are written by the model router only, once per call. The only later change is the usage
// backfill settling a Pending row (settleModelCallUsage). createModelCall and settleModelCallUsage are tenant methods
// (the tx from withTenant, every query filtered on companyId on top of RLS); getPendingModelCalls is the backfill's
// cross-company read and takes the tx from withPlatform.
export default class ModelCallsDAL {
  async createModelCall(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateModelCallDALRequest,
  ) {
    const response: Schemas.ModelCallDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing. One round trip: the company row,
      // with an EXISTS per optional reference that is set (null = background job, or not an eval). This runs per model
      // call, so it stays one query.
      const [references] = await tx
        .select({
          chatbot: this.referenceExists(
            chatbots,
            chatbots.id,
            chatbots.companyId,
            params.chatbotId,
            params.companyId,
          ),
          chatbotUser: this.referenceExists(
            chatbotUsers,
            chatbotUsers.id,
            chatbotUsers.companyId,
            params.chatbotUserId,
            params.companyId,
          ),
          conversation: this.referenceExists(
            conversations,
            conversations.id,
            conversations.companyId,
            params.conversationId,
            params.companyId,
          ),
          evalRun: this.referenceExists(
            evalRuns,
            evalRuns.id,
            evalRuns.companyId,
            params.evalRunId,
            params.companyId,
          ),
        })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      const checks: [boolean, string][] = references
        ? [
            [references.chatbot, "Chatbot not found"],
            [references.chatbotUser, "Chatbot user not found"],
            [references.conversation, "Conversation not found"],
            [references.evalRun, "Eval run not found"],
          ]
        : [[false, "Company not found"]];
      const notFound = checks.find(([exists]) => !exists)?.[1] ?? null;
      if (notFound) {
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateModelCall,
          message: notFound,
          metadata: params,
        });
        response.message = notFound;
        return response;
      }

      const [modelCallResponse] = await tx
        .insert(modelCalls)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          chatbotUserId: params.chatbotUserId,
          conversationId: params.conversationId,
          evalRunId: params.evalRunId,
          turnId: params.turnId,
          taskType: params.taskType,
          tier: params.tier,
          provider: params.provider,
          model: params.model,
          gatewayLogId: params.gatewayLogId,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cachedTokens: params.cachedTokens,
          costUsd: params.costUsd,
          latencyMs: params.latencyMs,
          wasEscalated: params.wasEscalated,
          errorCode: params.errorCode,
          usageStatus: params.usageStatus,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Model call created successfully";
      response.modelCall = modelCallResponse;
    } catch (error) {
      const message = "Unknown error in creating model call";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateModelCall,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: BudgetDO's seed (M2-4): the spend already recorded for the company since the start of its billing period.
  // A Pending or Unknown row adds its cost as it stands (0 until backfilled); the seed runs once per period, and every
  // call after it is counted by BudgetDO's own reservations.
  async getModelCallCostSum(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetModelCallCostSumDALRequest,
  ) {
    const response: Schemas.ModelCallCostSumDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(modelCalls.companyId, params.companyId),
        gte(modelCalls.createdAt, params.from),
      ];
      const [sum] = await tx
        .select({
          totalCostUsd: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(14, 6)`,
        })
        .from(modelCalls)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Model call cost sum fetched successfully";
      response.totalCostUsd = sum?.totalCostUsd ?? "0.000000";
    } catch (error) {
      const message = "Unknown error in fetching model call cost sum";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetModelCallCostSum,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Platform read (withPlatform) for the backfill sweep: Pending rows across companies, least recently tried
  // first (updated_at); the IDX_model_calls_created_at_pending partial index keeps the read to Pending rows
  async getPendingModelCalls(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetPendingModelCallsDALRequest,
  ) {
    const response: Schemas.ModelCallsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(modelCalls.usageStatus, Schemas.ModelCallUsageStatusIntEnum.Pending),
        lt(modelCalls.createdAt, params.createdBefore),
      ];
      if (params.companyIds) conditions.push(inArray(modelCalls.companyId, params.companyIds));
      const modelCallsResponse = await tx
        .select()
        .from(modelCalls)
        .where(and(...conditions))
        .orderBy(asc(modelCalls.updatedAt), asc(modelCalls.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Pending model calls fetched successfully";
      response.modelCalls = modelCallsResponse;
    } catch (error) {
      const message = "Unknown error in fetching pending model calls";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPendingModelCalls,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Settles a Pending row (Backfilled with its tokens and cost, or Unknown). Only a row still Pending is
  // updated, so a second sweep never settles it twice; isNotFound when it is gone or already settled.
  async settleModelCallUsage(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SettleModelCallUsageDALRequest,
  ) {
    const response: Schemas.ModelCallDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(modelCalls.publicId, params.publicId),
        eq(modelCalls.companyId, params.companyId),
        eq(modelCalls.usageStatus, Schemas.ModelCallUsageStatusIntEnum.Pending),
      ];
      const [modelCallResponse] = await tx
        .update(modelCalls)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          usageStatus: params.usageStatus,
          inputTokens: params.inputTokens ?? undefined,
          outputTokens: params.outputTokens ?? undefined,
          costUsd: params.costUsd ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!modelCallResponse) {
        const message = "Pending model call not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SettleModelCallUsage,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Model call usage settled successfully";
      response.modelCall = modelCallResponse;
    } catch (error) {
      const message = "Unknown error in settling model call usage";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SettleModelCallUsage,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A Pending row the backfill couldn't settle yet: updated_at = now, so the next sweep tries others first.
  // Only while still Pending.
  async touchPendingModelCall(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.TouchPendingModelCallDALRequest,
  ) {
    const response: Schemas.ModelCallDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(modelCalls.publicId, params.publicId),
        eq(modelCalls.companyId, params.companyId),
        eq(modelCalls.usageStatus, Schemas.ModelCallUsageStatusIntEnum.Pending),
      ];
      const [modelCallResponse] = await tx
        .update(modelCalls)
        .set({ updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Pending model call marked as tried";
      response.modelCall = modelCallResponse;
    } catch (error) {
      const message = "Unknown error in marking a pending model call as tried";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.TouchPendingModelCall,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: true when the reference is unset, else whether the row exists inside the company
  private referenceExists(
    table: PgTable,
    idColumn: PgColumn,
    companyIdColumn: PgColumn,
    id: string | null,
    companyId: string,
  ): SQL<boolean> {
    if (id === null) {
      return sql<boolean>`true`;
    }
    return sql<boolean>`exists (select 1 from ${table} where ${idColumn} = ${id} and ${companyIdColumn} = ${companyId})`;
  }
}
