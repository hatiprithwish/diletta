import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
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

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). model_calls rows are written by the model
// router only, once per call, and never updated.
export default class ModelCallsDAL {
  async createModelCall(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateModelCallDALRequest,
  ) {
    const response: Schemas.ModelCallDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing. Each optional reference is
      // checked only when set (null = background job, or not an eval).
      const notFound = await this.findMissingReference(tx, params);
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

  // DEV_NOTE: The first reference that doesn't resolve inside the company, as a message; null when all do
  private async findMissingReference(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateModelCallDALRequest,
  ): Promise<string | null> {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, params.companyId))
      .limit(1);
    if (!company) return "Company not found";

    if (params.chatbotId !== null) {
      const conditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...conditions))
        .limit(1);
      if (!chatbot) return "Chatbot not found";
    }

    if (params.chatbotUserId !== null) {
      const conditions = [
        eq(chatbotUsers.id, params.chatbotUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUser] = await tx
        .select({ id: chatbotUsers.id })
        .from(chatbotUsers)
        .where(and(...conditions))
        .limit(1);
      if (!chatbotUser) return "Chatbot user not found";
    }

    if (params.conversationId !== null) {
      const conditions = [
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conditions))
        .limit(1);
      if (!conversation) return "Conversation not found";
    }

    if (params.evalRunId !== null) {
      const conditions = [
        eq(evalRuns.id, params.evalRunId),
        eq(evalRuns.companyId, params.companyId),
      ];
      const [evalRun] = await tx
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(and(...conditions))
        .limit(1);
      if (!evalRun) return "Eval run not found";
    }

    return null;
  }
}
