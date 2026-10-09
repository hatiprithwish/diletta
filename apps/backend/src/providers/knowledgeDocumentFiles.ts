import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import FilesDAL from "@/data-access-layer/FilesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import FileStorageProvider from "@/providers/fileStorage";

// DEV_NOTE: A file row is created before its document because knowledge_documents.file_id is NOT NULL, then pointed at
// the document in the same transaction. No DB foreign keys, so nothing outside the transaction ever sees this.
const PENDING_OWNER_ID = "0";

// DEV_NOTE: A knowledge document together with its file row and R2 object, shared by KnowledgeSourcesRepo (uploads,
// deletes) and KnowledgeIngestionRepo (sync, prune). Takes the Repo's withTenant tx, never opens one or builds a query
// itself (provider → DAL). The R2 object is written inside the transaction, before the commit; when the transaction
// then rolls back, the Repo deletes the object it wrote (fileR2Key). Objects of removed files are deleted by the Repo
// after the commit, so a failed delete leaves an object with no row, never a row with no object.
// Returns { isSuccess, message } and never throws.
export default class KnowledgeDocumentFilesProvider {
  private static filesDal = new FilesDAL();
  private static documentsDal = new KnowledgeDocumentsDAL();
  private static chunksDal = new KnowledgeChunksDAL();

  static async create(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      companyPublicId: string;
      knowledgeSourceId: string;
      bytes: Uint8Array<ArrayBuffer>;
      mime: string;
      sha256: string;
      filename: string | null;
      createdBy: string | null;
      document: Pick<
        Schemas.KnowledgeDocument,
        "title" | "sourceUrl" | "contentHash" | "indexStatus" | "lastSyncedAt"
      >;
    },
  ): Promise<Schemas.CreateKnowledgeDocumentWithFileResponse> {
    const file = await this.filesDal.createFile(tx, {
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: PENDING_OWNER_ID,
      filename: params.filename,
      mime: params.mime,
      sizeBytes: params.bytes.byteLength,
      sha256: params.sha256,
      createdBy: params.createdBy,
    });
    if (!file.isSuccess || !file.file) {
      return { isSuccess: false, message: file.message };
    }

    const fileR2Key = Schemas.fileR2Key(params.companyPublicId, file.file.publicId);
    const stored = await FileStorageProvider.putObject(env, {
      key: fileR2Key,
      bytes: params.bytes,
      mime: params.mime,
    });
    if (!stored.isSuccess) {
      return { isSuccess: false, message: stored.message };
    }

    const document = await this.documentsDal.createKnowledgeDocument(tx, {
      companyId: params.companyId,
      knowledgeSourceId: params.knowledgeSourceId,
      fileId: file.file.id,
      ...params.document,
    });
    if (!document.isSuccess || !document.knowledgeDocument) {
      return { isSuccess: false, message: document.message, fileR2Key };
    }

    const owned = await this.filesDal.setFileOwner(tx, {
      id: file.file.id,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: document.knowledgeDocument.id,
    });
    if (!owned.isSuccess) {
      return { isSuccess: false, message: owned.message, fileR2Key };
    }

    return {
      isSuccess: true,
      message: "Knowledge document created successfully",
      knowledgeDocument: document.knowledgeDocument,
      fileR2Key,
    };
  }

  // DEV_NOTE: New bytes for an existing document (a re-synced page that changed): the file row and the object at the
  // same key. On a rollback the object keeps the new bytes while the row keeps the old sha256; the next sync fetches
  // the page again and rewrites both.
  static async replaceContent(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      companyPublicId: string;
      fileId: string;
      bytes: Uint8Array<ArrayBuffer>;
      mime: string;
      sha256: string;
    },
  ): Promise<Schemas.ApiResponse> {
    const file = await this.filesDal.updateFileContent(tx, {
      id: params.fileId,
      companyId: params.companyId,
      mime: params.mime,
      sizeBytes: params.bytes.byteLength,
      sha256: params.sha256,
    });
    if (!file.isSuccess || !file.file) {
      return { isSuccess: false, message: file.message };
    }

    return await FileStorageProvider.putObject(env, {
      key: Schemas.fileR2Key(params.companyPublicId, file.file.publicId),
      bytes: params.bytes,
      mime: params.mime,
    });
  }

  // DEV_NOTE: Deletes the documents' chunks, the documents and their file rows; returns the R2 keys to delete after
  // the commit
  static async remove(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      companyPublicId: string;
      documents: Schemas.KnowledgeDocument[];
    },
  ): Promise<Schemas.RemoveKnowledgeDocumentsResponse> {
    if (params.documents.length === 0) {
      return {
        isSuccess: true,
        message: "No knowledge documents to remove",
        deletedCount: 0,
        fileR2Keys: [],
      };
    }

    const documentIds = params.documents.map((document) => document.id);
    const chunks = await this.chunksDal.deleteKnowledgeChunksByDocuments(tx, {
      companyId: params.companyId,
      knowledgeDocumentIds: documentIds,
    });
    if (!chunks.isSuccess) {
      return { isSuccess: false, message: chunks.message };
    }

    const documents = await this.documentsDal.deleteKnowledgeDocuments(tx, {
      companyId: params.companyId,
      ids: documentIds,
    });
    if (!documents.isSuccess || !documents.knowledgeDocuments) {
      return { isSuccess: false, message: documents.message };
    }

    const files = await this.filesDal.deleteFiles(tx, {
      companyId: params.companyId,
      ids: documents.knowledgeDocuments.map((document) => document.fileId),
    });
    if (!files.isSuccess || !files.files) {
      return { isSuccess: false, message: files.message };
    }

    return {
      isSuccess: true,
      message: "Knowledge documents removed successfully",
      deletedCount: documents.knowledgeDocuments.length,
      fileR2Keys: files.files.map((file) =>
        Schemas.fileR2Key(params.companyPublicId, file.publicId),
      ),
    };
  }
}
