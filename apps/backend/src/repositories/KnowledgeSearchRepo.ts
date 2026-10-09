import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeModelCallsProvider from "@/providers/knowledgeModelCalls";
import KnowledgeRankingProvider from "@/providers/knowledgeRanking";
import KnowledgeRerankProvider from "@/providers/knowledgeRerank";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Knowledge search (M2-6), called by the Conversation DO's search_help_docs tool. Hybrid: one query
// embedding (bge-m3, search.embed), then the vector side (HNSW cosine) and the keyword side (GIN tsvector) in one
// withTenant transaction, fused by reciprocal rank (KnowledgeRankingProvider) to KNOWLEDGE_SEARCH_RERANK_CANDIDATES,
// reranked (bge-reranker-base, search.rerank), and cut to the hits scoring at least KNOWLEDGE_SEARCH_MIN_SCORE, at most
// topK. Reranking is per query and never stored.
//
// Source filter: only the bot's sources (config knowledge.sourceIds, public ids) that exist in this company, whatever
// their status (Paused stops syncing, not search). An id from another company or a deleted source matches nothing.
// Only chunks of Indexed documents embedded with KNOWLEDGE_EMBEDDING_MODEL are searched. No source left, or a blank
// query: no hits and no model call.
//
// Cost: the Workers AI calls are platform-paid (tier Embed), never held against the company budget; each gets its
// model_calls row with the search's chatbot, user, conversation and turn, written in waitUntil (failed calls too). Both
// models must be priced before any call goes out.
//
// Never throws. A failure is logged and answered isSuccess false (the tool tells the model search is unavailable).
// The query text is never logged (it may hold what the user typed).
export default class KnowledgeSearchRepo {
  private env: Env;
  private db: NodePgDatabase;
  private ctx: Pick<ExecutionContext, "waitUntil">;
  private companiesDal: CompaniesDAL;
  private knowledgeSourcesDal: KnowledgeSourcesDAL;
  private knowledgeChunksDal: KnowledgeChunksDAL;

  // DEV_NOTE: ctx is the Durable Object's state (or a Worker's ExecutionContext): the model_calls rows are written in
  // its waitUntil, so they never delay the answer
  constructor(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
    this.env = env;
    this.db = getDbClient(env);
    this.ctx = ctx;
    this.companiesDal = new CompaniesDAL();
    this.knowledgeSourcesDal = new KnowledgeSourcesDAL();
    this.knowledgeChunksDal = new KnowledgeChunksDAL();
  }

  async search(request: Schemas.SearchKnowledgeRequest): Promise<Schemas.SearchKnowledgeResponse> {
    const madeCalls: Schemas.KnowledgeSearchModelCalls[] = [];
    try {
      return await this.runSearch(request, madeCalls);
    } finally {
      if (madeCalls.some((entry) => entry.calls.length > 0)) {
        this.ctx.waitUntil(this.recordCalls(request, madeCalls));
      }
    }
  }

