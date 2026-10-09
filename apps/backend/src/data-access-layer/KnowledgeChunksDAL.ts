import { and, eq, inArray } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { knowledgeChunks, knowledgeDocuments } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). knowledge_chunks is derived: a changed document's
// chunks are deleted and written again in one transaction, never updated in place.
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
}
