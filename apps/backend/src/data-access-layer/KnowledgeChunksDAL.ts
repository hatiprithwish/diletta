import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { knowledgeChunks, knowledgeDocuments } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). knowledge_chunks is derived: a changed document's
// chunks are deleted and written again in one transaction, never updated in place. The two search methods are the
// sides of the hybrid search (M2-6): each matches only chunks of the given sources, embedded with the given model, whose
// document is in the company and Indexed, and returns them best first with their document's citation fields.
export default class KnowledgeChunksDAL {
  async createKnowledgeChunks(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateKnowledgeChunksDALRequest,
  ) {
    const response: Schemas.KnowledgeChunksWriteDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      knowledgeDocumentId: params.knowledgeDocumentId,
      knowledgeSourceId: params.knowledgeSourceId,
      chunkCount: params.chunks.length,
    };

    if (params.chunks.length === 0) {
      response.isSuccess = true;
      response.message = "No knowledge chunks to create";
      response.rowCount = 0;
      return response;
    }

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the document exists in this company and belongs to the source
      // the chunks copy (the search filters on that copy)
      const conditions = [
        eq(knowledgeDocuments.id, params.knowledgeDocumentId),
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];
      const [document] = await tx
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .limit(1);

      if (!document) {
        const message = "Knowledge document not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateKnowledgeChunks,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const created = await tx.insert(knowledgeChunks).values(
        params.chunks.map((chunk) => ({
          companyId: params.companyId,
          knowledgeDocumentId: params.knowledgeDocumentId,
          knowledgeSourceId: params.knowledgeSourceId,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          text: chunk.text,
          embedding: chunk.embedding,
          embeddingModel: chunk.embeddingModel,
        })),
      );

