import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import FilesDAL from "@/data-access-layer/FilesDAL";

// DEV_NOTE: An eval transcript's files row (M5-3), the steps EvalTranscriptsRepo and EvalHarnessRepo run inside their
// own withTenant / withPlatform (provider → DAL: takes the Repo's tx, never opens one or touches R2). The row is
// written first, pending its owner (Schemas.FILE_PENDING_OWNER_ID), in its own transaction, and only then is the R2
// object put; the result's transaction attaches it (owner = the eval_results row). So whatever fails or dies in
// between, a pending row names the object to remove: the Repo discards it when it knows the result wasn't written, and
// the hourly sweep (EvalTranscriptsRepo.sweepPending) removes what is still pending after
// Constants.EVAL_TRANSCRIPT_PENDING_MAX_AGE_MS. remove deletes only rows still pending (the delete itself re-checks it,
// so a row attached since it was read is kept), and the Repo deletes the objects of the rows it removed only: neither
// ever removes a transcript a result points at. Returns { isSuccess, message } and never throws.
export default class EvalTranscriptFilesProvider {
  private static filesDal = new FilesDAL();

  static async createPending(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      file: Pick<Schemas.StoredFile, "publicId" | "sizeBytes" | "sha256">;
    },
  ): Promise<Schemas.FileDALResponse> {
    return await EvalTranscriptFilesProvider.filesDal.createFile(tx, {
      ...params.file,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.EvalResult,
      ownerId: Schemas.FILE_PENDING_OWNER_ID,
      filename: null,
      mime: Schemas.EVAL_TRANSCRIPT_MIME,
      createdBy: null,
    });
  }

  static async attach(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; fileId: string; evalResultId: string },
  ): Promise<Schemas.FileDALResponse> {
    return await EvalTranscriptFilesProvider.filesDal.setFileOwner(tx, {
      id: params.fileId,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.EvalResult,
      ownerId: params.evalResultId,
    });
  }

  static async remove(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; fileIds: string[] },
  ): Promise<Schemas.FilesDALResponse> {
    return await EvalTranscriptFilesProvider.filesDal.deleteFiles(tx, {
      companyId: params.companyId,
      ids: params.fileIds,
      pendingOwnerType: Schemas.FileOwnerTypeEnum.EvalResult,
    });
  }
}