  private async runSearch(
    request: Schemas.SearchKnowledgeRequest,
    madeCalls: Schemas.KnowledgeSearchModelCalls[],
  ): Promise<Schemas.SearchKnowledgeResponse> {
    const response: Schemas.SearchKnowledgeResponse = { isSuccess: false };
    const metadata = {
      companyId: request.companyId,
      chatbotId: request.chatbotId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      sourceCount: request.sourcePublicIds.length,
    };
    const query = request.query.trim();
    if (query.length === 0 || request.sourcePublicIds.length === 0) {
      response.isSuccess = true;
      response.message = "Nothing to search";
      response.hits = [];
      return response;
    }

    if (
      !KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL) ||
      !KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_RERANK_MODEL)
    ) {
      const message = "Knowledge search model is not priced";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.SearchKnowledge,
        message,
        metadata,
      });
      response.message = message;
      return response;
    }

    const scope = await withTenant<Schemas.KnowledgeSearchScopeResponse>(
      this.db,
      request.companyId,
      async (tx) => {
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: request.companyId,
        });
        if (!company.isSuccess || !company.company) {
          throw new TenantRollbackError(company.message);
        }
        const sources = await this.knowledgeSourcesDal.getKnowledgeSourceIds(tx, {
          companyId: request.companyId,
          publicIds: request.sourcePublicIds,
        });
        if (!sources.isSuccess) throw new TenantRollbackError(sources.message);
        return {
          isSuccess: true,
          companyPublicId: company.company.publicId,
          knowledgeSourceIds: sources.knowledgeSourceIds ?? [],
        };
      },
    );
    if (!scope.isSuccess || !("companyPublicId" in scope) || !scope.companyPublicId) {
      return this.fail(response, "Knowledge search scope not loaded", metadata, scope.message);
    }
    const knowledgeSourceIds = scope.knowledgeSourceIds ?? [];
    if (knowledgeSourceIds.length === 0) {
      response.isSuccess = true;
      response.message = "None of the chatbot's knowledge sources exist";
      response.hits = [];
      return response;
    }

    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId: scope.companyPublicId,
      taskType: Schemas.ModelTaskTypeEnum.SearchEmbed,
      texts: [query],
    });
    madeCalls.push({
      taskType: Schemas.ModelTaskTypeEnum.SearchEmbed,
      model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      calls: embedded.calls ?? [],
    });
    const embedding = embedded.embeddings?.[0];
    if (!embedded.isSuccess || !embedding) {
      return this.fail(response, "Search query not embedded", metadata, embedded.message);
    }

    const candidates = await withTenant<Schemas.KnowledgeSearchCandidatesResponse>(
      this.db,
      request.companyId,
      async (tx) => {
        const side = {
          companyId: request.companyId,
          knowledgeSourceIds,
          embeddingModel: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
          limit: Constants.KNOWLEDGE_SEARCH_CANDIDATES_PER_SIDE,
        };
        const vector = await this.knowledgeChunksDal.searchKnowledgeChunksByVector(tx, {
          ...side,
          embedding,
          efSearch: Math.max(
            Constants.KNOWLEDGE_SEARCH_HNSW_EF_SEARCH,
            Constants.KNOWLEDGE_SEARCH_CANDIDATES_PER_SIDE,
          ),
        });
        if (!vector.isSuccess) throw new TenantRollbackError(vector.message);
        const keyword = await this.knowledgeChunksDal.searchKnowledgeChunksByKeyword(tx, {
          ...side,
          query,
        });
        if (!keyword.isSuccess) throw new TenantRollbackError(keyword.message);
        return {
          isSuccess: true,
          vectorMatches: vector.matches ?? [],
          keywordMatches: keyword.matches ?? [],
        };
      },
    );
    if (!candidates.isSuccess || !("vectorMatches" in candidates)) {
      return this.fail(response, "Knowledge chunks not searched", metadata, candidates.message);
    }

    const fused = KnowledgeRankingProvider.fuse(
      [candidates.vectorMatches ?? [], candidates.keywordMatches ?? []],
      {
        k: Constants.KNOWLEDGE_SEARCH_RRF_K,
        limit: Constants.KNOWLEDGE_SEARCH_RERANK_CANDIDATES,
      },
    );
    if (fused.length === 0) {
      response.isSuccess = true;
      response.message = "No knowledge chunks matched";
      response.hits = [];
      return response;
    }

    const reranked = await KnowledgeRerankProvider.rerank(this.env, {
      companyPublicId: scope.companyPublicId,
      query,
      texts: fused.map((candidate) => KnowledgeChunkerProvider.embeddingText(candidate)),
    });
    madeCalls.push({
      taskType: Schemas.ModelTaskTypeEnum.SearchRerank,
      model: Schemas.KNOWLEDGE_RERANK_MODEL,
      calls: reranked.call ? [reranked.call] : [],
    });
    if (!reranked.isSuccess || !reranked.scores) {
      return this.fail(response, "Knowledge chunks not reranked", metadata, reranked.message);
    }

    response.isSuccess = true;
    response.message = "Knowledge searched successfully";
    response.hits = KnowledgeRankingProvider.selectHits(fused, reranked.scores, {
      minScore: Constants.KNOWLEDGE_SEARCH_MIN_SCORE,
      topK: request.topK,
    });
    return response;
  }

  private fail(
    response: Schemas.SearchKnowledgeResponse,
    message: string,
    metadata: Record<string, unknown>,
    reason: string | undefined,
  ): Schemas.SearchKnowledgeResponse {
    AppLogger.error({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.SearchKnowledge,
      message,
      metadata: { ...metadata, reason: reason ?? null },
    });
    response.message = message;
    return response;
  }

  // DEV_NOTE: One transaction for the search's rows; a failed row rolls them all back and is logged with the calls'
  // token counts, so the spend stays visible. Runs in waitUntil, so it never throws.
  private async recordCalls(
    request: Schemas.SearchKnowledgeRequest,
    madeCalls: Schemas.KnowledgeSearchModelCalls[],
  ): Promise<void> {
    const links = {
      chatbotId: request.chatbotId,
      chatbotUserId: request.chatbotUserId,
      conversationId: request.conversationId,
      turnId: request.turnId,
    };
    const recorded = await withTenant(this.db, request.companyId, async (tx) => {
      for (const entry of madeCalls) {
        const price = KnowledgeModelCallsProvider.price(entry.model);
        if (!price) throw new TenantRollbackError("Knowledge search model is not priced");
        const result = await KnowledgeModelCallsProvider.record(tx, {
          companyId: request.companyId,
          links,
          taskType: entry.taskType,
          model: entry.model,
          price,
          calls: entry.calls,
        });
        if (!result.isSuccess) throw new TenantRollbackError(result.message);
      }
      return { isSuccess: true };
    });
    if (!recorded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.RecordKnowledgeModelCalls,
        message: "Search calls were made but their model_calls rows could not be written",
        metadata: {
          companyId: request.companyId,
          conversationId: request.conversationId,
          turnId: request.turnId,
          calls: madeCalls.reduce((total, entry) => total + entry.calls.length, 0),
          inputTokens: madeCalls.reduce(
            (total, entry) => total + entry.calls.reduce((sum, call) => sum + call.inputTokens, 0),
            0,
          ),
          reason: recorded.message ?? null,
        },
      });
    }
  }
}
