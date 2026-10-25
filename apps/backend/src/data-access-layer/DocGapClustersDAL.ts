import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { docGapClusters, docGaps, knowledgeDocuments, knowledgeSources } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: A group's columns but the centroid, which only the clustering (M5-6) reads
const CLUSTER_COLUMNS = {
  id: docGapClusters.id,
  publicId: docGapClusters.publicId,
  companyId: docGapClusters.companyId,
  label: docGapClusters.label,
  questionCount: docGapClusters.questionCount,
  status: docGapClusters.status,
  answeredByDocumentId: docGapClusters.answeredByDocumentId,
  createdAt: docGapClusters.createdAt,
  updatedAt: docGapClusters.updatedAt,
};

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). The groups of questions the assistant couldn't answer
// as the Knowledge page reads and closes them (M4-7); the clustering that writes them is M5-6. Question text
// (question_generic, already rewritten without personal details) is never logged.
export default class DocGapClustersDAL {
  // DEV_NOTE: A group with its answering document and that document's source (left joins: no DB foreign keys), and the
  // time of its newest question (a correlated read on IDX_doc_gaps_cluster_id)
  private rowQuery(tx: NodePgTransaction<EmptyRelations>) {
    const documentJoinConditions = [
      eq(knowledgeDocuments.id, docGapClusters.answeredByDocumentId),
      eq(knowledgeDocuments.companyId, docGapClusters.companyId),
    ];
    const sourceJoinConditions = [
      eq(knowledgeSources.id, knowledgeDocuments.knowledgeSourceId),
      eq(knowledgeSources.companyId, knowledgeDocuments.companyId),
    ];
    return tx
      .select({
        id: docGapClusters.id,
        publicId: docGapClusters.publicId,
        label: docGapClusters.label,
        questionCount: docGapClusters.questionCount,
        status: docGapClusters.status,
        createdAt: docGapClusters.createdAt,
        updatedAt: docGapClusters.updatedAt,
        latestQuestionAt: sql<Date | null>`(
          select max(${docGaps.createdAt}) from ${docGaps}
          where ${docGaps.clusterId} = ${docGapClusters.id} and ${docGaps.companyId} = ${docGapClusters.companyId}
        )`.mapWith(docGaps.createdAt),
        documentPublicId: knowledgeDocuments.publicId,
        documentTitle: knowledgeDocuments.title,
        documentSourceUrl: knowledgeDocuments.sourceUrl,
        sourcePublicId: knowledgeSources.publicId,
        sourceName: knowledgeSources.name,
      })
      .from(docGapClusters)
      .leftJoin(knowledgeDocuments, and(...documentJoinConditions))
      .leftJoin(knowledgeSources, and(...sourceJoinConditions));
  }

  async getDocGapClusters(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDocGapClustersDALRequest,
  ) {
    const response: Schemas.DocGapClusterRowsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.DocGapClusterSortColumn.QuestionCount]: docGapClusters.questionCount,
        [Schemas.DocGapClusterSortColumn.CreatedAt]: docGapClusters.createdAt,
        [Schemas.DocGapClusterSortColumn.UpdatedAt]: docGapClusters.updatedAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;
      const conditions = [
        eq(docGapClusters.companyId, params.companyId),
        eq(docGapClusters.status, Schemas.DOC_GAP_CLUSTER_TAB_STATUS[params.tab]),
      ];

