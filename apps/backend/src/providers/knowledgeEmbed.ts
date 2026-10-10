import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";

// DEV_NOTE: The only env.AI.run caller for embeddings (pattern rule 3.10; the search reranker is KnowledgeRerankProvider):
// Workers AI bge-m3 embeddings for knowledge chunks (knowledge.embed) and search queries (search.embed), platform-paid
// (tier Embed), through the env's AI Gateway for logs, tagged with the task type. Texts go out in batches of KNOWLEDGE_EMBED_BATCH_SIZE, one call
// each; every call made is returned in calls (failed ones too) so the caller writes one model_calls row per call.
// bge-m3 returns no usage, so a call is counted at one token per input character plus its two special tokens: more
// than the tokenizer ever produces (usage Estimated, an overcount never an under). Stops at the first failed batch.
// Returns { isSuccess, message } and never throws.
const SPECIAL_TOKENS_PER_INPUT = 2;

export default class KnowledgeEmbedProvider {
  static async embed(
    env: Env,
    params: {
      companyPublicId: string;
      taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed | Schemas.ModelTaskTypeEnum.SearchEmbed;
      texts: string[];
    },
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
      // DEV_NOTE: aiGatewayLogId holds the last call's log id; a call that throws may never set it, so a failed call
      // records a log id only when it changed
      const previousLogId = env.AI.aiGatewayLogId;

      try {
        const output = await env.AI.run(
          Schemas.KNOWLEDGE_EMBEDDING_MODEL,
          // DEV_NOTE: Chunks stay far under 8,192 tokens; truncating is the backstop, never a failed document
          { text: batch, truncate_inputs: true },
          {
            gateway: {
              id: env.AI_GATEWAY_NAME,
              metadata: {
                company_id: params.companyPublicId,
                task_type: params.taskType,
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
        const logId = env.AI.aiGatewayLogId;
        response.calls?.push({
          inputTokens,
          latencyMs: Date.now() - startedAt,
          gatewayLogId: logId && logId !== previousLogId ? logId : null,
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