      response.isSuccess = true;
      response.message = "Knowledge chunks created successfully";
      response.rowCount = created.rowCount ?? 0;
    } catch (error) {
      const message = "Unknown error in creating knowledge chunks";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateKnowledgeChunks,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async searchKnowledgeChunksByVector(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SearchKnowledgeChunksByVectorDALRequest,
  ) {
    const response: Schemas.KnowledgeChunkMatchesDALResponse = { isSuccess: false };

    if (params.knowledgeSourceIds.length === 0) {
      return KnowledgeChunksDAL.noSourcesToSearch(response);
    }

    try {
      // DEV_NOTE: The company and source filters apply after the HNSW scan, so a plain scan could return far fewer than
      // limit rows; an iterative scan keeps scanning until limit rows pass them. Both settings last for this transaction
      // only (set_config(…, true)). relaxed_order may return rows slightly out of distance order, so they are sorted
      // again below.
      await tx.execute(
        sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', ${String(params.efSearch)}, true)`,
      );

      const distance =
        sql<number>`${knowledgeChunks.embedding} <=> ${JSON.stringify(params.embedding)}::halfvec`.mapWith(
          Number,
        );
      const conditions = [
        ...KnowledgeChunksDAL.searchConditions(params),
        isNotNull(knowledgeChunks.embedding),
      ];
      const rows = await tx
        .select({ ...KnowledgeChunksDAL.matchColumns, distance })
        .from(knowledgeChunks)
        .innerJoin(
          knowledgeDocuments,
          eq(knowledgeDocuments.id, knowledgeChunks.knowledgeDocumentId),
        )
        .where(and(...conditions))
        // DEV_NOTE: Ordered by the distance alone, so the HNSW index serves it
        .orderBy(distance)
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Knowledge chunks matched by vector";
      response.matches = rows
        .sort((a, b) => a.distance - b.distance)
        .map(({ distance: _distance, ...match }) => match);
    } catch (error) {
      const message = "Unknown error in searching knowledge chunks by vector";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SearchKnowledgeChunksByVector,
        message,
        error,
        metadata: KnowledgeChunksDAL.searchMetadata(params),
      });
      response.message = message;
    }

    return response;
  }

  async searchKnowledgeChunksByKeyword(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SearchKnowledgeChunksByKeywordDALRequest,
  ) {
    const response: Schemas.KnowledgeChunkMatchesDALResponse = { isSuccess: false };

    if (params.knowledgeSourceIds.length === 0) {
      return KnowledgeChunksDAL.noSourcesToSearch(response);
    }

    try {
      // DEV_NOTE: websearch_to_tsquery never fails on user text (quotes, "or", "-" are read as web search syntax); a
      // query of stop words only matches nothing. The same 'english' config as the generated tsv column.
      const tsquery = sql`websearch_to_tsquery('english', ${params.query})`;
      const rank = sql<number>`ts_rank_cd(${knowledgeChunks.tsv}, ${tsquery})`.mapWith(Number);
      const conditions = [
        ...KnowledgeChunksDAL.searchConditions(params),
        sql`${knowledgeChunks.tsv} @@ ${tsquery}`,
      ];
      const rows = await tx
        .select(KnowledgeChunksDAL.matchColumns)
        .from(knowledgeChunks)
        .innerJoin(
          knowledgeDocuments,
          eq(knowledgeDocuments.id, knowledgeChunks.knowledgeDocumentId),
        )
        .where(and(...conditions))
        // DEV_NOTE: id breaks rank ties, so the same query always ranks the same way
        .orderBy(desc(rank), asc(knowledgeChunks.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Knowledge chunks matched by keyword";
      response.matches = rows;
    } catch (error) {
      const message = "Unknown error in searching knowledge chunks by keyword";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SearchKnowledgeChunksByKeyword,
        message,
        error,
        metadata: KnowledgeChunksDAL.searchMetadata(params),
      });
      response.message = message;
    }

    return response;
  }

  async deleteKnowledgeChunksByDocuments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteKnowledgeChunksByDocumentsDALRequest,
  ) {
    const response: Schemas.KnowledgeChunksWriteDALResponse = { isSuccess: false };

    if (params.knowledgeDocumentIds.length === 0) {
      response.isSuccess = true;
      response.message = "No knowledge chunks to delete";
      response.rowCount = 0;
      return response;
    }

    try {
      const conditions = [
        inArray(knowledgeChunks.knowledgeDocumentId, params.knowledgeDocumentIds),
        eq(knowledgeChunks.companyId, params.companyId),
      ];
      const deleted = await tx.delete(knowledgeChunks).where(and(...conditions));

      response.isSuccess = true;
      response.message = "Knowledge chunks deleted successfully";
      response.rowCount = deleted.rowCount ?? 0;
    } catch (error) {
      const message = "Unknown error in deleting knowledge chunks";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteKnowledgeChunks,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteKnowledgeChunksBySource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteKnowledgeChunksBySourceDALRequest,
  ) {
    const response: Schemas.KnowledgeChunksWriteDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeChunks.knowledgeSourceId, params.knowledgeSourceId),
        eq(knowledgeChunks.companyId, params.companyId),
      ];
      const deleted = await tx.delete(knowledgeChunks).where(and(...conditions));

      response.isSuccess = true;
      response.message = "Knowledge chunks deleted successfully";
      response.rowCount = deleted.rowCount ?? 0;
    } catch (error) {
      const message = "Unknown error in deleting knowledge chunks by source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteKnowledgeChunks,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: What both search sides return: the chunk and its document's citation fields
  private static readonly matchColumns = {
    chunkId: knowledgeChunks.id,
    documentPublicId: knowledgeDocuments.publicId,
    title: knowledgeDocuments.title,
    sourceUrl: knowledgeDocuments.sourceUrl,
    headingPath: knowledgeChunks.headingPath,
    text: knowledgeChunks.text,
  };

  // DEV_NOTE: The filters both search sides share (pattern rule 3.26), in one place so they can't drift apart: the
  // company on both tables, the given sources, the embedding model, and Indexed documents only
  private static searchConditions(params: {
    companyId: string;
    knowledgeSourceIds: string[];
    embeddingModel: string;
  }): SQL[] {
    return [
      eq(knowledgeChunks.companyId, params.companyId),
      inArray(knowledgeChunks.knowledgeSourceId, params.knowledgeSourceIds),
      eq(knowledgeChunks.embeddingModel, params.embeddingModel),
      eq(knowledgeDocuments.companyId, params.companyId),
      eq(knowledgeDocuments.indexStatus, Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed),
    ];
  }

  private static searchMetadata(params: {
    companyId: string;
    knowledgeSourceIds: string[];
    limit: number;
  }) {
    return {
      companyId: params.companyId,
      sourceCount: params.knowledgeSourceIds.length,
      limit: params.limit,
    };
  }

  private static noSourcesToSearch(
    response: Schemas.KnowledgeChunkMatchesDALResponse,
  ): Schemas.KnowledgeChunkMatchesDALResponse {
    response.isSuccess = true;
    response.message = "No knowledge sources to search";
    response.matches = [];
    return response;
  }
}
