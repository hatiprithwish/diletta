import { and, asc, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, knowledgeSources } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). getDueKnowledgeSources is the re-sync Cron's
// cross-company read and takes the tx from withPlatform.
export default class KnowledgeSourcesDAL {
  async createKnowledgeSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateKnowledgeSourceDALRequest,
  ) {
    const response: Schemas.KnowledgeSourceDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateKnowledgeSource,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [knowledgeSourceResponse] = await tx
        .insert(knowledgeSources)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          type: params.type,
          url: params.url,
          syncFrequency: params.syncFrequency,
          createdBy: params.createdBy,
          updatedBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Knowledge source created successfully";
      response.knowledgeSource = knowledgeSourceResponse;
    } catch (error) {
      const message = "Unknown error in creating knowledge source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateKnowledgeSource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeSourceDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindKnowledgeSourceDALRequest,
  ) {
    const response: Schemas.KnowledgeSourceDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeSources.publicId, params.publicId),
        eq(knowledgeSources.companyId, params.companyId),
      ];
      const query = tx
        .select()
        .from(knowledgeSources)
        .where(and(...conditions))
        .limit(1);
      const [knowledgeSource] = params.isForUpdate ? await query.for("update") : await query;

      if (!knowledgeSource) {
        const message = "Knowledge source not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetKnowledgeSourceDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge source fetched successfully";
      response.knowledgeSource = knowledgeSource;
    } catch (error) {
      const message = "Unknown error in fetching knowledge source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetKnowledgeSourceDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeSources(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeSourcesDALRequest,
  ) {
    const response: Schemas.KnowledgeSourcesDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.KnowledgeSourceSortColumn.CreatedAt]: knowledgeSources.createdAt,
        [Schemas.KnowledgeSourceSortColumn.LastSyncedAt]: knowledgeSources.lastSyncedAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const knowledgeSourcesResponse = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.companyId, params.companyId))
        // DEV_NOTE: id breaks ties (same created_at, never-synced sources), so rows never repeat or go missing
        // between pages
        .orderBy(orderExpr, asc(knowledgeSources.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Knowledge sources fetched successfully";
      response.knowledgeSources = knowledgeSourcesResponse;
    } catch (error) {
      const message = "Unknown error in listing knowledge sources";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListKnowledgeSources,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getKnowledgeSourcesCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetKnowledgeSourcesCountDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const [result] = await tx
        .select({ count: count() })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Knowledge sources counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting knowledge sources";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountKnowledgeSources,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateKnowledgeSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateKnowledgeSourceDALRequest,
  ) {
    const response: Schemas.KnowledgeSourceDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeSources.publicId, params.publicId),
        eq(knowledgeSources.companyId, params.companyId),
      ];
      const [knowledgeSourceResponse] = await tx
        .update(knowledgeSources)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          syncFrequency: params.syncFrequency ?? undefined,
          status: params.status ?? undefined,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!knowledgeSourceResponse) {
        const message = "Knowledge source not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateKnowledgeSource,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge source updated successfully";
      response.knowledgeSource = knowledgeSourceResponse;
    } catch (error) {
      const message = "Unknown error in updating knowledge source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateKnowledgeSource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The sync's own state change. The Repo reads the row FOR UPDATE first and decides; this only writes.
  async setKnowledgeSourceSyncState(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetKnowledgeSourceSyncStateDALRequest,
  ) {
    const response: Schemas.KnowledgeSourceDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeSources.publicId, params.publicId),
        eq(knowledgeSources.companyId, params.companyId),
      ];
      const [knowledgeSourceResponse] = await tx
        .update(knowledgeSources)
        .set({
          status: params.status,
          // DEV_NOTE: When a param is null, it's ignored
          lastSyncedAt: params.lastSyncedAt ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!knowledgeSourceResponse) {
        const message = "Knowledge source not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetKnowledgeSourceSyncState,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge source sync state set successfully";
      response.knowledgeSource = knowledgeSourceResponse;
    } catch (error) {
      const message = "Unknown error in setting knowledge source sync state";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetKnowledgeSourceSyncState,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteKnowledgeSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteKnowledgeSourceDALRequest,
  ) {
    const response: Schemas.KnowledgeSourceDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(knowledgeSources.publicId, params.publicId),
        eq(knowledgeSources.companyId, params.companyId),
      ];
      const [deleted] = await tx
        .delete(knowledgeSources)
        .where(and(...conditions))
        .returning();

      if (!deleted) {
        const message = "Knowledge source not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteKnowledgeSource,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Knowledge source deleted successfully";
      response.knowledgeSource = deleted;
    } catch (error) {
      const message = "Unknown error in deleting knowledge source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteKnowledgeSource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Platform read (withPlatform) for the re-sync Cron: due Active web sources and stale Syncing ones across
  // companies, least recently synced first (never synced = first)
  async getDueKnowledgeSources(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDueKnowledgeSourcesDALRequest,
  ) {
    const response: Schemas.KnowledgeSourcesDALResponse = { isSuccess: false };

    try {
      const isActive = eq(knowledgeSources.status, Schemas.KnowledgeSourceStatusIntEnum.Active);
      const dueConditions = [
        and(
          isActive,
          eq(knowledgeSources.syncFrequency, Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily),
          or(
            isNull(knowledgeSources.lastSyncedAt),
            lt(knowledgeSources.lastSyncedAt, params.dailyBefore),
          ),
        ),
        and(
          isActive,
          eq(knowledgeSources.syncFrequency, Schemas.KnowledgeSourceSyncFrequencyIntEnum.Weekly),
          or(
            isNull(knowledgeSources.lastSyncedAt),
            lt(knowledgeSources.lastSyncedAt, params.weeklyBefore),
          ),
        ),
        and(
          eq(knowledgeSources.status, Schemas.KnowledgeSourceStatusIntEnum.Syncing),
          lt(knowledgeSources.updatedAt, params.staleBefore),
        ),
      ];
      const knowledgeSourcesResponse = await tx
        .select()
        .from(knowledgeSources)
        .where(or(...dueConditions))
        .orderBy(sql`${knowledgeSources.lastSyncedAt} asc nulls first`, asc(knowledgeSources.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Due knowledge sources fetched successfully";
      response.knowledgeSources = knowledgeSourcesResponse;
    } catch (error) {
      const message = "Unknown error in fetching due knowledge sources";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDueKnowledgeSources,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
