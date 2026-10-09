import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";

// DEV_NOTE: The model_calls rows of knowledge embeddings (M2-5): one per Workers AI call, failed calls too (the
// platform pays either way). Tier Embed, provider workers_ai, usage Estimated (KnowledgeEmbedProvider counts one token
// per character), priced from PLATFORM_MODEL_PRICES rounded up so a billed call is never $0. Takes the Repo's
// withTenant tx and never opens one; returns { isSuccess, message } and never throws. A failed row fails the whole
// write, so the Repo rolls it back instead of committing an aborted transaction.
export default class KnowledgeEmbedCallsProvider {
  private static dal = new ModelCallsDAL();

  // DEV_NOTE: Checked before any call is made, so an unpriced model is refused, never recorded at 0
  static price(): Schemas.ModelPrice | null {
    return Schemas.getModelCallPrice(
      Schemas.PlatformModelProviderEnum.WorkersAi,
      Schemas.KNOWLEDGE_EMBEDDING_MODEL,
    );
  }

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; price: Schemas.ModelPrice; calls: Schemas.KnowledgeEmbedCall[] },
  ): Promise<Schemas.ApiResponse> {
    for (const call of params.calls) {
      const created = await KnowledgeEmbedCallsProvider.dal.createModelCall(tx, {
        companyId: params.companyId,
        chatbotId: null,
        chatbotUserId: null,
        conversationId: null,
        evalRunId: null,
        turnId: null,
        taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
        tier: Schemas.ModelCallTierIntEnum.Embed,
        provider: Schemas.PlatformModelProviderEnum.WorkersAi,
        model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
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
    return { isSuccess: true, message: "Embedding calls recorded" };
  }
}
