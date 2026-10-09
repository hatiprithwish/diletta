import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  notLike,
  or,
} from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { files, knowledgeDocuments, knowledgeSources } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). Documents are written by the sync (KnowledgeIngestionRepo)
// and by uploads (KnowledgeSourcesRepo); their chunks and file rows go with them.
export default class KnowledgeDocumentsDAL {
  async createKnowledgeDocument(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateKnowledgeDocumentDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the source and the file (same company) before writing
      const sourceConditions = [
        eq(knowledgeSources.id, params.knowledgeSourceId),
        eq(knowledgeSources.companyId, params.companyId),
      ];
      const [source] = await tx
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(and(...sourceConditions))
        .limit(1);
      const fileConditions = [eq(files.id, params.fileId), eq(files.companyId, params.companyId)];
      const [file] = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(...fileConditions))
        .limit(1);

      const notFound = !source ? "Knowledge source not found" : !file ? "File not found" : null;
      if (notFound) {
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateKnowledgeDocument,
          message: notFound,
          metadata: params,
        });
        response.message = notFound;
        return response;
      }

      const [knowledgeDocumentResponse] = await tx
        .insert(knowledgeDocuments)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          knowledgeSourceId: params.knowledgeSourceId,
          fileId: params.fileId,
          title: params.title,
          sourceUrl: params.sourceUrl,
          contentHash: params.contentHash,
          indexStatus: params.indexStatus,
          lastSyncedAt: params.lastSyncedAt,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Knowledge document created successfully";
      response.knowledgeDocument = knowledgeDocumentResponse;
    } catch (error) {
      const message = "Unknown error in creating knowledge document";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateKnowledgeDocument,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeDocumentDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindKnowledgeDocumentDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.publicId, params.publicId),
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];
      const [knowledgeDocument] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .limit(1);

      if (!knowledgeDocument) {
        const message = "Knowledge document not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetKnowledgeDocumentDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge document fetched successfully";
      response.knowledgeDocument = knowledgeDocument;
    } catch (error) {
      const message = "Unknown error in fetching knowledge document";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetKnowledgeDocumentDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A page not seen before is the normal case on a first sync, so not-found is not logged
  async getKnowledgeDocumentBySourceUrl(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindKnowledgeDocumentBySourceUrlDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
        eq(knowledgeDocuments.sourceUrl, params.sourceUrl),
      ];
      const [knowledgeDocument] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .orderBy(asc(knowledgeDocuments.id))
        .limit(1);

      if (!knowledgeDocument) {
        response.message = "Knowledge document not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge document fetched successfully";
      response.knowledgeDocument = knowledgeDocument;
    } catch (error) {
      const message = "Unknown error in fetching knowledge document by source URL";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetKnowledgeDocumentBySourceUrl,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateKnowledgeDocument(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateKnowledgeDocumentDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.id, params.id),
        eq(knowledgeDocuments.companyId, params.companyId),
      ];
      const [knowledgeDocumentResponse] = await tx
        .update(knowledgeDocuments)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          title: params.title ?? undefined,
          contentHash: params.contentHash ?? undefined,
          indexStatus: params.indexStatus ?? undefined,
          lastSyncedAt: params.lastSyncedAt ?? undefined,
          fileId: params.fileId ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!knowledgeDocumentResponse) {
        const message = "Knowledge document not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateKnowledgeDocument,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge document updated successfully";
      response.knowledgeDocument = knowledgeDocumentResponse;
    } catch (error) {
      const message = "Unknown error in updating knowledge document";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateKnowledgeDocument,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeDocuments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeDocumentsDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.KnowledgeDocumentSortColumn.CreatedAt]: knowledgeDocuments.createdAt,
        [Schemas.KnowledgeDocumentSortColumn.Title]: knowledgeDocuments.title,
        [Schemas.KnowledgeDocumentSortColumn.LastSyncedAt]: knowledgeDocuments.lastSyncedAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];

      const knowledgeDocumentsResponse = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (same created_at or title), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(knowledgeDocuments.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Knowledge documents fetched successfully";
      response.knowledgeDocuments = knowledgeDocumentsResponse;
    } catch (error) {
      const message = "Unknown error in listing knowledge documents";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListKnowledgeDocuments,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeDocumentsCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeDocumentsCountDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];
      const [result] = await tx
        .select({ count: count() })
        .from(knowledgeDocuments)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Knowledge documents counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting knowledge documents";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountKnowledgeDocuments,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeDocumentsBySource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeDocumentsBySourceDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];
      if (params.indexStatuses) {
        conditions.push(inArray(knowledgeDocuments.indexStatus, params.indexStatuses));
      }
      const knowledgeDocumentsResponse = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .orderBy(asc(knowledgeDocuments.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Knowledge documents fetched successfully";
      response.knowledgeDocuments = knowledgeDocumentsResponse;
    } catch (error) {
      const message = "Unknown error in fetching knowledge documents by source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetKnowledgeDocumentsBySource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeDocumentsToIndex(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeDocumentsToIndexDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    try {
      const hasWork = [
        inArray(knowledgeDocuments.indexStatus, [
          Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
          Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed,
        ]),
        isNull(knowledgeDocuments.contentHash),
        notLike(knowledgeDocuments.contentHash, `${params.contentHashPrefix}%`),
      ];
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
        or(...hasWork),
      ];
      const knowledgeDocumentsResponse = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .orderBy(asc(knowledgeDocuments.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Knowledge documents to index fetched successfully";
      response.knowledgeDocuments = knowledgeDocumentsResponse;
    } catch (error) {
      const message = "Unknown error in fetching knowledge documents to index";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetKnowledgeDocumentsBySource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getUnlistedKnowledgeDocuments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetUnlistedKnowledgeDocumentsDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
        isNotNull(knowledgeDocuments.sourceUrl),
      ];
      if (params.listedSourceUrls.length > 0) {
        conditions.push(notInArray(knowledgeDocuments.sourceUrl, params.listedSourceUrls));
      }
      const knowledgeDocumentsResponse = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Unlisted knowledge documents fetched successfully";
      response.knowledgeDocuments = knowledgeDocumentsResponse;
    } catch (error) {
      const message = "Unknown error in fetching unlisted knowledge documents";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetUnlistedKnowledgeDocuments,
        message,
        error,
        metadata: { ...params, listedSourceUrls: params.listedSourceUrls.length },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Returns the deleted rows, so the Repo can delete their file rows and R2 objects
  async deleteKnowledgeDocuments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteKnowledgeDocumentsDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    if (params.ids.length === 0) {
      response.isSuccess = true;
      response.message = "No knowledge documents to delete";
      response.knowledgeDocuments = [];
      return response;
    }

    try {
      const conditions = [
        inArray(knowledgeDocuments.id, params.ids),
        eq(knowledgeDocuments.companyId, params.companyId),
      ];
      const deleted = await tx
        .delete(knowledgeDocuments)
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Knowledge documents deleted successfully";
      response.knowledgeDocuments = deleted;
    } catch (error) {
      const message = "Unknown error in deleting knowledge documents";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteKnowledgeDocuments,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteKnowledgeDocumentsBySource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteKnowledgeDocumentsBySourceDALRequest,
  ) {
    const response: Schemas.KnowledgeDocumentsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeDocuments.companyId, params.companyId),
        eq(knowledgeDocuments.knowledgeSourceId, params.knowledgeSourceId),
      ];
      const deleted = await tx
        .delete(knowledgeDocuments)
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Knowledge documents deleted successfully";
      response.knowledgeDocuments = deleted;
    } catch (error) {
      const message = "Unknown error in deleting knowledge documents by source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteKnowledgeDocumentsBySource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