      const selected = await this.rowQuery(tx)
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (same question count), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(docGapClusters.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Doc gap clusters fetched successfully";
      response.docGapClusters = selected;
    } catch (error) {
      const message = "Unknown error in listing doc gap clusters";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDocGapClusters,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every tab's count in one read; totalRecords = all of them
  async getDocGapClustersCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountDocGapClustersDALRequest,
  ) {
    const response: Schemas.DocGapClusterTabCountsDALResponse = { isSuccess: false };

    try {
      const { Open, Answered, Dismissed } = Schemas.DocGapClusterListTabEnum;
      const countOf = (tab: Schemas.DocGapClusterListTabEnum) =>
        sql<number>`count(*) filter (where ${docGapClusters.status} = ${Schemas.DOC_GAP_CLUSTER_TAB_STATUS[tab]})`.mapWith(
          Number,
        );
      const [result] = await tx
        .select({
          all: count(),
          open: countOf(Open),
          answered: countOf(Answered),
          dismissed: countOf(Dismissed),
        })
        .from(docGapClusters)
        .where(eq(docGapClusters.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Doc gap clusters counted successfully";
      response.totalRecords = result?.all ?? 0;
      response.tabCounts = {
        [Open]: result?.open ?? 0,
        [Answered]: result?.answered ?? 0,
        [Dismissed]: result?.dismissed ?? 0,
      };
    } catch (error) {
      const message = "Unknown error in counting doc gap clusters";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDocGapClusters,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One group by its public id within the company. isForUpdate locks the group only: Postgres refuses to lock
  // the nullable side of an outer join.
  async getDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindDocGapClusterDALRequest,
  ) {
    const response: Schemas.DocGapClusterRowDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(docGapClusters.publicId, params.publicId),
        eq(docGapClusters.companyId, params.companyId),
      ];
      const query = this.rowQuery(tx)
        .where(and(...conditions))
        .limit(1);
      const [selected] = params.isForUpdate
        ? await query.for("update", { of: docGapClusters })
        : await query;

      if (!selected) {
        const message = "Doc gap cluster not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDocGapCluster,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Doc gap cluster fetched successfully";
      response.docGapCluster = selected;
    } catch (error) {
      const message = "Unknown error in fetching doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDocGapCluster,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The newest perCluster questions of each group, in one read (ranked per group, newest first)
  async getDocGapSampleQuestions(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDocGapSampleQuestionsDALRequest,
  ) {
    const response: Schemas.DocGapSampleQuestionsDALResponse = { isSuccess: false };

    if (params.clusterIds.length === 0) {
      response.isSuccess = true;
      response.message = "No doc gap clusters to read questions for";
      response.sampleQuestions = {};
      return response;
    }

    try {
      const conditions = [
        eq(docGaps.companyId, params.companyId),
        inArray(docGaps.clusterId, params.clusterIds),
      ];
      const ranked = tx
        .select({
          clusterId: docGaps.clusterId,
          questionGeneric: docGaps.questionGeneric,
          rank: sql<number>`row_number() over (partition by ${docGaps.clusterId} order by ${docGaps.createdAt} desc, ${docGaps.id} desc)`
            .mapWith(Number)
            .as("rank"),
        })
        .from(docGaps)
        .where(and(...conditions))
        .as("ranked");
      const rows = await tx
        .select({
          clusterId: ranked.clusterId,
          questionGeneric: ranked.questionGeneric,
        })
        .from(ranked)
        .where(lte(ranked.rank, params.perCluster))
        .orderBy(asc(ranked.clusterId), asc(ranked.rank));

      const sampleQuestions: Record<string, string[]> = {};
      for (const row of rows) {
        if (row.clusterId === null) continue;
        (sampleQuestions[row.clusterId] ??= []).push(row.questionGeneric);
      }

      response.isSuccess = true;
      response.message = "Doc gap sample questions fetched successfully";
      response.sampleQuestions = sampleQuestions;
    } catch (error) {
      const message = "Unknown error in fetching doc gap sample questions";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDocGapSampleQuestions,
        message,
        error,
        metadata: { companyId: params.companyId, clusterCount: params.clusterIds.length },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Open → Answered by the document. isNotFound when the document isn't in the company (checked here: no DB
  // foreign keys) or no Open group has that id (the Repo reads it under lock first, so that means it closed meanwhile).
  async answerDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.AnswerDocGapClusterDALRequest,
  ) {
    const response: Schemas.DocGapClusterDALResponse = { isSuccess: false };

    try {
      const documentConditions = [
        eq(knowledgeDocuments.id, params.answeredByDocumentId),
        eq(knowledgeDocuments.companyId, params.companyId),
      ];
      const [document] = await tx
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(and(...documentConditions))
        .limit(1);
      if (!document) {
        const message = "Knowledge document not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.AnswerDocGapCluster,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const conditions = [
        eq(docGapClusters.id, params.id),
        eq(docGapClusters.companyId, params.companyId),
        eq(docGapClusters.status, Schemas.DocGapClusterStatusIntEnum.Open),
      ];
      const [updated] = await tx
        .update(docGapClusters)
        .set({
          status: Schemas.DocGapClusterStatusIntEnum.Answered,
          answeredByDocumentId: params.answeredByDocumentId,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning(CLUSTER_COLUMNS);

      if (!updated) {
        const message = "Open doc gap cluster not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.AnswerDocGapCluster,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Doc gap cluster answered successfully";
      response.docGapCluster = updated;
    } catch (error) {
      const message = "Unknown error in answering doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.AnswerDocGapCluster,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Open → Dismissed. isNotFound when no Open group has that id.
  async dismissDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DismissDocGapClusterDALRequest,
  ) {
    const response: Schemas.DocGapClusterDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(docGapClusters.id, params.id),
        eq(docGapClusters.companyId, params.companyId),
        eq(docGapClusters.status, Schemas.DocGapClusterStatusIntEnum.Open),
      ];
      const [updated] = await tx
        .update(docGapClusters)
        .set({ status: Schemas.DocGapClusterStatusIntEnum.Dismissed, updatedAt: new Date() })
        .where(and(...conditions))
        .returning(CLUSTER_COLUMNS);

      if (!updated) {
        const message = "Open doc gap cluster not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DismissDocGapCluster,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Doc gap cluster dismissed successfully";
      response.docGapCluster = updated;
    } catch (error) {
      const message = "Unknown error in dismissing doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DismissDocGapCluster,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The groups these documents answered back to Open with no document (the documents are being removed, so
  // nothing answers them any more)
  async reopenDocGapClustersByDocuments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ReopenDocGapClustersDALRequest,
  ) {
    const response: Schemas.ReopenDocGapClustersDALResponse = { isSuccess: false };

    if (params.knowledgeDocumentIds.length === 0) {
      response.isSuccess = true;
      response.message = "No documents to reopen doc gap clusters for";
      response.reopenedCount = 0;
      return response;
    }

    try {
      const conditions = [
        eq(docGapClusters.companyId, params.companyId),
        inArray(docGapClusters.answeredByDocumentId, params.knowledgeDocumentIds),
      ];
      const reopened = await tx
        .update(docGapClusters)
        .set({
          status: Schemas.DocGapClusterStatusIntEnum.Open,
          answeredByDocumentId: null,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning({ id: docGapClusters.id });

      response.isSuccess = true;
      response.message = "Doc gap clusters reopened successfully";
      response.reopenedCount = reopened.length;
    } catch (error) {
      const message = "Unknown error in reopening doc gap clusters";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ReopenDocGapClusters,
        message,
        error,
        metadata: {
          companyId: params.companyId,
          documentCount: params.knowledgeDocumentIds.length,
        },
      });
      response.message = message;
    }

    return response;
  }
}
