import { and, eq, inArray } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, files } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL for the files registry (every R2 object). Holds no db client: every method takes the tx opened
// by withTenant in the Repo and filters on companyId. Rows only: the R2 object is written and deleted by
// FileStorageProvider, keyed by Schemas.fileR2Key.
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
          publicId: Utility.generatePublicId(),
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

  async updateFileContent(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateFileContentDALRequest,
  ) {
    const response: Schemas.FileDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(files.id, params.id), eq(files.companyId, params.companyId)];
      const [fileResponse] = await tx
        .update(files)
        .set({
          mime: params.mime,
          sizeBytes: params.sizeBytes,
          sha256: params.sha256,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!fileResponse) {
        const message = "File not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateFileContent,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "File content updated successfully";
      response.file = fileResponse;
    } catch (error) {
      const message = "Unknown error in updating file content";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateFileContent,
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

  async getFiles(tx: NodePgTransaction<EmptyRelations>, params: Schemas.FindFilesDALRequest) {
    const response: Schemas.FilesDALResponse = { isSuccess: false };

    if (params.ids.length === 0) {
      response.isSuccess = true;
      response.message = "No files to fetch";
      response.files = [];
      return response;
    }

    try {
      const conditions = [inArray(files.id, params.ids), eq(files.companyId, params.companyId)];
      const filesResponse = await tx
        .select()
        .from(files)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Files fetched successfully";
      response.files = filesResponse;
    } catch (error) {
      const message = "Unknown error in fetching files";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFiles,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Returns the deleted rows, so the Repo can delete their R2 objects after the transaction commits
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
