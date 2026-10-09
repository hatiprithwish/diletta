import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";

// DEV_NOTE: The model_calls rows of knowledge's Workers AI calls: ingestion embeddings (M2-5) and a search's query
// embedding and rerank (M2-6). One per call, failed calls too (the platform pays either way). Tier Embed, provider
// workers_ai, usage Estimated (the callers count one token per character), priced from PLATFORM_MODEL_PRICES rounded up
// so a billed call is never $0. A search's rows carry its chatbot, user, conversation and turn (links); ingestion's carry
// none. Takes the Repo's withTenant tx and never opens one; returns { isSuccess, message } and never throws. A failed
// row fails the whole write, so the Repo rolls it back instead of committing an aborted transaction.
export default class KnowledgeModelCallsProvider {
  private static dal = new ModelCallsDAL();

  // DEV_NOTE: Checked before any call is made, so an unpriced model is refused, never recorded at 0
  static price(model: string): Schemas.ModelPrice | null {
    return Schemas.getModelCallPrice(Schemas.PlatformModelProviderEnum.WorkersAi, model);
  }

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      links: Schemas.KnowledgeModelCallLinks;
      taskType:
        | Schemas.ModelTaskTypeEnum.KnowledgeEmbed
        | Schemas.ModelTaskTypeEnum.SearchEmbed
        | Schemas.ModelTaskTypeEnum.SearchRerank;
      model: string;
      price: Schemas.ModelPrice;
      calls: Schemas.KnowledgeModelCall[];
    },
  ): Promise<Schemas.ApiResponse> {
    for (const call of params.calls) {
      const created = await KnowledgeModelCallsProvider.dal.createModelCall(tx, {
        companyId: params.companyId,
        chatbotId: params.links.chatbotId,
        chatbotUserId: params.links.chatbotUserId,
        conversationId: params.links.conversationId,
        evalRunId: null,
        turnId: params.links.turnId,
        taskType: params.taskType,
        tier: Schemas.ModelCallTierIntEnum.Embed,
        provider: Schemas.PlatformModelProviderEnum.WorkersAi,
        model: params.model,
        gatewayLogId: call.gatewayLogId,
        inputTokens: call.inputTokens,
        outputTokens: null,
        cachedTokens: 0,
        costUsd: Schemas.computeModelCallCostUsd(
          params.price,
          {
            inputTokens: call.inputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
          true,
        ),
        latencyMs: call.latencyMs,
        wasEscalated: false,
        errorCode: call.errorCode,
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Estimated,
      });
      if (!created.isSuccess) {
        return { isSuccess: false, message: created.message };
      }
    }
    return { isSuccess: true, message: "Knowledge model calls recorded" };
  }
}
