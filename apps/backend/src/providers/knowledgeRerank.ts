import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: The only env.AI.run caller for reranking (pattern rule 3.10): Workers AI bge-reranker-base scores each
// search candidate against the query, platform-paid (tier Embed, search.rerank), through the env's AI Gateway for logs.
// One call per search. The model returns no usage, so the call is counted at one token per character of the query and
// of each candidate, plus its special tokens per pair: more than the tokenizer ever produces (usage Estimated, an
// overcount never an under). Scores come back in input order, each in [0, 1] (toProbabilities). The call made, failed
// or not, is returned in call for its model_calls row. Returns { isSuccess, message } and never throws.
const SPECIAL_TOKENS_PER_PAIR = 3;

export default class KnowledgeRerankProvider {
  static async rerank(
    env: Env,
    params: { companyPublicId: string; query: string; texts: string[] },
  ): Promise<Schemas.KnowledgeRerankResponse> {
    const response: Schemas.KnowledgeRerankResponse = { isSuccess: false };
    if (params.texts.length === 0) {
      response.isSuccess = true;
      response.message = "Nothing to rerank";
      response.scores = [];
      return response;
    }

    const inputTokens = params.texts.reduce(
      (total, text) => total + params.query.length + text.length + SPECIAL_TOKENS_PER_PAIR,
      0,
    );
    const startedAt = Date.now();
    // DEV_NOTE: aiGatewayLogId holds the last call's log id; a call that throws may never set it, so a failed call
    // records a log id only when it changed
    const previousLogId = env.AI.aiGatewayLogId;
    // DEV_NOTE: The generated input type for this model has lost its query field (worker-configuration.d.ts lists
    // only top_k and contexts), though the model requires it. A variable, not an inline literal, carries it through
    // without a cast.
    const inputs = {
      query: params.query,
      contexts: params.texts.map((text) => ({ text })),
      top_k: params.texts.length,
    };

    try {
      const output = await env.AI.run(Schemas.KNOWLEDGE_RERANK_MODEL, inputs, {
        gateway: {
          id: env.AI_GATEWAY_NAME,
          metadata: {
            company_id: params.companyPublicId,
            task_type: Schemas.ModelTaskTypeEnum.SearchRerank,
          },
        },
      });
      response.call = {
        inputTokens,
        latencyMs: Date.now() - startedAt,
        gatewayLogId: env.AI.aiGatewayLogId,
        errorCode: null,
      };

      const rawScores = KnowledgeRerankProvider.readScores(output.response, params.texts.length);
      if (!rawScores) {
        const message = "Rerank response has the wrong shape";
        AppLogger.error({
          category: Schemas.LogCategory.Knowledge,
          action: Schemas.LogAction.RerankKnowledgeChunks,
          message,
          metadata: {
            candidates: params.texts.length,
            returned: Array.isArray(output.response) ? output.response.length : null,
          },
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge chunks reranked successfully";
      response.scores = KnowledgeRerankProvider.toProbabilities(rawScores);
    } catch (error) {
      const logId = env.AI.aiGatewayLogId;
      response.call = {
        inputTokens,
        latencyMs: Date.now() - startedAt,
        gatewayLogId: logId && logId !== previousLogId ? logId : null,
        errorCode: "rerank_failed",
      };
      const message = "Unknown error in reranking knowledge chunks";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.RerankKnowledgeChunks,
        message,
        error,
        metadata: { candidates: params.texts.length },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The model answers { id, score } per candidate, best first; id is the candidate's index. Every candidate
  // must come back exactly once with a finite score, or the answer is refused (null).
  static readScores(
    entries: { id?: number; score?: number }[] | undefined,
    count: number,
  ): number[] | null {
    if (!Array.isArray(entries) || entries.length !== count) return null;
    const scores: (number | undefined)[] = new Array<number | undefined>(count).fill(undefined);
    for (const entry of entries) {
      const { id, score } = entry;
      if (
        typeof id !== "number" ||
        !Number.isInteger(id) ||
        id < 0 ||
        id >= count ||
        scores[id] !== undefined ||
        typeof score !== "number" ||
        !Number.isFinite(score)
      ) {
        return null;
      }
      scores[id] = score;
    }
    return scores.map((score) => score ?? 0);
  }

  // DEV_NOTE: bge-reranker-base outputs a relevance logit, which a sigmoid maps to [0, 1]; Workers AI documents that
  // mapping but not whether it applies it. A response whose scores all lie in [0, 1] is read as already mapped; any
  // score outside means raw logits, and every score gets the sigmoid. Either way KNOWLEDGE_SEARCH_MIN_SCORE compares
  // against a probability.
  static toProbabilities(scores: number[]): number[] {
    const isMapped = scores.every((score) => score >= 0 && score <= 1);
    return isMapped ? scores : scores.map((score) => 1 / (1 + Math.exp(-score)));
  }
}
