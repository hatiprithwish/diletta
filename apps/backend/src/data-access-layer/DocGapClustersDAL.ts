import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  chatbots,
  docGapClusters,
  docGaps,
  knowledgeDocuments,
  knowledgeSources,
} from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: A group's columns but the centroid, which only the clustering (M5-6) reads
const CLUSTER_COLUMNS = {
  id: docGapClusters.id,
  publicId: docGapClusters.publicId,
  companyId: docGapClusters.companyId,
  chatbotId: docGapClusters.chatbotId,
  label: docGapClusters.label,
  questionCount: docGapClusters.questionCount,
  status: docGapClusters.status,
  answeredByDocumentId: docGapClusters.answeredByDocumentId,
  createdAt: docGapClusters.createdAt,
  updatedAt: docGapClusters.updatedAt,
};

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). The groups of questions the assistant couldn't answer
// as the Knowledge page reads and closes them (M4-7), and as the clustering finds, creates and grows them (M5-6). Question text
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
    const chatbotJoinConditions = [
      eq(chatbots.id, docGapClusters.chatbotId),
      eq(chatbots.companyId, docGapClusters.companyId),
    ];
    return tx
      .select({
        id: docGapClusters.id,
        publicId: docGapClusters.publicId,
        chatbotName: chatbots.name,
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
      .leftJoin(chatbots, and(...chatbotJoinConditions))
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
          chatbotCount: sql<number>`(
            select count(*) from ${chatbots} where ${chatbots.companyId} = ${params.companyId}
          )`.mapWith(Number),
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
      response.chatbotCount = result?.chatbotCount ?? 0;
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

  // DEV_NOTE: Open → Answered by the document. The Repo has found the document in the company and locked it (no DB
  // foreign keys), so this only writes. isNotFound when no Open group has that id (the Repo reads it under lock first,
  // so that means it closed meanwhile).
  async answerDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.AnswerDocGapClusterDALRequest,
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
      response.reopenedIds = [];
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
      response.reopenedIds = reopened.map((row) => row.id);
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

  // DEV_NOTE: One clustering at a time per chatbot (until the commit), so two questions arriving together can't each
  // start the same group or both cross the Quality floor
  async lockDocGapClustering(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockDocGapClusteringDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `doc_gap_clustering:${params.companyId}:${params.chatbotId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Doc gap clustering locked successfully";
    } catch (error) {
      const message = "Unknown error in locking doc gap clustering";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockDocGapClustering,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The chatbot's closest group a question may join: Open or Dismissed, never Answered. Locked, so an admin
  // closing it waits for this write and the Quality check reads its real status. A chatbot holds few groups, so this
  // sorts them rather than keep an index on centroids. isSuccess with no group = none yet.
  async findNearestDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindNearestDocGapClusterDALRequest,
  ) {
    const response: Schemas.NearestDocGapClusterDALResponse = { isSuccess: false };
    const { embedding: _embedding, ...metadata } = params;

    try {
      const distance = sql<number>`${docGapClusters.centroid} <=> ${JSON.stringify(params.embedding)}::halfvec`;
      const conditions = [
        eq(docGapClusters.companyId, params.companyId),
        eq(docGapClusters.chatbotId, params.chatbotId),
        inArray(docGapClusters.status, [
          Schemas.DocGapClusterStatusIntEnum.Open,
          Schemas.DocGapClusterStatusIntEnum.Dismissed,
        ]),
      ];
      const [nearest] = await tx
        .select({
          ...CLUSTER_COLUMNS,
          centroid: docGapClusters.centroid,
          similarity: sql<number>`1 - (${distance})`.mapWith(Number),
        })
        .from(docGapClusters)
        .where(and(...conditions))
        .orderBy(asc(distance), asc(docGapClusters.id))
        .limit(1)
        .for("update");

      response.isSuccess = true;
      response.message = nearest ? "Nearest doc gap cluster found" : "No doc gap cluster to join";
      response.docGapCluster = nearest;
    } catch (error) {
      const message = "Unknown error in finding nearest doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.FindNearestDocGapCluster,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A new Open group from its first question (its label and centroid). The Repo holds the chatbot's clustering
  // lock; a removed chatbot is checked here (no DB foreign keys), isNotFound.
  async createDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateDocGapClusterDALRequest,
  ) {
    const response: Schemas.DocGapClusterDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, chatbotId: params.chatbotId };

    try {
      const chatbotConditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...chatbotConditions))
        .limit(1);
      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateDocGapCluster,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const [created] = await tx
        .insert(docGapClusters)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          label: params.label,
          centroid: params.centroid,
          questionCount: 1,
        })
        .returning(CLUSTER_COLUMNS);

      response.isSuccess = true;
      response.message = "Doc gap cluster created successfully";
      response.docGapCluster = created;
    } catch (error) {
      const message = "Unknown error in creating doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateDocGapCluster,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async growDocGapCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GrowDocGapClusterDALRequest,
  ) {
    const response: Schemas.DocGapClusterDALResponse = { isSuccess: false };
    const { centroid: _centroid, ...metadata } = params;

    try {
      const conditions = [
        eq(docGapClusters.id, params.id),
        eq(docGapClusters.companyId, params.companyId),
      ];
      const [updated] = await tx
        .update(docGapClusters)
        .set({
          centroid: params.centroid,
          questionCount: params.questionCount,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning(CLUSTER_COLUMNS);

      if (!updated) {
        const message = "Doc gap cluster not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GrowDocGapCluster,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Doc gap cluster grown successfully";
      response.docGapCluster = updated;
    } catch (error) {
      const message = "Unknown error in growing doc gap cluster";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GrowDocGapCluster,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}
