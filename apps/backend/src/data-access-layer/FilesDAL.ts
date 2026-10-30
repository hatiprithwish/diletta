import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, evalResults, files } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL for the files registry (every R2 object). Holds no db client: every method takes the tx opened
// by withTenant in the Repo and filters on companyId. Rows only: the R2 object is written and deleted by
// FileStorageProvider, keyed by Schemas.fileR2Key. A file's bytes never change: new bytes are a new file.
export default class FilesDAL {
  async createFile(tx: NodePgTransaction<EmptyRelations>, params: Schemas.CreateFileDALRequest) {
    const response: Schemas.FileDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the company before writing. The owner is checked by the owner's
      // own DAL (a file may be created just before its owner row, then pointed at it with setFileOwner).
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateFile,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [fileResponse] = await tx
        .insert(files)
        .values({
          publicId: params.publicId,
          companyId: params.companyId,
          ownerType: params.ownerType,
          ownerId: params.ownerId,
          filename: params.filename,
          mime: params.mime,
          sizeBytes: params.sizeBytes,
          sha256: params.sha256,
          createdBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "File created successfully";
      response.file = fileResponse;
    } catch (error) {
      const message = "Unknown error in creating file";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateFile,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async setFileOwner(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetFileOwnerDALRequest,
  ) {
    const response: Schemas.FileDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(files.id, params.id), eq(files.companyId, params.companyId)];
      const [fileResponse] = await tx
        .update(files)
        .set({ ownerType: params.ownerType, ownerId: params.ownerId, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!fileResponse) {
        const message = "File not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetFileOwner,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "File owner set successfully";
      response.file = fileResponse;
    } catch (error) {
      const message = "Unknown error in setting file owner";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetFileOwner,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getFile(tx: NodePgTransaction<EmptyRelations>, params: Schemas.FindFileDALRequest) {
    const response: Schemas.FileDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(files.id, params.id), eq(files.companyId, params.companyId)];
      const [file] = await tx
        .select()
        .from(files)
        .where(and(...conditions))
        .limit(1);

      if (!file) {
        const message = "File not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetFile,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "File fetched successfully";
      response.file = file;
    } catch (error) {
      const message = "Unknown error in fetching file";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFile,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: An eval transcript (Tests page, M4-8) by its file's public id, only when it is the transcript of a result
  // of this run: owner eval_result, and that result points back at the file. With the company's public id, the other half
  // of its R2 key. isNotFound for any other file.
  async getEvalRunTranscriptFile(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindEvalRunTranscriptFileDALRequest,
  ) {
    const response: Schemas.FileWithCompanyDALResponse = { isSuccess: false };

    try {
      const resultJoinConditions = [
        eq(evalResults.id, files.ownerId),
        eq(evalResults.companyId, files.companyId),
        eq(evalResults.transcriptFileId, files.id),
      ];
      const companyJoinConditions = [eq(companies.id, files.companyId)];
      const conditions = [
        eq(files.publicId, params.publicId),
        eq(files.companyId, params.companyId),
        eq(files.ownerType, Schemas.FileOwnerTypeEnum.EvalResult),
        eq(evalResults.evalRunId, params.evalRunId),
      ];
      const [selected] = await tx
        .select({ file: files, companyPublicId: companies.publicId })
        .from(files)
        .innerJoin(evalResults, and(...resultJoinConditions))
        .innerJoin(companies, and(...companyJoinConditions))
        .where(and(...conditions))
        .limit(1);

      if (!selected) {
        const message = "Transcript file not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetEvalRunTranscriptFile,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Transcript file fetched successfully";
      response.file = selected.file;
      response.companyPublicId = selected.companyPublicId;
    } catch (error) {
      const message = "Unknown error in fetching transcript file";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEvalRunTranscriptFile,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Platform (withPlatform): rows of one owner type still pending their owner and older than createdBefore,
  // oldest first, with the company's public id for the R2 key (the eval transcript sweep, M5-3)
  async getPendingOwnerFiles(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetPendingOwnerFilesDALRequest,
  ) {
    const response: Schemas.PendingOwnerFilesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(files.ownerType, params.ownerType),
        eq(files.ownerId, Schemas.FILE_PENDING_OWNER_ID),
        lt(files.createdAt, params.createdBefore),
      ];
      const selected = await tx
        .select({
          id: files.id,
          companyId: files.companyId,
          publicId: files.publicId,
          companyPublicId: companies.publicId,
        })
        .from(files)
        .innerJoin(companies, eq(companies.id, files.companyId))
        .where(and(...conditions))
        .orderBy(asc(files.createdAt), asc(files.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Pending files fetched successfully";
      response.files = selected;
    } catch (error) {
      const message = "Unknown error in fetching pending files";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPendingOwnerFiles,
        message,
        error,
        metadata: { ownerType: params.ownerType, limit: params.limit },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Returns the deleted rows, so the Repo can delete their R2 objects after the transaction commits.
  // pendingOwnerType: only rows of that owner type still pending their owner are deleted (one attached meanwhile stays)
  async deleteFiles(tx: NodePgTransaction<EmptyRelations>, params: Schemas.DeleteFilesDALRequest) {
    const response: Schemas.FilesDALResponse = { isSuccess: false };

    if (params.ids.length === 0) {
      response.isSuccess = true;
      response.message = "No files to delete";
      response.files = [];
      return response;
    }

    try {
      const conditions = [inArray(files.id, params.ids), eq(files.companyId, params.companyId)];
      if (params.pendingOwnerType) {
        conditions.push(eq(files.ownerType, params.pendingOwnerType));
        conditions.push(eq(files.ownerId, Schemas.FILE_PENDING_OWNER_ID));
      }
      const deleted = await tx
        .delete(files)
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Files deleted successfully";
      response.files = deleted;
    } catch (error) {
      const message = "Unknown error in deleting files";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteFiles,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
