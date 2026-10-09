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

// DEV_NOTE: Knowledge search (M2-6), called by the Conversation DO's search_help_docs tool. Steps, each its own
// method: prices (both models, before any call) → scope (the bot's sources in this company) → embed the query
// (bge-m3, search.embed) → candidates (vector side HNSW cosine + keyword side GIN tsvector in one withTenant, fused
// by reciprocal rank to KNOWLEDGE_SEARCH_RERANK_CANDIDATES) → rerank (bge-reranker-base, search.rerank) → hits scoring
// at least KNOWLEDGE_SEARCH_MIN_SCORE, at most topK. Reranking is per query and never stored.
//
// Source filter: only the bot's sources (config knowledge.sourceIds, public ids) that exist in this company, whatever
// their status (Paused stops syncing, not search). An id from another company or a deleted source matches nothing.
// Only chunks of Indexed documents embedded with KNOWLEDGE_EMBEDDING_MODEL are searched. No source left, or a blank
// query: no hits and no model call.
//
// Cost: the Workers AI calls are platform-paid (tier Embed), never held against the company budget. The steps that
// call a model return their calls; search collects them and, whatever the outcome, writes one model_calls row per call
// (failed too) with the search's chatbot, user, conversation and turn, in waitUntil.
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
    const query = request.query.trim();
    if (query.length === 0 || request.sourcePublicIds.length === 0) {
      return KnowledgeSearchRepo.noHits("Nothing to search");
    }

    const prices = KnowledgeSearchRepo.prices();
    if (!prices) {
      return this.fail(request, "Knowledge search model is not priced", undefined);
    }

    const scope = await this.resolveScope(request);
    if (!scope.isSuccess || !scope.companyPublicId) {
      return this.fail(request, "Knowledge search scope not loaded", scope.message);
    }
    const knowledgeSourceIds = scope.knowledgeSourceIds ?? [];
    if (knowledgeSourceIds.length === 0) {
      return KnowledgeSearchRepo.noHits("None of the chatbot's knowledge sources exist");
    }

    const madeCalls: Schemas.KnowledgeSearchModelCalls[] = [];
    const embedded = await this.embedQuery(scope.companyPublicId, query, prices.embed);
    madeCalls.push(embedded.calls);
    if (!embedded.isSuccess || !embedded.embedding) {
      return this.finish(
        request,
        madeCalls,
        this.fail(request, "Search query not embedded", embedded.message),
      );
    }

    const found = await this.findCandidates(request, knowledgeSourceIds, embedded.embedding, query);
    if (!found.isSuccess || !found.candidates) {
      return this.finish(
        request,
        madeCalls,
        this.fail(request, "Knowledge chunks not searched", found.message),
      );
    }
    if (found.candidates.length === 0) {
      return this.finish(
        request,
        madeCalls,
        KnowledgeSearchRepo.noHits("No knowledge chunks matched"),
      );
    }

    const reranked = await this.rerankCandidates(
      scope.companyPublicId,
      query,
      found.candidates,
      prices.rerank,
    );
    madeCalls.push(reranked.calls);
    if (!reranked.isSuccess || !reranked.scores) {
      return this.finish(
        request,
        madeCalls,
        this.fail(request, "Knowledge chunks not reranked", reranked.message),
      );
    }

    return this.finish(request, madeCalls, {
      isSuccess: true,
      message: "Knowledge searched successfully",
      hits: KnowledgeRankingProvider.selectHits(found.candidates, reranked.scores, {
        minScore: Constants.KNOWLEDGE_SEARCH_MIN_SCORE,
        topK: request.topK,
      }),
    });
  }

  // DEV_NOTE: Both models' prices, or null when either is missing from PLATFORM_MODEL_PRICES (then no call goes out)
  private static prices(): Schemas.KnowledgeSearchPrices | null {
    const embed = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL);
    const rerank = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_RERANK_MODEL);
    return embed && rerank ? { embed, rerank } : null;
  }

  private async resolveScope(
    request: Schemas.SearchKnowledgeRequest,
  ): Promise<Schemas.KnowledgeSearchScopeResponse> {
    const scope: Schemas.KnowledgeSearchScopeResponse = await withTenant(
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
    return scope;
  }

  private async embedQuery(
    companyPublicId: string,
    query: string,
    price: Schemas.ModelPrice,
  ): Promise<Schemas.KnowledgeSearchEmbeddingResponse> {
    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId,
      taskType: Schemas.ModelTaskTypeEnum.SearchEmbed,
      texts: [query],
    });
    const embedding = embedded.embeddings?.[0];
    return {
      isSuccess: embedded.isSuccess && embedding !== undefined,
      message: embedded.message,
      embedding,
      calls: {
        taskType: Schemas.ModelTaskTypeEnum.SearchEmbed,
        model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
        price,
        calls: embedded.calls ?? [],
      },
    };
  }

  // DEV_NOTE: Both sides in one transaction (the vector side's HNSW settings are transaction-local), then fused
  private async findCandidates(
    request: Schemas.SearchKnowledgeRequest,
    knowledgeSourceIds: string[],
    embedding: number[],
    query: string,
  ): Promise<Schemas.KnowledgeSearchCandidatesResponse> {
    const found: Schemas.KnowledgeSearchCandidatesResponse = await withTenant(
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
          candidates: KnowledgeRankingProvider.fuse([vector.matches ?? [], keyword.matches ?? []], {
            k: Constants.KNOWLEDGE_SEARCH_RRF_K,
            limit: Constants.KNOWLEDGE_SEARCH_RERANK_CANDIDATES,
          }),
        };
      },
    );
    return found;
  }

  private async rerankCandidates(
    companyPublicId: string,
    query: string,
    candidates: Schemas.FusedKnowledgeChunk[],
    price: Schemas.ModelPrice,
  ): Promise<Schemas.KnowledgeSearchRerankResponse> {
    const reranked = await KnowledgeRerankProvider.rerank(this.env, {
      companyPublicId,
      query,
      texts: candidates.map((candidate) => KnowledgeChunkerProvider.embeddingText(candidate)),
    });
    return {
      isSuccess: reranked.isSuccess && reranked.scores !== undefined,
      message: reranked.message,
      scores: reranked.scores,
      calls: {
        taskType: Schemas.ModelTaskTypeEnum.SearchRerank,
        model: Schemas.KNOWLEDGE_RERANK_MODEL,
        price,
        calls: reranked.call ? [reranked.call] : [],
      },
    };
  }

  // DEV_NOTE: Every exit after a model call goes through here, so each call made gets its row
  private finish(
    request: Schemas.SearchKnowledgeRequest,
    madeCalls: Schemas.KnowledgeSearchModelCalls[],
    response: Schemas.SearchKnowledgeResponse,
  ): Schemas.SearchKnowledgeResponse {
    if (madeCalls.some((entry) => entry.calls.length > 0)) {
      this.ctx.waitUntil(this.recordCalls(request, madeCalls));
    }
    return response;
  }

  private static noHits(message: string): Schemas.SearchKnowledgeResponse {
    return { isSuccess: true, message, hits: [] };
  }

  private fail(
    request: Schemas.SearchKnowledgeRequest,
    message: string,
    reason: string | undefined,
  ): Schemas.SearchKnowledgeResponse {
    AppLogger.error({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.SearchKnowledge,
      message,
      metadata: {
        companyId: request.companyId,
        chatbotId: request.chatbotId,
        conversationId: request.conversationId,
        turnId: request.turnId,
        sourceCount: request.sourcePublicIds.length,
        reason: reason ?? null,
      },
    });
    return { isSuccess: false, message };
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
        const result = await KnowledgeModelCallsProvider.record(tx, {
          companyId: request.companyId,
          links,
          taskType: entry.taskType,
          model: entry.model,
          price: entry.price,
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
