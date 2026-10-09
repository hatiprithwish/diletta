import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";

// DEV_NOTE: The only env.AI.run caller (pattern rule 3.10): Workers AI bge-m3 embeddings for knowledge, platform-paid
// (tier Embed), through the env's AI Gateway for logs. Texts go out in batches of KNOWLEDGE_EMBED_BATCH_SIZE, one call
// each; every call made is returned in calls (failed ones too) so the caller writes one model_calls row per call.
// bge-m3 returns no usage, so a call is counted at one token per input character plus its two special tokens: more
// than the tokenizer ever produces (usage Estimated, an overcount never an under). Stops at the first failed batch.
// Returns { isSuccess, message } and never throws.
const SPECIAL_TOKENS_PER_INPUT = 2;

export default class KnowledgeEmbedProvider {
  static async embed(
    env: Env,
    params: { companyPublicId: string; texts: string[] },
  ): Promise<Schemas.KnowledgeEmbedResponse> {
    const response: Schemas.KnowledgeEmbedResponse = { isSuccess: false, calls: [] };
    const embeddings: number[][] = [];

    for (
      let start = 0;
      start < params.texts.length;
      start += Constants.KNOWLEDGE_EMBED_BATCH_SIZE
    ) {
      const batch = params.texts.slice(start, start + Constants.KNOWLEDGE_EMBED_BATCH_SIZE);
      const inputTokens = batch.reduce(
        (total, text) => total + text.length + SPECIAL_TOKENS_PER_INPUT,
        0,
      );
      const startedAt = Date.now();

      try {
        const output = await env.AI.run(
          Schemas.KNOWLEDGE_EMBEDDING_MODEL,
          { text: batch },
          {
            gateway: {
              id: env.AI_GATEWAY_NAME,
              metadata: {
                company_id: params.companyPublicId,
                task_type: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
              },
            },
          },
        );
        const vectors = "data" in output ? output.data : undefined;
        response.calls?.push({
          inputTokens,
          latencyMs: Date.now() - startedAt,
          gatewayLogId: env.AI.aiGatewayLogId,
          errorCode: null,
        });

        const isValid =
          Array.isArray(vectors) &&
          vectors.length === batch.length &&
          vectors.every(
            (vector) =>
              Array.isArray(vector) &&
              vector.length === Schemas.KNOWLEDGE_EMBEDDING_DIMENSIONS &&
              vector.every((value) => Number.isFinite(value)),
          );
        if (!isValid || !vectors) {
          const message = "Embedding response has the wrong shape";
          AppLogger.error({
            category: Schemas.LogCategory.Knowledge,
            action: Schemas.LogAction.EmbedKnowledgeChunks,
            message,
            metadata: {
              batchSize: batch.length,
              returned: Array.isArray(vectors) ? vectors.length : null,
            },
          });
          response.message = message;
          return response;
        }
        embeddings.push(...vectors);
      } catch (error) {
        response.calls?.push({
          inputTokens,
          latencyMs: Date.now() - startedAt,
          gatewayLogId: env.AI.aiGatewayLogId,
          errorCode: "embed_failed",
        });
        const message = "Unknown error in embedding knowledge chunks";
        AppLogger.error({
          category: Schemas.LogCategory.Knowledge,
          action: Schemas.LogAction.EmbedKnowledgeChunks,
          message,
          error,
          metadata: { batchSize: batch.length },
        });
        response.message = message;
        return response;
      }
    }

    response.isSuccess = true;
    response.message = "Knowledge chunks embedded successfully";
    response.embeddings = embeddings;
    return response;
  }
}
